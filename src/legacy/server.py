#!/usr/bin/env python3
"""
HeykPrint Hub - Universal Multi-Printer Management & Web Dashboard
Hardened production server:
- Strictly parameter-driven subprocess execution (no shell=True injection vulnerabilities)
- Event-driven zero-delay udev hotplug integration
- Multi-printer architecture with full ChromeOS and AirPrint mDNS publishing
- Non-blocking, thread-safe synchronization
"""

import os
import sys
import re
import json
import time
import socket
import ssl
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

import printer_manager

PORT = 80
HTTPS_PORT = 443
FALLBACK_PORT = 8080

def get_ip_address():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("1.1.1.1", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "192.168.1.114"

def get_cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            return round(int(f.read().strip()) / 1000.0, 1)
    except Exception:
        return None

def get_uptime():
    try:
        with open("/proc/uptime", "r") as f:
            seconds = float(f.readline().split()[0])
            days = int(seconds // 86400)
            hours = int((seconds % 86400) // 3600)
            minutes = int((seconds % 3600) // 60)
            parts = []
            if days > 0:
                parts.append(f"{days}h")
            if hours > 0:
                parts.append(f"{hours}j")
            parts.append(f"{minutes}m")
            return " ".join(parts) or "< 1m"
    except Exception:
        return "N/A"

def get_ram_info():
    try:
        with open("/proc/meminfo", "r") as f:
            mem = {}
            for line in f:
                parts = line.split(":")
                if len(parts) == 2:
                    mem[parts[0].strip()] = int(parts[1].split()[0])
            total = mem.get("MemTotal", 1)
            avail = mem.get("MemAvailable", 0)
            used = total - avail
            return {
                "total_mb": round(total / 1024),
                "used_mb": round(used / 1024),
                "percent": round((used / total) * 100, 1)
            }
    except Exception:
        return {"total_mb": 0, "used_mb": 0, "percent": 0}

def get_cups_jobs():
    code, stdout, _ = printer_manager.exec_cmd(["lpstat", "-o"], timeout=5)
    jobs = []
    if code == 0 and stdout:
        for line in stdout.splitlines():
            line = line.strip()
            if line:
                parts = line.split()
                if len(parts) >= 4:
                    jobs.append({
                        "id": parts[0],
                        "user": parts[1],
                        "size": parts[2],
                        "date": " ".join(parts[3:])
                    })
    return jobs

_status_cache_time = 0
_status_cache_data = None
_status_lock = threading.Lock()

class HeykPrintHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress verbose HTTP access logging to preserve zram
        pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ["/", "/index.html"]:
            self.serve_html()
        elif path == "/api/status":
            self.serve_api_status()
        elif path == "/api/scan":
            self.serve_api_scan()
        else:
            self.send_json({"success": False, "message": "Endpoint not found."}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        content_length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b""

        if content_length > 0 and post_data:
            try:
                body = json.loads(post_data.decode("utf-8"))
                if not isinstance(body, dict):
                    self.send_json({"success": False, "message": "Invalid JSON: root must be an object."}, status=400)
                    return
            except Exception as e:
                self.send_json({"success": False, "message": f"Malformed JSON: {str(e)}"}, status=400)
                return
        else:
            body = {}

        if path == "/api/printer/test-page":
            target = body.get("printer")
            if not target:
                self.send_json({"success": False, "message": "Field 'printer' is required."}, status=400)
                return
            if not isinstance(target, str):
                self.send_json({"success": False, "message": "Field 'printer' must be a string."}, status=400)
                return
            if not re.match(r'^[a-zA-Z0-9_-]+$', target):
                self.send_json({"success": False, "message": "Invalid printer queue name. Only alphanumeric, dashes, and underscores allowed."}, status=400)
                return
            success, msg = printer_manager.print_test_page(target)
            self.send_json({
                "success": success,
                "message": msg
            }, status=200 if success else 400)
        elif path == "/api/printer/cancel-jobs":
            success, msg = printer_manager.cancel_all_jobs()
            self.send_json({
                "success": success,
                "message": "Semua antrean cetak telah dibatalkan." if success else f"Gagal membatalkan: {msg}"
            }, status=200 if success else 500)
        elif path == "/api/service/restart":
            svc = body.get("service")
            if not svc:
                self.send_json({"success": False, "message": "Field 'service' is required."}, status=400)
                return
            if svc in ["cups", "avahi-daemon"]:
                code, _, err = printer_manager.exec_cmd(["systemctl", "restart", svc])
                success = (code == 0)
                self.send_json({
                    "success": success,
                    "message": f"Layanan {svc} berhasil direstart." if success else f"Gagal me-restart: {err}"
                }, status=200 if success else 500)
            else:
                self.send_json({"success": False, "message": f"Layanan tidak dikenal: '{svc}'."}, status=400)
        elif path == "/api/scan":
            self.serve_api_scan()
        else:
            self.send_json({"success": False, "message": "Endpoint not found."}, status=404)

    def send_json(self, data, status=200):
        try:
            content = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_html(self):
        try:
            html_path = "/opt/heykprint/templates/index.html"
            if os.path.exists(html_path):
                with open(html_path, "rb") as f:
                    content = f.read()
            else:
                content = b"<h1>HeykPrint Server Running</h1>"

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_api_scan(self):
        active = printer_manager.sync_all_printers()
        self.send_json({
            "success": True,
            "provisioned": len(active) > 0,
            "active_queues": active,
            "queue_name": active[0] if active else None
        })

    def serve_api_status(self):
        global _status_cache_time, _status_cache_data
        with _status_lock:
            now = time.time()
            if _status_cache_data and (now - _status_cache_time < 2.0):
                self.send_json(_status_cache_data)
                return

            ip = get_ip_address()
            temp = get_cpu_temp()
            uptime = get_uptime()
            ram = get_ram_info()
            load = os.getloadavg() if hasattr(os, "getloadavg") else [0, 0, 0]

            code_cups, cups_status, _ = printer_manager.exec_cmd(["systemctl", "is-active", "cups"], timeout=2)
            code_avahi, avahi_status, _ = printer_manager.exec_cmd(["systemctl", "is-active", "avahi-daemon"], timeout=2)

            hw_list = printer_manager.probe_hardware_printers()
            cups_printers_map, default_p = printer_manager.get_cups_printers()
            jobs = get_cups_jobs()

            cups_printers_list = []
            for name, p_data in cups_printers_map.items():
                cups_printers_list.append({
                    "name": name,
                    "state": p_data.get("state", "idle"),
                    "status_text": f"printer {name} is {p_data.get('state', 'idle')}",
                    "uri": p_data.get("uri", ""),
                    "is_default": p_data.get("is_default", False)
                })

            # Primary printer object for frontend backward compatibility
            if hw_list:
                primary_hw = hw_list[0]
                active_q = primary_hw["queue_name"] if primary_hw["queue_name"] in cups_printers_map else (default_p or (cups_printers_list[0]["name"] if cups_printers_list else primary_hw["queue_name"]))
                printer_info = {
                    "connected": True,
                    "vendor": primary_hw["vendor"],
                    "model": primary_hw["model"],
                    "display_name": primary_hw["display_name"],
                    "uri": primary_hw["uri"],
                    "is_configured": len(cups_printers_list) > 0,
                    "queue_name": active_q,
                    "ipp_url": f"ipp://{ip}:631/printers/{active_q}" if active_q else None,
                    "cups_url": f"http://{ip}:631/printers/{active_q}" if active_q else None,
                    "mdns_url": f"ipp://heykprint.local:631/printers/{active_q}" if active_q else None,
                    "jobs": jobs
                }
            elif cups_printers_list:
                active_q = default_p or cups_printers_list[0]["name"]
                printer_info = {
                    "connected": True,
                    "vendor": active_q.split("_")[0],
                    "model": active_q.replace("_", " "),
                    "display_name": active_q.replace("_", " "),
                    "uri": cups_printers_list[0].get("uri", ""),
                    "is_configured": True,
                    "queue_name": active_q,
                    "ipp_url": f"ipp://{ip}:631/printers/{active_q}",
                    "cups_url": f"http://{ip}:631/printers/{active_q}",
                    "mdns_url": f"ipp://heykprint.local:631/printers/{active_q}",
                    "jobs": jobs
                }
            else:
                printer_info = {
                    "connected": False,
                    "vendor": None,
                    "model": None,
                    "display_name": None,
                    "uri": None,
                    "is_configured": False,
                    "queue_name": None,
                    "ipp_url": None,
                    "cups_url": None,
                    "mdns_url": None,
                    "jobs": []
                }

            data = {
                "timestamp": int(time.time()),
                "system": {
                    "hostname": socket.gethostname(),
                    "ip": ip,
                    "mdns_host": "heykprint.local",
                    "uptime": uptime,
                    "cpu_temp": temp,
                    "load": [round(x, 2) for x in load],
                    "ram": ram
                },
                "services": {
                    "cups": cups_status.strip() == "active",
                    "avahi": avahi_status.strip() == "active"
                },
                "printer": printer_info,
                "printers_connected": hw_list,
                "cups_printers": cups_printers_list
            }
            _status_cache_time = time.time()
            _status_cache_data = data
            self.send_json(data)

def run_http(port=80):
    try:
        httpd = ThreadingHTTPServer(("0.0.0.0", port), HeykPrintHandler)
        print(f"[*] HeykPrint HTTP running on port {port}")
        httpd.serve_forever()
    except PermissionError:
        print(f"[!] Port {port} permission denied, fallback to {FALLBACK_PORT}")
        httpd = ThreadingHTTPServer(("0.0.0.0", FALLBACK_PORT), HeykPrintHandler)
        httpd.serve_forever()
    except Exception as e:
        print(f"[!] HTTP Error: {e}")

def run_https(port=443):
    cert_file = "/etc/ssl/heykprint/server.crt"
    key_file = "/etc/ssl/heykprint/server.key"
    if not (os.path.exists(cert_file) and os.path.exists(key_file)):
        return
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert_file, keyfile=key_file)
        httpsd = ThreadingHTTPServer(("0.0.0.0", port), HeykPrintHandler)
        httpsd.socket = context.wrap_socket(httpsd.socket, server_side=True)
        print(f"[*] HeykPrint HTTPS running on port {port}")
        httpsd.serve_forever()
    except Exception as e:
        print(f"[!] HTTPS Server Error: {e}")

def run():
    # Perform initial sync on startup
    try:
        printer_manager.sync_all_printers()
    except Exception as e:
        print(f"[!] Initial printer sync error: {e}")

    t_https = threading.Thread(target=run_https, args=(HTTPS_PORT,), daemon=True)
    t_https.start()
    run_http(PORT)

if __name__ == "__main__":
    run()

#!/usr/bin/env python3
"""
HeykPrint Server End-to-End Reliability, Concurrency, and Hardware Matrix QA Suite
Host: 192.168.1.114
"""

import os
import sys
import time
import json
import requests
import subprocess
import concurrent.futures

BASE_URL = os.environ.get("MANTAPRINT_BASE_URL", "http://192.168.1.114")
SSH_PASSWORD = os.environ.get("SSH_PASSWORD", "<YOUR_ROOT_PASSWORD>")
SSH_CMD = ["sshpass", "-p", SSH_PASSWORD, "ssh", "-o", "StrictHostKeyChecking=no", "root@192.168.1.114"]

def run_remote(cmd):
    res = subprocess.run(SSH_CMD + [cmd], capture_output=True, text=True, timeout=30)
    return res.returncode, res.stdout.strip(), res.stderr.strip()

def test_input_robustness():
    print("=" * 70)
    print("TASK 1: INPUT ROBUSTNESS & ERROR HANDLING QA")
    print("=" * 70)
    test_cases = [
        ("POST", "/api/printer/test-page", {"printer": "non_existent_queue_xyz"}, 400, "Non-existent printer queue"),
        ("POST", "/api/printer/test-page", {}, 400, "Empty JSON payload"),
        ("POST", "/api/printer/test-page", {"printer": "queue;rm -rf /"}, 400, "Shell injection characters in printer name"),
        ("POST", "/api/printer/test-page", {"printer": "../../etc/shadow"}, 400, "Directory traversal characters"),
        ("POST", "/api/printer/test-page", {"printer": "!@#$%^&*()"}, 400, "Special symbols in printer name"),
        ("POST", "/api/printer/test-page", {"printer": 98765}, 400, "Integer type for printer parameter"),
        ("POST_RAW", "/api/printer/test-page", "{ malformed_json: ", 400, "Malformed JSON syntax in test-page"),
        ("POST", "/api/service/restart", {"service": "invalid"}, 400, "Unknown service name ('invalid')"),
        ("POST", "/api/service/restart", {"service": "cups; reboot"}, 400, "Command injection in service name"),
        ("POST", "/api/service/restart", {}, 400, "Missing service field in payload"),
        ("POST", "/api/service/restart", {"service": "apache2"}, 400, "Unsupported service name ('apache2')"),
        ("POST_RAW", "/api/service/restart", "NOT_JSON_DATA", 400, "Malformed raw text payload in service restart"),
        ("GET", "/api/non_existent_endpoint", None, 404, "Non-existent GET endpoint"),
        ("POST", "/api/non_existent_endpoint", {}, 404, "Non-existent POST endpoint"),
    ]

    results = []
    all_passed = True
    for method, path, payload, expected_status, desc in test_cases:
        url = BASE_URL + path
        try:
            if method == "GET":
                r = requests.get(url, timeout=5)
            elif method == "POST":
                r = requests.post(url, json=payload, timeout=5)
            elif method == "POST_RAW":
                r = requests.post(url, data=payload, headers={"Content-Type": "application/json"}, timeout=5)

            is_json = False
            try:
                body = r.json()
                is_json = True
            except Exception:
                body = r.text

            passed = (r.status_code == expected_status) and is_json and (body.get("success") is False)
            if not passed:
                all_passed = False
            results.append({
                "test": desc,
                "endpoint": path,
                "status_code": r.status_code,
                "expected_status": expected_status,
                "is_json": is_json,
                "response": body,
                "verdict": "PASS" if passed else "FAIL"
            })
            print(f"[{'PASS' if passed else 'FAIL'}] ({r.status_code}) {desc:42} -> {body}")
        except Exception as e:
            all_passed = False
            results.append({
                "test": desc,
                "endpoint": path,
                "status_code": 0,
                "expected_status": expected_status,
                "is_json": False,
                "response": str(e),
                "verdict": "FAIL"
            })
            print(f"[FAIL] (ERR) {desc:42} -> Exception: {e}")

    print(f"\nTask 1 Verdict: {'PASS' if all_passed else 'FAIL'}\n")
    return all_passed, results

def test_concurrency():
    print("=" * 70)
    print("TASK 2: CONCURRENCY & THREAD SAFETY QA (50 CONCURRENT REQUESTS)")
    print("=" * 70)

    def run_batch(name, url, method="GET", count=50):
        print(f"Executing {count} concurrent {method} requests against {name}...")
        latencies = []
        codes = []
        valid_json = 0
        errors = []

        def worker(_):
            t0 = time.perf_counter()
            try:
                if method == "GET":
                    r = requests.get(url, timeout=10)
                else:
                    r = requests.post(url, timeout=10)
                lat = time.perf_counter() - t0
                data = r.json()
                ok = isinstance(data, dict) and ("success" in data or "system" in data)
                return r.status_code, lat, ok, None
            except Exception as e:
                lat = time.perf_counter() - t0
                return None, lat, False, str(e)

        wall_t0 = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
            futures = [pool.submit(worker, i) for i in range(count)]
            for f in concurrent.futures.as_completed(futures):
                code, lat, is_ok, err = f.result()
                latencies.append(lat)
                if code is not None:
                    codes.append(code)
                if is_ok:
                    valid_json += 1
                if err:
                    errors.append(err)
        wall_time = time.perf_counter() - wall_t0

        p200 = sum(1 for c in codes if c == 200)
        avg_lat = (sum(latencies) / len(latencies)) * 1000 if latencies else 0
        min_lat = min(latencies) * 1000 if latencies else 0
        max_lat = max(latencies) * 1000 if latencies else 0
        passed = (p200 == count) and (valid_json == count) and (len(errors) == 0)

        print(f"  Wall Time: {wall_time:.2f}s | Avg: {avg_lat:.1f}ms | Min: {min_lat:.1f}ms | Max: {max_lat:.1f}ms")
        print(f"  HTTP 200: {p200}/{count} | Valid JSON: {valid_json}/{count} | Errors: {len(errors)}")
        print(f"  Batch Verdict: {'PASS' if passed else 'FAIL'}")
        return passed, {
            "endpoint": name,
            "count": count,
            "wall_time_s": round(wall_time, 2),
            "avg_latency_ms": round(avg_lat, 1),
            "min_latency_ms": round(min_lat, 1),
            "max_latency_ms": round(max_lat, 1),
            "http_200_count": p200,
            "valid_json_count": valid_json,
            "errors": len(errors),
            "verdict": "PASS" if passed else "FAIL"
        }

    pass1, res1 = run_batch("GET /api/status", BASE_URL + "/api/status", "GET", 50)
    time.sleep(1)
    pass2, res2 = run_batch("POST /api/scan", BASE_URL + "/api/scan", "POST", 50)
    time.sleep(1)

    print("Executing 50 concurrent interleaved requests (25x /api/status + 25x /api/scan)...")
    interleaved_tasks = [("GET", BASE_URL + "/api/status")] * 25 + [("POST", BASE_URL + "/api/scan")] * 25
    i_latencies = []
    i_codes = []
    i_valid_json = 0
    i_errors = []

    def i_worker(task):
        m, u = task
        t0 = time.perf_counter()
        try:
            if m == "GET":
                r = requests.get(u, timeout=10)
            else:
                r = requests.post(u, timeout=10)
            lat = time.perf_counter() - t0
            data = r.json()
            ok = isinstance(data, dict)
            return r.status_code, lat, ok, None
        except Exception as e:
            lat = time.perf_counter() - t0
            return None, lat, False, str(e)

    i_wall_t0 = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=50) as pool:
        futures = [pool.submit(i_worker, t) for t in interleaved_tasks]
        for f in concurrent.futures.as_completed(futures):
            code, lat, is_ok, err = f.result()
            i_latencies.append(lat)
            if code is not None:
                i_codes.append(code)
            if is_ok:
                i_valid_json += 1
            if err:
                i_errors.append(err)
    i_wall_time = time.perf_counter() - i_wall_t0

    i_p200 = sum(1 for c in i_codes if c == 200)
    i_avg_lat = (sum(i_latencies) / len(i_latencies)) * 1000 if i_latencies else 0
    i_min_lat = min(i_latencies) * 1000 if i_latencies else 0
    i_max_lat = max(i_latencies) * 1000 if i_latencies else 0
    pass3 = (i_p200 == 50) and (i_valid_json == 50) and (len(i_errors) == 0)

    print(f"  Interleaved Wall Time: {i_wall_time:.2f}s | Avg: {i_avg_lat:.1f}ms")
    print(f"  HTTP 200: {i_p200}/50 | Valid JSON: {i_valid_json}/50 | Errors: {len(i_errors)}")
    print(f"  Interleaved Verdict: {'PASS' if pass3 else 'FAIL'}")

    res3 = {
        "endpoint": "Interleaved 25x Status + 25x Scan",
        "count": 50,
        "wall_time_s": round(i_wall_time, 2),
        "avg_latency_ms": round(i_avg_lat, 1),
        "min_latency_ms": round(i_min_lat, 1),
        "max_latency_ms": round(i_max_lat, 1),
        "http_200_count": i_p200,
        "valid_json_count": i_valid_json,
        "errors": len(i_errors),
        "verdict": "PASS" if pass3 else "FAIL"
    }

    all_passed = pass1 and pass2 and pass3
    print(f"\nTask 2 Verdict: {'PASS' if all_passed else 'FAIL'}\n")
    return all_passed, [res1, res2, res3]

def test_event_burst():
    print("=" * 70)
    print("TASK 3: RAPID EVENT BURST SIMULATION QA (UDEV BURST)")
    print("=" * 70)

    # Trigger 5 udev events rapidly via SSH
    remote_script = """
    for i in {1..5}; do
        udevadm trigger --action=add --subsystem-match=usb
        echo "Event $i triggered at $(date +%T.%N)"
    done
    sleep 4
    echo "--- CHECK AVAHI ---"
    ls -1 /etc/avahi/services/heykprint*.service
    echo "--- CHECK CUPS ---"
    lpstat -p -d -v
    echo "--- CHECK SERVICE STATUS ---"
    systemctl is-active heykprint-hotplug.service cups avahi-daemon
    """
    code, stdout, stderr = run_remote(remote_script)
    print("Remote execution output:")
    print(stdout)

    # Verification criteria
    avahi_files = [line.strip() for line in stdout.splitlines() if "/etc/avahi/services/heykprint" in line]
    has_cups_idle = "is idle" in stdout
    has_canon_queue = "Canon_G3030_series" in stdout
    no_duplicate_avahi = len(avahi_files) == 1

    passed = (code == 0) and has_cups_idle and has_canon_queue and no_duplicate_avahi
    print(f"\nEvent Burst Verification:")
    print(f"  Unique Avahi Service Files: {len(avahi_files)} (Expected: 1) -> {'PASS' if no_duplicate_avahi else 'FAIL'}")
    print(f"  CUPS Queue State: Canon_G3030_series idle -> {'PASS' if (has_cups_idle and has_canon_queue) else 'FAIL'}")
    print(f"  Task 3 Verdict: {'PASS' if passed else 'FAIL'}\n")
    return passed, {
        "avahi_service_files_count": len(avahi_files),
        "cups_queue_intact": has_cups_idle and has_canon_queue,
        "verdict": "PASS" if passed else "FAIL"
    }

def test_driver_engine():
    print("=" * 70)
    print("TASK 4: DRIVERENGINE HARDWARE COMPATIBILITY MATRIX (23 MODELS)")
    print("=" * 70)

    remote_test_script = """python3 -c "
import sys, json
sys.path.insert(0, '/opt/heykprint')
from printer_manager import get_driver_engine

eng = get_driver_engine()

models = [
    ('Canon', 'G3030', '', '', 'Inkjet (Canon G-series)', 'bjc-G3000-series'),
    ('Canon', 'G3010', '', '', 'Inkjet (Canon G-series)', 'bjc-PIXMA-G3010'),
    ('Canon', 'G2000', '', '', 'Inkjet (Canon G-series)', 'bjc-G2000-series'),
    ('Canon', 'LBP 2900', '', '', 'CAPT Laser (Canon LBP)', 'CanonLBP-2900-3000'),
    ('Canon', 'LBP 3000', '', '', 'CAPT Laser (Canon LBP)', 'CanonLBP-2900-3000'),
    ('Canon', 'LBP 6030', '', '', 'CAPT Laser (Canon LBP)', 'CanonLBP-6000-6018'),
    ('Epson', 'L3110', '', '', 'EcoTank ESC/P-R', 'Epson-L3110_Series'),
    ('Epson', 'L3250', '', '', 'EcoTank ESC/P-R', 'Epson-L3250_Series'),
    ('Epson', 'L120', '', '', 'EcoTank ESC/P-R', 'escp2-l120'),
    ('Epson', 'LX-300', 'ESCP', '', 'Dot Matrix (ESC/P 9-pin)', 'epson9'),
    ('Epson', 'LX-310', 'ESCP', '', 'Dot Matrix (ESC/P 9-pin)', 'epson9'),
    ('Epson', 'TM-T82', '', '', 'Thermal POS Raw', 'raw'),
    ('Epson', 'TM-T82X', '', '', 'Thermal POS Raw', 'raw'),
    ('Brother', 'HL-1200', '', '', 'brlaser Laser', 'brlaser.drv/br1200'),
    ('Brother', 'DCP-1510', '', '', 'brlaser Laser', 'brlaser.drv/br1510'),
    ('Brother', 'DCP-1610W', '', '', 'brlaser Laser', 'brlaser.drv/br1610'),
    ('HP', 'LaserJet P1102', '', '', 'foo2zjs / PCL Laser', 'HP-LaserJet_Pro_P1102'),
    ('HP', 'LaserJet 1020', '', '', 'foo2zjs / PCL Laser', 'HP-LaserJet_1020'),
    ('HP', 'LaserJet M1132', '', '', 'foo2zjs / PCL Laser', 'HP-LaserJet_Pro_M1132s_MFP'),
    ('HP', 'DeskJet 2130', '', '', 'hpijs Inkjet', 'hp-deskjet_2130_series-hpijs'),
    ('HP', 'Ink Tank 115', '', '', 'hpijs Inkjet', 'hp-ink_tank_110_series-hpijs'),
    ('Zebra', 'ZD230', '', '', 'ZPL / EPL Label', 'zebraep2'),
    ('Zebra', 'GK420t', '', '', 'ZPL / EPL Label', 'zebraep2')
]

results = []
all_ok = True
for mfg, mdl, cmd, des, category, needle in models:
    uri, desc = eng.match_driver(mfg, mdl, cmd, des)
    ok = needle.lower() in uri.lower()
    if not ok:
        all_ok = False
    results.append({
        'vendor': mfg,
        'model': mdl,
        'category': category,
        'assigned_uri': uri,
        'desc': desc,
        'expected_needle': needle,
        'passed': ok
    })

print(json.dumps({'all_ok': all_ok, 'results': results}))
" """
    code, stdout, stderr = run_remote(remote_test_script)
    try:
        data = json.loads(stdout)
        all_ok = data.get("all_ok", False)
        matrix_results = data.get("results", [])
        for r in matrix_results:
            st = "PASS" if r["passed"] else "FAIL"
            print(f"[{st}] {r['vendor']} {r['model']:17} -> {r['assigned_uri']}")
            print(f"       Category: {r['category']:24} | Desc: {r['desc']}")
        print(f"\nTask 4 Verdict: {'PASS' if all_ok else 'FAIL'}\n")
        return all_ok, matrix_results
    except Exception as e:
        print(f"[FAIL] Error parsing matrix results: {e}. Output: {stdout}")
        return False, []

def test_system_telemetry():
    print("=" * 70)
    print("TASK 5: SYSTEM TELEMETRY & RESOURCE INTEGRITY")
    print("=" * 70)

    cmd = """python3 -c "
import os, json, subprocess

def get_df():
    res = subprocess.run(['df', '-k', '/var/log'], capture_output=True, text=True)
    lines = res.stdout.strip().splitlines()
    parts = lines[1].split()
    return {
        'filesystem': parts[0],
        'total_kb': int(parts[1]),
        'used_kb': int(parts[2]),
        'avail_kb': int(parts[3]),
        'use_percent': float(parts[4].replace('%', ''))
    }

def get_cpu_mem():
    with open('/proc/loadavg') as f:
        loads = [float(x) for x in f.read().split()[:3]]
    mem = {}
    with open('/proc/meminfo') as f:
        for line in f:
            if ':' in line:
                k, v = line.split(':', 1)
                mem[k.strip()] = int(v.split()[0])
    total = mem.get('MemTotal', 1)
    avail = mem.get('MemAvailable', 0)
    used = total - avail
    return {
        'loadavg': loads,
        'mem_total_mb': round(total / 1024, 1),
        'mem_used_mb': round(used / 1024, 1),
        'mem_avail_mb': round(avail / 1024, 1),
        'mem_used_percent': round((used / total) * 100, 1)
    }

print(json.dumps({'zram': get_df(), 'sys': get_cpu_mem()}))
" """
    code, stdout, stderr = run_remote(cmd)
    data = json.loads(stdout)
    zram = data["zram"]
    sys_metrics = data["sys"]

    zram_under_5 = zram["use_percent"] <= 5.0
    print(f"  /var/log Mount: {zram['filesystem']}")
    print(f"  ZRAM Usage: {zram['used_kb']} KB / {zram['total_kb']} KB ({zram['use_percent']}%) -> {'PASS (<= 5%)' if zram_under_5 else 'FAIL (> 5%)'}")
    print(f"  CPU 1-min Load: {sys_metrics['loadavg'][0]} | 5-min: {sys_metrics['loadavg'][1]} | 15-min: {sys_metrics['loadavg'][2]}")
    print(f"  RAM: {sys_metrics['mem_used_mb']} MB used / {sys_metrics['mem_total_mb']} MB total ({sys_metrics['mem_used_percent']}%)")
    print(f"  Available RAM: {sys_metrics['mem_avail_mb']} MB")

    passed = zram_under_5
    print(f"\nTask 5 Verdict: {'PASS' if passed else 'FAIL'}\n")
    return passed, {"zram": zram, "system": sys_metrics, "verdict": "PASS" if passed else "FAIL"}

if __name__ == "__main__":
    t1_pass, t1_data = test_input_robustness()
    t2_pass, t2_data = test_concurrency()
    t3_pass, t3_data = test_event_burst()
    t4_pass, t4_data = test_driver_engine()
    t5_pass, t5_data = test_system_telemetry()

    summary = {
        "Task_1_Input_Robustness": "PASS" if t1_pass else "FAIL",
        "Task_2_Concurrency": "PASS" if t2_pass else "FAIL",
        "Task_3_Event_Burst": "PASS" if t3_pass else "FAIL",
        "Task_4_Driver_Matrix": "PASS" if t4_pass else "FAIL",
        "Task_5_Telemetry": "PASS" if t5_pass else "FAIL",
        "Overall_Verdict": "PASS" if (t1_pass and t2_pass and t3_pass and t4_pass and t5_pass) else "FAIL"
    }

    print("=" * 70)
    print("FINAL QA SUITE SUMMARY")
    print("=" * 70)
    for k, v in summary.items():
        print(f"  {k:30}: {v}")
    print("=" * 70)

    # Save empirical results to JSON
    with open("qa_results.json", "w") as f:
        json.dump({
            "timestamp": time.time(),
            "summary": summary,
            "t1_details": t1_data,
            "t2_details": t2_data,
            "t3_details": t3_data,
            "t4_details": t4_data,
            "t5_details": t5_data
        }, f, indent=2)

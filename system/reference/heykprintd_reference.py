#!/usr/bin/env python3
"""
HeykPrint Production Reference Daemon (heykprintd)
Target Platform: Armbian Linux (Amlogic S905X)
Key Characteristics:
  - Event-driven (Unix domain socket listener for udev events)
  - Zero polling loop
  - Multi-printer dynamic lifecycle management
  - IPP Everywhere & AirPrint compliant mDNS publication (Avahi D-Bus)
  - Memory-conscious, systemd watchdog & sd_notify integrated
"""

import os
import sys
import json
import time
import uuid
import socket
import select
import logging
import subprocess
from typing import Dict, Any, Optional

# Setup hardened logging directed to stdout/syslog (not raw files on zram)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [heykprintd] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("heykprintd")

SOCKET_PATH = "/run/heykprint/events.sock"
STATE_FILE = "/run/heykprint/state.json"
AVAHI_SERVICES_DIR = "/etc/avahi/services"

# In-memory multi-printer registry
connected_printers: Dict[str, Dict[str, Any]] = {}


def sd_notify(state: str):
    """Notify systemd of status/watchdog heartbeat if NOTIFY_SOCKET is set."""
    notify_socket = os.environ.get("NOTIFY_SOCKET")
    if not notify_socket:
        return
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        if notify_socket.startswith("@"):
            notify_socket = "\0" + notify_socket[1:]
        sock.connect(notify_socket)
        sock.sendall(state.encode("utf-8"))
        sock.close()
    except Exception as e:
        logger.debug(f"sd_notify failed: {e}")


def sanitize_queue_name(name: str) -> str:
    """Sanitize string to CUPS-compliant queue name (alphanumeric and underscore)."""
    clean = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in name)
    clean = clean.strip("_")
    return clean[:80] or "Printer"


def generate_deterministic_uuid(unique_key: str) -> str:
    """Generate persistent RFC 4122 UUIDv5 based on hardware key."""
    namespace = uuid.UUID("4d696e69-7072-4950-5031-001a11364f88")
    return str(uuid.uuid5(namespace, unique_key))


def extract_ieee1284_info(devpath: str) -> Dict[str, str]:
    """
    Extract IEEE 1284 device info from sysfs or lpinfo.
    Returns dictionary with MFG, MDL, CMD.
    """
    info = {"MFG": "Generic", "MDL": "Printer", "CMD": ""}
    # Inspect sysfs ieee1284_id if available
    try:
        # Traverse sysfs path looking for ieee1284_id
        sysfs_full = os.path.join("/sys", devpath.lstrip("/"))
        for root, _, files in os.walk(sysfs_full):
            if "ieee1284_id" in files:
                with open(os.path.join(root, "ieee1284_id"), "r", errors="ignore") as f:
                    content = f.read().strip()
                    parts = content.split(";")
                    for p in parts:
                        if ":" in p:
                            k, v = p.split(":", 1)
                            info[k.strip().upper()] = v.strip()
                break
    except Exception as e:
        logger.warning(f"Could not read sysfs ieee1284_id: {e}")
    return info


def generate_avahi_service_xml(queue_name: str, display_name: str, uuid_str: str, has_color: bool = True, has_duplex: bool = False) -> str:
    """
    Build AirPrint and ChromeOS compliant Avahi service XML.
    Includes mandatory URF raster parameters and RFC 4122 UUID.
    """
    duplex_mode = "DM3" if has_duplex else "DM1"
    color_flag = "T" if has_color else "F"
    duplex_flag = "T" if has_duplex else "F"

    # Strict AirPrint URF raster descriptor (NEVER 'none')
    urf_record = f"CP1,MT1-2-8-9-10-11,PQ3-4-5,RS300-600,SRGB24,W8,DEVW8,DEVRGB24,{duplex_mode}"

    xml = f"""<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">{display_name}</name>
  <service>
    <type>_ipp._tcp</type>
    <subtype>_universal._sub._ipp._tcp</subtype>
    <port>631</port>
    <txt-record>txtvers=1</txt-record>
    <txt-record>qtotal=1</txt-record>
    <txt-record>rp=printers/{queue_name}</txt-record>
    <txt-record>ty={display_name}</txt-record>
    <txt-record>adminurl=http://192.0.2.10:631/printers/{queue_name}</txt-record>
    <txt-record>note=HeykPrint Wireless Server</txt-record>
    <txt-record>pdl=application/pdf,image/pwg-raster,image/urf,application/octet-stream</txt-record>
    <txt-record>URF={urf_record}</txt-record>
    <txt-record>Color={color_flag}</txt-record>
    <txt-record>Duplex={duplex_flag}</txt-record>
    <txt-record>UUID={uuid_str}</txt-record>
    <txt-record>TLS=1.2</txt-record>
    <txt-record>air=none</txt-record>
    <txt-record>mopria-certified=1.3</txt-record>
    <txt-record>printer-state=3</txt-record>
    <txt-record>printer-type=0x801046</txt-record>
  </service>
</service-group>
"""
    return xml


def publish_avahi_service(queue_name: str, display_name: str, uuid_str: str, has_color: bool = True):
    """Write Avahi service configuration file."""
    filepath = os.path.join(AVAHI_SERVICES_DIR, f"HeykPrint_{queue_name}.service")
    xml_content = generate_avahi_service_xml(queue_name, display_name, uuid_str, has_color)
    try:
        with open(filepath, "w") as f:
            f.write(xml_content)
        logger.info(f"Published Avahi mDNS service: {filepath} with UUID {uuid_str}")
    except Exception as e:
        logger.error(f"Failed to write Avahi service file {filepath}: {e}")


def withdraw_avahi_service(queue_name: str):
    """Remove Avahi service configuration file."""
    filepath = os.path.join(AVAHI_SERVICES_DIR, f"HeykPrint_{queue_name}.service")
    if os.path.exists(filepath):
        try:
            os.remove(filepath)
            logger.info(f"Withdrawn Avahi mDNS service: {filepath}")
        except Exception as e:
            logger.error(f"Failed to remove Avahi service file {filepath}: {e}")


def handle_device_add(event_type: str, devname: str, devpath: str):
    """Handle hardware connection event."""
    logger.info(f"Processing ADD event: devname={devname}, devpath={devpath}, type={event_type}")

    info = extract_ieee1284_info(devpath)
    mfg = info.get("MFG", "Generic")
    mdl = info.get("MDL", "Printer")
    unique_key = f"{mfg}_{mdl}_{devpath}"
    device_uuid = generate_deterministic_uuid(unique_key)
    queue_name = sanitize_queue_name(f"{mfg}_{mdl}_{device_uuid[:6]}")
    display_name = f"{mfg} {mdl} (HeykPrint)"

    # Determine driverless or specific PPD
    # Step 1: Check if IPP-over-USB is available
    if event_type == "add-ippusb":
        logger.info(f"Device {queue_name} supports IPP-over-USB. Configuring via everywhere model.")
        # lpadmin -p <queue> -E -v ipp://localhost:60000/ipp/print -m everywhere
        device_uri = "ipp://localhost:60000/ipp/print"
        driver_cmd = ["lpadmin", "-p", queue_name, "-E", "-v", device_uri, "-m", "everywhere"]
    else:
        # Step 2: Classic USB printer
        device_uri = f"usb://{mfg}/{mdl}"  # Or specific CUPS USB URI
        # Match against gutenprint or standard driver
        driver_cmd = ["lpadmin", "-p", queue_name, "-E", "-v", device_uri, "-m", "raw"]

    logger.info(f"Provisioning CUPS queue: {queue_name} (URI: {device_uri})")
    # Subprocess execution for provisioning only occurs on connection (not in a loop!)
    try:
        res = subprocess.run(driver_cmd, capture_output=True, text=True, timeout=10)
        if res.returncode != 0:
            logger.warning(f"CUPS provisioning returned non-zero ({res.returncode}): {res.stderr}")
    except Exception as e:
        logger.error(f"Failed to execute lpadmin: {e}")

    # Register in memory
    connected_printers[queue_name] = {
        "devname": devname,
        "devpath": devpath,
        "uuid": device_uuid,
        "display_name": display_name,
        "connected_at": time.time(),
        "state": "idle"
    }

    # Publish Avahi mDNS with valid URF tokens and UUID
    publish_avahi_service(queue_name, display_name, device_uuid, has_color=True)
    save_state()


def handle_device_remove(event_type: str, devname: str, devpath: str):
    """Handle hardware disconnect event."""
    logger.info(f"Processing REMOVE event: devname={devname}, devpath={devpath}")
    matched_queue = None
    for qname, data in connected_printers.items():
        if data.get("devpath") == devpath or data.get("devname") == devname:
            matched_queue = qname
            break

    if matched_queue:
        logger.info(f"Retiring disconnected printer queue: {matched_queue}")
        # 1. Immediately withdraw Avahi mDNS to stop incoming jobs
        withdraw_avahi_service(matched_queue)

        # 2. Mark queue disabled in CUPS
        try:
            subprocess.run(["cupsdisable", "-r", "Printer physically disconnected", matched_queue],
                           capture_output=True, timeout=5)
        except Exception as e:
            logger.warning(f"Could not disable CUPS queue {matched_queue}: {e}")

        del connected_printers[matched_queue]
        save_state()
    else:
        logger.warning(f"No active queue matched disconnected devpath: {devpath}")


def save_state():
    """Atomically save active printer state table to tmpfs."""
    try:
        tmp_file = STATE_FILE + ".tmp"
        with open(tmp_file, "w") as f:
            json.dump({"printers": connected_printers, "updated_at": time.time()}, f, indent=2)
        os.replace(tmp_file, STATE_FILE)
    except Exception as e:
        logger.error(f"Failed to write state file {STATE_FILE}: {e}")


def run_daemon():
    """Main daemon loop running non-blocking socket listener and watchdog."""
    os.makedirs("/run/heykprint", exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        try:
            os.remove(SOCKET_PATH)
        except OSError:
            pass

    server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    server_sock.bind(SOCKET_PATH)
    server_sock.setblocking(False)
    os.chmod(SOCKET_PATH, 0o660)

    logger.info(f"HeykPrint daemon started. Listening on {SOCKET_PATH}")
    sd_notify("READY=1")

    last_watchdog = time.time()

    while True:
        # Pet systemd watchdog every 10 seconds
        now = time.time()
        if now - last_watchdog >= 10:
            sd_notify("WATCHDOG=1")
            last_watchdog = now

        # Select on socket with 2-second timeout
        rlist, _, _ = select.select([server_sock], [], [], 2.0)
        if server_sock in rlist:
            try:
                data, _ = server_sock.recvfrom(4096)
                msg = json.loads(data.decode("utf-8"))
                action = msg.get("action")
                devname = msg.get("devname", "")
                devpath = msg.get("devpath", "")

                if "add" in action:
                    handle_device_add(action, devname, devpath)
                elif "remove" in action:
                    handle_device_remove(action, devname, devpath)
            except Exception as e:
                logger.error(f"Error processing socket message: {e}")


if __name__ == "__main__":
    try:
        run_daemon()
    except KeyboardInterrupt:
        logger.info("HeykPrint daemon exiting.")
        sys.exit(0)

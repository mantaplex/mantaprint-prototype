#!/usr/bin/env python3
"""
HeykPrint Control & Hotplug Event Forwarder (heykprint-ctl)
Triggered by udev rules to forward events to the daemon via Unix Domain Socket.
Runs in <20ms and exits immediately.
"""

import sys
import json
import socket

SOCKET_PATH = "/run/heykprint/events.sock"

def main():
    if len(sys.argv) < 3:
        print("Usage: heykprint-ctl udev-event <action> <devname> <devpath>")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "udev-event":
        action = sys.argv[2]
        devname = sys.argv[3] if len(sys.argv) > 3 else ""
        devpath = sys.argv[4] if len(sys.argv) > 4 else ""

        payload = {
            "action": action,
            "devname": devname,
            "devpath": devpath
        }

        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            sock.sendto(json.dumps(payload).encode("utf-8"), SOCKET_PATH)
            sock.close()
        except Exception as e:
            # If daemon is temporarily down, log warning to stderr
            sys.stderr.write(f"heykprint-ctl: could not send event to {SOCKET_PATH}: {e}\n")
            sys.exit(0)

if __name__ == "__main__":
    main()

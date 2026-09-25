import os
import sys

tests = [
    ("deskew", ["/usr/bin/python3", "/opt/heykprint/image_processor.py", "deskew", "-i", "/mnt/data/scans/scan_1789811329950.jpg", "-o", "/tmp/out_deskew.png"]),
    ("enhance clean", ["/usr/bin/python3", "/opt/heykprint/image_processor.py", "enhance", "-i", "/mnt/data/scans/scan_1789811329950.jpg", "-o", "/tmp/out_clean.png", "--filter", "clean"]),
    ("enhance sauvola", ["/usr/bin/python3", "/opt/heykprint/image_processor.py", "enhance", "-i", "/mnt/data/scans/scan_1789811329950.jpg", "-o", "/tmp/out_sauvola.png", "--filter", "sauvola"]),
    ("ktp-2in1", ["/usr/bin/python3", "/opt/heykprint/image_processor.py", "ktp-2in1", "--front", "/mnt/data/scans/scan_1789811329950.jpg", "--back", "/mnt/data/scans/scan_1789811329950.jpg", "-o", "/tmp/out_ktp.pdf"]),
    ("merge pdf", ["/usr/bin/python3", "/opt/heykprint/image_processor.py", "merge", "-i", "/mnt/data/scans/scan_1789811329950.jpg", "/mnt/data/scans/test_150_gray.jpg", "-o", "/tmp/out_merge.pdf", "--format", "pdf"]),
    ("merge tiff", ["/usr/bin/python3", "/opt/heykprint/image_processor.py", "merge", "-i", "/mnt/data/scans/scan_1789811329950.jpg", "/mnt/data/scans/test_150_gray.jpg", "-o", "/tmp/out_merge.tiff", "--format", "tiff"]),
    ("detect-blank", ["/usr/bin/python3", "/opt/heykprint/image_processor.py", "detect-blank", "-i", "/mnt/data/scans/scan_1789811329950.jpg"])
]

header = f"{'Operation':<18} | {'Exit':<5} | {'Peak RSS (MB)':<13} | {'Limit (<60MB)':<13} | {'Result'}"
print(header)
print("-" * len(header))

for name, cmd in tests:
    pid = os.fork()
    if pid == 0:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        os.execv(cmd[0], cmd)
    else:
        _, status, rusage = os.wait4(pid, 0)
        exit_code = os.waitstatus_to_exitcode(status)
        peak_mb = rusage.ru_maxrss / 1024.0
        status_str = "PASS" if (exit_code == 0 and peak_mb < 60.0) else "FAIL"
        print(f"{name:<18} | {exit_code:<5} | {peak_mb:>10.2f} MB | {'< 60 MB':<13} | {status_str}")

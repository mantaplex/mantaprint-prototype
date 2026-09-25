import subprocess
import time
import os

def run_monitored(cmd):
    proc = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    peak_rss_kb = 0
    
    while proc.poll() is None:
        try:
            with open(f"/proc/{proc.pid}/status", "r") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss_kb = int(line.split()[1])
                        if rss_kb > peak_rss_kb:
                            peak_rss_kb = rss_kb
                        break
        except (FileNotFoundError, ProcessLookupError):
            pass
        time.sleep(0.005)
    
    stdout, stderr = proc.communicate()
    return proc.returncode, peak_rss_kb / 1024.0, stdout.decode().strip(), stderr.decode().strip()

tests = [
    ("deskew", "python3 /opt/heykprint/image_processor.py deskew -i /mnt/data/scans/scan_1789811329950.jpg -o /tmp/out_deskew.png"),
    ("enhance clean", "python3 /opt/heykprint/image_processor.py enhance -i /mnt/data/scans/scan_1789811329950.jpg -o /tmp/out_clean.png --filter clean"),
    ("enhance sauvola", "python3 /opt/heykprint/image_processor.py enhance -i /mnt/data/scans/scan_1789811329950.jpg -o /tmp/out_sauvola.png --filter sauvola"),
    ("ktp-2in1", "python3 /opt/heykprint/image_processor.py ktp-2in1 --front /mnt/data/scans/scan_1789811329950.jpg --back /mnt/data/scans/scan_1789811329950.jpg -o /tmp/out_ktp.pdf"),
    ("merge pdf", "python3 /opt/heykprint/image_processor.py merge -i /mnt/data/scans/scan_1789811329950.jpg /mnt/data/scans/test_150_gray.jpg -o /tmp/out_merge.pdf --format pdf"),
    ("merge tiff", "python3 /opt/heykprint/image_processor.py merge -i /mnt/data/scans/scan_1789811329950.jpg /mnt/data/scans/test_150_gray.jpg -o /tmp/out_merge.tiff --format tiff"),
    ("detect-blank", "python3 /opt/heykprint/image_processor.py detect-blank -i /mnt/data/scans/scan_1789811329950.jpg")
]

header = f"{'Operation':<18} | {'Exit':<5} | {'Peak RSS (MB)':<13} | {'Limit (<60MB)':<13} | {'Result'}"
print(header)
print("-" * len(header))
for name, cmd in tests:
    t0 = time.time()
    code, peak_mb, out, err = run_monitored(cmd)
    dt = time.time() - t0
    status = "PASS" if (code == 0 and peak_mb < 60.0) else "FAIL"
    print(f"{name:<18} | {code:<5} | {peak_mb:>10.2f} MB | {'< 60 MB':<13} | {status} ({dt:.2f}s)")
    if code != 0:
        print(f"   ERROR: {err}")

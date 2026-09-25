# Workflow & Development Guidelines

## 1. Embedded Appliance Development Principles

1. **Protect eMMC Flash Lifecycle**:
   * Never write continuous logs or spools to root `/`. Offload all high-churn I/O to `/tmp` (volatile tmpfs) or `/mnt/data/` (MicroSD).
2. **Strict RAM Budget Compliance**:
   * Single-board computers run with constrained RAM budgets enforced via systemd cgroups:
     * Node.js Web Dashboard: Max RAM ~24–60 MB (`--max-old-space-size=24`).
     * Node.js Agent: Max RAM ~16–25 MB (`--max-old-space-size=16`).
   * Avoid heavyweight node modules or unbounded memory buffers.
3. **Subprocess Execution Security**:
   * Always pass arguments via arrays using `execFile` (Node) or `subprocess.run(shell=False)` (Python). Never interpolate untrusted user input into shell strings.

---

## 2. Daily Developer Workflows

### A. Non-Intrusive Appliance Health Checks
Run the live telemetry script:
```bash
./scripts/status.sh
```

### B. Live Service Log Streaming
Stream real-time systemd journal logs from target units:
```bash
./scripts/logs.sh web        # Monitor mantaprint-web
./scripts/logs.sh agent      # Monitor mantaprint-agent
./scripts/logs.sh hotplug    # Monitor mantaprint-hotplug
./scripts/logs.sh cups       # Monitor cups
```

### C. Read-Only Sync from Physical Appliance
Sync remote driver, firmware, or system modifications safely to the local workspace:
```bash
./scripts/sync-from-device.sh
```

### D. Safe Appliance Deployment
Deployments include automatic pre-deployment backup snapshots stored at `/mnt/data/backups/`:

* **Dry-Run (Simulate file changes without writing to target)**:
  ```bash
  ./scripts/deploy-to-device.sh web --dry-run
  ```

* **Module-Specific Deployments**:
  ```bash
  ./scripts/deploy-to-device.sh core     # Deploy Python modules to /opt/mantaprint/
  ./scripts/deploy-to-device.sh web      # Deploy Web dashboard to /opt/mantaprint/web/
  ./scripts/deploy-to-device.sh agent    # Deploy Fleet agent to /opt/mantaprint/agent/
  ./scripts/deploy-to-device.sh systemd  # Deploy Systemd units & udev rules
  ./scripts/deploy-to-device.sh all      # Full appliance deployment
  ```

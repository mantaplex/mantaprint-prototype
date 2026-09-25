# Contributing to MantaPrint Hub

Thank you for your interest in contributing to **MantaPrint Hub**! MantaPrint is an open-source, universal driverless print and scan appliance designed to bring reliable, driverless printing (AirPrint, Mopria, IPP Everywhere) and zero-trace document scanning to affordable single-board computers, TV boxes, and mini PCs.

We welcome contributions from developers, designers, system engineers, and testers of all backgrounds.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Core Architectural Principles](#core-architectural-principles)
3. [Development Environment Setup](#development-environment-setup)
4. [Branching & Commit Guidelines](#branching--commit-guidelines)
5. [Running Tests & Quality Assurance](#running-tests--quality-assurance)
6. [Submitting a Pull Request](#submitting-a-pull-request)
7. [Reporting Bugs & Requesting Features](#reporting-bugs--requesting-features)

---

## Code of Conduct

We are committed to providing a welcoming, constructive, and harassment-free environment for everyone.
- Be respectful and courteous in all interactions.
- Provide thoughtful, constructive feedback on code reviews and pull requests.
- Focus on what is best for the community and project security.

---

## Core Architectural Principles

When writing or reviewing code for MantaPrint Hub, all contributors must strictly adhere to our core appliance tenets:

### 1. Strict Memory Budget (< 60MB RAM per process)
MantaPrint is designed to run efficiently on low-resource hardware (e.g. 1GB–2GB RAM single-board computers):
* **Node.js Web Dashboard**: Must run within `--max-old-space-size=24 --max-semi-space-size=1`.
* **Node.js Agent**: Must run within `--max-old-space-size=16`.
* **Python Image Processor**: Must perform explicit memory cleanup (`gc.collect()`) after matrix transformations to keep peak RSS `< 60MB`.
* Avoid heavy third-party runtime dependencies. Prefer standard library solutions where feasible.

### 2. Zero-Trace Ephemeral Scans & Customer Privacy
* **100% Volatile RAM**: Customer documents must stream strictly to `/run/mantaprint/scans` (`tmpfs`). Scanned customer documents **must never touch eMMC or MicroSD flash memory**.
* Inactive scans must self-destruct within 5 minutes.
* Files must support immediate unlinking (`fs.unlinkSync`) upon completion of download streams when `?wipe=true` or `X-Auto-Wipe: true` is requested.
* Always enforce the anti-symlink traversal shield on file operations.

### 3. Flash Memory Longevity & Storage Tiering
* Internal eMMC is **read-mostly**. Do not write persistent logs, spools, or high-churn temporary files to `/`.
* All heavy I/O is offloaded to MicroSD mounted at `/mnt/data` with hardened kernel VFS flags (`noexec,nosuid,nodev,noatime,nodiratime,commit=60,errors=continue`).
* System logs reside on compressed ZRAM (`/dev/zram1` at `/var/log`).

### 4. Zero-Idle HDMI Lifecycle
* Graphical kiosk and compositor services must remain completely stopped (0% CPU, 0 MB RAM) when no HDMI display is connected.
* Display output is clamped to 1080p (or 720p HD) to prevent GPU VRAM starvation.

---

## Development Environment Setup

### Prerequisites
- **Linux Environment**: Debian 11/12/13, Ubuntu 22.04/24.04, Armbian, or Raspberry Pi OS (x86_64 or ARM64).
- **Node.js**: Version 18.x or 20.x LTS.
- **Python**: Version 3.10 or higher.
- **System Packages**:
  ```bash
  sudo apt-get update && sudo apt-get install -y \
      cups cups-client cups-filters sane-utils avahi-daemon \
      libnss-mdns imagemagick ghostscript qpdf build-essential \
      python3 python3-pil python3-reportlab
  ```

### Repository Setup
1. Fork the repository on GitHub and clone your fork:
   ```bash
   git clone https://github.com/<your-username>/mantaprint.git
   cd mantaprint
   ```
2. Install frontend dependencies:
   ```bash
   cd frontend
   npm install
   cd ..
   ```
3. Build the frontend assets:
   ```bash
   npm run build:frontend
   ```

---

## Branching & Commit Guidelines

### Git Branching
- Base your work off the `master` (or `main`) branch.
- Use descriptive branch names:
  - `feat/scanner-adf-multipage`
  - `fix/cups-port-status-timeout`
  - `docs/update-architecture-diagram`
  - `perf/sauvola-integral-cache`

### Commit Message Format
We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```text
<type>(<scope>): <short description>

[optional body providing technical context]

[optional footer(s), e.g. Closes #123]
```

**Allowed Types:**
- `feat`: A new feature or capability.
- `fix`: A bug fix or patch.
- `docs`: Documentation updates or additions.
- `perf`: Code changes that improve memory, CPU, or speed performance.
- `refactor`: Code restructurings that neither add features nor fix bugs.
- `test`: Adding or correcting tests.
- `chore`: Build scripts, CI/CD, or dependency maintenance.

**Example:**
```text
feat(scanner): add soft-knee paper illumination normalization

Implements background whitening using local morphological structuring
to eliminate yellowing and shadows while preserving stamp colors.
```

---

## Running Tests & Quality Assurance

Before submitting any changes, you must verify that all test suites pass.

### 1. Frontend & Document Processor Unit Tests
Run the React and image algorithm test suite:
```bash
cd frontend
npm test
```
All 12+ tests covering Sauvola binarization, horizontal projection deskew (<15ms), KTP alignment, and color space conversions must pass with 0 failures.

### 2. Python Backend Verification Suite
Execute the core image processor unit and integration tests:
```bash
python3 src/core/test_image_processor.py
```
This validates:
- CLI deskew execution and projection angle calculation
- Sauvola binarization and dual-layer color preservation
- KTP 2-in-1 PDF synthesis and DPI header integrity
- Multi-page document merges (PDF & TIFF)

### 3. Comprehensive End-to-End QA
Run the automated chaos and security verification scripts:
```bash
# End-to-end reliability, concurrency, and error handling
python3 qa/run_full_qa.py

# Memory RSS leak check under concurrent load (<60MB limit)
python3 qa/test_chaos_qa.py

# Security hardening and injection immunity verification
node qa/verify_security_hardening.mjs
```

### 4. Testing Local Installation Script
To test the appliance installer on a clean VM or test SBC:
```bash
sudo ./install.sh
```

---

## Submitting a Pull Request

1. Ensure your local branch is rebased onto the latest `master` branch:
   ```bash
   git fetch origin
   git rebase origin/master
   ```
2. Verify all test suites pass cleanly.
3. Push your branch to your GitHub fork:
   ```bash
   git push -u origin <your-branch-name>
   ```
4. Open a Pull Request against the upstream `master` branch.
5. In the PR description, clearly detail:
   - The problem being solved or the feature added.
   - Any hardware or distribution combinations tested (e.g. Raspberry Pi 4, Armbian S905X, x86_64 Ubuntu).
   - Confirmation that memory RSS budgets and ephemeral scan privacy rules were respected.

---

## Reporting Bugs & Requesting Features

- **Bug Reports**: Open an issue on GitHub detailing your hardware, OS distribution, kernel version, printer/scanner model, and steps to reproduce. Attach relevant logs (`./scripts/logs.sh <service>`).
- **Feature Requests**: Open an issue describing the proposed functionality, target use case, and rationale.

Thank you for helping make MantaPrint the most dependable, private, and universal print and scan appliance!

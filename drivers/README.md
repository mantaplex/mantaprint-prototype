# MantaPrint Hub :: Hardware Drivers & Filter Engine

This directory contains specialized, proprietary, and open-source printer filters and driver packages that are automatically provisioned by `install.sh`.

## 📦 Directory Structure

```
drivers/
├── README.md
├── canon-ufr2lt/
│   ├── cnrdrvcups-ufr2lt-uk_5.10-1.00_amd64.deb   # Official Canon UFR II LT (x86_64)
│   └── cnrdrvcups-ufr2lt-uk_5.10-1.00_arm64.deb   # Official Canon UFR II LT (ARM64)
└── captdriver/                                     # Open-source Canon CAPT driver
    ├── Makefile                                    # Build & install automation
    ├── ppd/                                        # Pre-compiled CUPS PPD profiles
    │   ├── CanonLBP-2900-3000.ppd
    │   ├── CanonLBP-3010-3018-3050.ppd
    │   └── CanonLBP-6000-6018.ppd
    └── src/                                        # Native C raster filter sources
```

---

## 1. Canon UFR II LT (`drivers/canon-ufr2lt/`)
- **Version**: 5.10-1.00 (Official Canon Linux Driver)
- **Supported Architectures**: `arm64` (aarch64), `amd64` (x86_64)
- **Supported Hardware**:
  - Canon LBP6030, LBP6030B, LBP6030w, LBP6040, LBP6018L, LBP6018w
  - Canon LBP6230dn, LBP6230dw, LBP6200d
  - Canon LBP112, LBP113w, LBP151dw
  - Canon LBP7110Cw, LBP8100n
- **License**: Canon Proprietary Software License. Distributed solely for hardware interoperation on MantaPrint Hub appliances.

---

## 2. Canon CAPT Driver (`drivers/captdriver/`)
- **Filter**: `rastertocapt` (`/usr/lib/cups/filter/rastertocapt`)
- **Supported Hardware**:
  - Canon LBP2900, LBP2900B, LBP3000
  - Canon LBP3010, LBP3018, LBP3050
  - Canon LBP6000, LBP6018
- **Compilation**: Compiled on-the-fly during installation using `gcc` and CUPS developer headers (`libcups2-dev`, `libcupsimage2-dev`).
- **License**: GNU General Public License v2 (GPL-2.0).

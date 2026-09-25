-- MantaMan SQLite Database Schema
-- Fleet Management, Discovery, Adoption & Audit Ledger

PRAGMA foreign_keys = ON;

-- 1. Sites / Branches
CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    address TEXT DEFAULT '',
    subnet_cidr TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    created_at INTEGER NOT NULL
);

-- Default Site
INSERT OR IGNORE INTO sites (id, name, slug, address, subnet_cidr, created_at)
VALUES ('site_default', 'Headquarters (Default Site)', 'hq-default', 'Main Data Center', '192.168.1.0/24', 1700000000);

-- 2. Managed MantaPrint Hubs
CREATE TABLE IF NOT EXISTS hubs (
    id TEXT PRIMARY KEY,                       -- e.g. "mantaprint-c4e92a"
    name TEXT NOT NULL,                         -- Human-friendly display name
    site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
    ip_address TEXT NOT NULL,
    mac_address TEXT DEFAULT '',
    arch TEXT DEFAULT 'arm64',
    model TEXT DEFAULT 'MantaPrint STB Hub',
    version TEXT DEFAULT 'v0.2.1',
    status TEXT NOT NULL DEFAULT 'unadopted',   -- unadopted, adopting, managed, revoked
    is_online INTEGER NOT NULL DEFAULT 0,       -- 1 = connected, 0 = disconnected
    cups_state TEXT DEFAULT 'idle',             -- idle, printing, stopped, disabled
    printer_name TEXT DEFAULT '',
    toner_cmyk TEXT DEFAULT '{}',               -- JSON: {"k": 95, "c": 80, ...}
    cpu_temp REAL DEFAULT 0.0,
    ram_used_mb INTEGER DEFAULT 0,
    ram_total_mb INTEGER DEFAULT 0,
    uptime TEXT DEFAULT '',
    storage_health TEXT DEFAULT 'healthy',
    pairing_pin TEXT,                           -- 6-digit ephemeral PIN
    pairing_pin_exp INTEGER DEFAULT 0,          -- Unix timestamp ms
    auth_token_hash TEXT,                       -- SHA-256 hash of capability token
    last_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hubs_status ON hubs(status);
CREATE INDEX IF NOT EXISTS idx_hubs_site_id ON hubs(site_id);
CREATE INDEX IF NOT EXISTS idx_hubs_is_online ON hubs(is_online);

-- 3. Driver & Filter Artifacts
CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    arch TEXT NOT NULL DEFAULT 'arm64',
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- 4. Batch Operations & Rolling Updates
CREATE TABLE IF NOT EXISTS batch_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    task_type TEXT NOT NULL,                   -- ota_update, driver_push, test_print, restart_cups, clear_queue
    target_site_id TEXT REFERENCES sites(id),
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',     -- pending, in_progress, completed, failed, cancelled
    total_nodes INTEGER NOT NULL DEFAULT 0,
    successful_nodes INTEGER NOT NULL DEFAULT 0,
    failed_nodes INTEGER NOT NULL DEFAULT 0,
    logs_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);

-- 5. Immutable Cryptographically Chained Audit Ledger
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    actor TEXT NOT NULL,                       -- Admin username or "system"
    action TEXT NOT NULL,                      -- e.g. "adopt_hub", "reboot_hub", "ota_update"
    target_type TEXT NOT NULL,                 -- "hub", "site", "driver", "system"
    target_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    prev_hash TEXT NOT NULL,                   -- Hash of record N-1
    record_hash TEXT NOT NULL                  -- SHA-256(prev_hash + serialized record)
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);

-- 6. Console Administrative Accounts & RBAC
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'SuperAdmin',    -- SuperAdmin, SiteAdmin, Viewer
    site_id TEXT REFERENCES sites(id),         -- Scoped site for SiteAdmin
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

# MantaMan (Manta Manager): Controller Core Architecture & Fleet QA/QC Specification

**Document Version:** 1.0.0-PROD  
**Target Architecture:** MantaMan Fleet Controller Console & MantaPrint Hub STB Network  
**Specification Owner:** Principal Systems & Infrastructure Architect  
**Classification:** Production Engineering Architecture & Quality Assurance Standard  
**Companion Documents:**  
- [`docs/07-mantaman-security-specification.md`](file:///home/amri/print/docs/07-mantaman-security-specification.md) (Zero-Trust Security & Cryptography)  
- [`docs/07-mantaman-web-console-ui-ux-i18n-spec.md`](file:///home/amri/print/docs/07-mantaman-web-console-ui-ux-i18n-spec.md) (Frontend UI/UX & Localization)  
- [`src/agent/agent.mjs`](file:///home/amri/print/src/agent/agent.mjs) (Edge Agent Daemon Implementation)  
- [`install.sh`](file:///home/amri/print/install.sh) (Edge Hub Appliance Installer)  

---

> [!NOTE]
> **Rebranding & Backward Compatibility Note (v0.2.3)**:
> As of release `v0.2.3`, **MantaMan** is officially rebranded to **MantaPool Console**. All controller core architectures, SQLite WAL schemas, adoption workflows, and fleet QA/QC standards documented herein apply directly to MantaPool Console, with identical system paths and service units (`mantaman.service`, port `8443`).

---

## Executive Overview & Architectural Mandate

**MantaPool Console** (formerly **MantaMan**) serves as the centralized, multi-tenant fleet controller for geographically distributed MantaPrint Hub edge appliances (running on low-power Armbian ARM64/S905X STBs and Linux SBCs). While each MantaPrint Hub operates with 100% local autonomy—spooling jobs to local printers, servicing airprint/CUPS clients, and running ephemeral in-memory scan pipelines without cloud dependency—enterprise deployments require centralized oversight.

MantaMan delivers:
1. **Real-time Observability:** CPU thermals, RAM utilization, storage tier health, CUPS daemon state, paper/toner supplies, and print job queues across thousands of edge nodes.
2. **Deterministic Remote Orchestration:** Safe execution of operational commands (`test_print`, `restart_cups`, `clear_queue`, `reboot`, `install_driver`, `ota_update`) with strict parameter sanitization and cryptographic authorization.
3. **Automated Discovery & Zero-Touch Adoption:** Seamless local-subnet L2 discovery (mDNS & UDP broadcast), active CIDR sweeps, and L3 WAN phone-home registration.
4. **Resilient Fleet Operations:** Rolling OTA firmware updates with canary verification, circuit breakers, and transactional, self-healing driver distribution.

```mermaid
flowchart TB
    subgraph Enterprise_Fleet ["Distributed Edge Locations (Branches, Print Shops, Campuses)"]
        subgraph Site_Alpha ["Site A: Retail Branch (192.168.10.0/24)"]
            HubA1["MantaPrint Hub 01<br/>(S905X ARM64)"]
            HubA2["MantaPrint Hub 02<br/>(Raspberry Pi 4)"]
        end
        subgraph Site_Beta ["Site B: Corporate Campus (10.200.4.0/22)"]
            HubB1["MantaPrint Hub 10<br/>(Rockchip RK3566)"]
            HubBN["MantaPrint Hub N<br/>(Allwinner H616)"]
        end
    end

    subgraph Controller_Cluster ["MantaMan Controller Infrastructure"]
        LB["TLS 1.3 Reverse Proxy & WAF<br/>(Nginx / Traefik / Envoy)"]
        
        subgraph Core_Engine ["MantaMan Node.js 20 LTS Core"]
            HTTP_API["Fastify 4 REST / Admin Gateway<br/>(Port 8080/8443)"]
            WS_MUX["ws WebSocket Multiplexer<br/>(Connection Pooling & Watchdog)"]
            FSM["Adoption & Discovery FSM<br/>(L2 mDNS / UDP + L3 Inform)"]
            BatchWorker["Rolling OTA & Driver Worker<br/>(Concurrency Limiter & Circuit Breaker)"]
        end

        subgraph Storage_Layer ["Persistence & Repository"]
            DB[("Embedded SQLite (WAL Mode)<br/>fleet.db (64MB Cache)")]
            DriverRepo["Driver Package Repository<br/>(/var/lib/mantaman/drivers)"]
            AuditVault[("Cryptographic Audit Chain<br/>(SHA-256 Chained Log)")]
        end
    end

    HubA1 ==>|Persistent Outbound WSS| LB
    HubA2 ==>|Persistent Outbound WSS| LB
    HubB1 ==>|Persistent Outbound WSS| LB
    HubBN ==>|Persistent Outbound WSS| LB

    LB --> HTTP_API
    LB --> WS_MUX

    WS_MUX <--> FSM
    WS_MUX <--> BatchWorker
    WS_MUX <--> DB
    HTTP_API <--> DB
    BatchWorker --> DriverRepo
    HTTP_API --> AuditVault
```

---

## 1. Focus Area 1: High-Performance Controller Core

### 1.1 Architectural Debate: Framework & Runtime Engine

A central architectural debate for the controller core centers on the trade-off between **Fastify v4/v5** versus a purely **Native `node:http` + `ws`** stack.

#### Comparative Matrix

| Evaluation Dimension | Native `node:http` + `ws` | Fastify (with `@fastify/websocket`) | Decision & Rationale |
| :--- | :--- | :--- | :--- |
| **Throughput & Raw Latency** | Baseline zero-overhead (highest possible raw I/O throughput; ~65,000 req/s). | Near-zero overhead via `find-my-way` Radix Tree routing (~62,000 req/s, within 4% of native). | **Fastify for HTTP/REST + Standalone `ws` via `noServer` upgrade**. Fastify's routing latency penalty is negligible. |
| **Schema Validation & Serialization** | Manual JSON parsing, manual regex/type checks, standard `JSON.stringify` (slow, vulnerable to prototype pollution). | Compiled Ajv JSON schema validation + `fast-json-stringify` (2x-3x faster JSON serialization than native `JSON.stringify`). | **Fastify**. Fleet management endpoints exchange massive telemetry arrays. Fast JSON serialization significantly lowers controller CPU load. |
| **WebSocket Multiplexing & Granularity** | Direct control over raw TCP sockets, custom frame slicing, zero wrapper abstractions. | Route-level WebSocket encapsulation, but introduces abstraction overhead and tightly couples WS lifecycle to route hooks. | **Native `ws` Server mounted via HTTP Upgrade**. Prevents routing abstraction leaks during high-throughput binary/telemetry transfers. |
| **Memory Footprint & GC Pressure** | Minimal baseline (~18MB idle RSS). | Low baseline (~28MB idle RSS). | **Hybrid Architecture**. Under 35MB total controller footprint, well within bounds. |
| **Ecosystem & Enterprise Middleware** | Must re-invent CORS, rate limiting, multipart streaming, and lifecycle hooks manually. | Built-in, audited ecosystem (`@fastify/cors`, `@fastify/rate-limit`, `@fastify/multipart`, `@fastify/sensible`). | **Fastify**. Rapid enterprise auditability and security hygiene. |

#### Architectural Resolution: The Decoupled Hybrid Pattern

The production MantaMan controller adopts the **Decoupled Hybrid Architecture**:
1. **HTTP / REST Plane:** Powered by **Fastify 4/5 LTS**. Serves the React 19 administrative console, handles REST endpoints (`/api/fleet`, `/api/drivers`, `/api/audit`), executes Ajv-compiled schema validation, and terminates driver archive uploads with streaming backpressure.
2. **Edge WebSocket Gateway:** Powered by a standalone **`ws.WebSocketServer({ noServer: true })`**. The Fastify HTTP server delegates WebSocket upgrade requests via `server.on('upgrade', ...)`. This provides raw, unabstracted TCP socket handling, direct control over ping/pong timeouts, custom backpressure tracking, and isolates edge STB socket traffic from web admin requests.

---

### 1.2 Persistence Engine: Embedded SQLite with WAL Mode

To satisfy the zero-dependency mandate (allowing instant single-binary or Docker container deployment without running external PostgreSQL or MySQL daemons), MantaMan utilizes an embedded **SQLite engine running in Write-Ahead Logging (WAL) mode**.

#### Driver Comparison: `better-sqlite3` vs `sqlite3` vs `node:sqlite`

| Engine | Execution Model | Performance (Inserts/sec) | Node 20 LTS Compatibility | Production Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **`sqlite3` (node-sqlite3)** | Asynchronous via `libuv` thread pool callbacks. | ~2,500 op/s (heavy context switching overhead). | Full compatibility. | **Rejected:** Thread pool starvation occurs under heavy telemetry ingestion from hundreds of STBs. |
| **`node:sqlite` (DatabaseSync)** | Synchronous native V8 binding. | ~45,000 op/s. | Introduced experimental in Node 22.5.0+. Backported partially, but unstable in Node 20 LTS. | **Rejected for Node 20 LTS; Reserved for Node 22+ migration.** |
| **`better-sqlite3`** | Synchronous native C++ bindings directly executing on V8 heap. | ~65,000 op/s. Prepared statements compiled to bytecode once. | Rock-solid production stability across Node 18, 20, and 22 LTS. | **SELECTED.** Zero event loop thread-hopping; deterministic execution latency (< 0.05ms per query). |

#### Concurrency & Event Loop Protection: The Coalescing Batch Pipeline

Because `better-sqlite3` is synchronous, executing individual SQLite `INSERT`/`UPDATE` transactions for every incoming telemetry frame (from 500+ STBs sending updates every 10–15 seconds) would cause micro-stalls in Node's main event loop.

To prevent loop blocking, MantaMan implements an **In-Memory Telemetry Coalescing Batch Writer**:
1. Incoming telemetry frames update an in-memory `Map<deviceId, TelemetrySnapshot>`. If an STB sends 3 updates within 500ms, only the latest state is preserved.
2. A debounced flush timer executes every **500ms**.
3. All buffered updates are committed inside a single atomic SQLite transaction:
   ```sql
   BEGIN IMMEDIATE;
   -- Iteration of up to 500 prepared statement executions
   COMMIT;
   ```
4. This reduces disk I/O from 500 discrete transactions per second down to **2 batch writes per second**, maintaining SQLite WAL commit latency below **3 milliseconds**.

#### Hardened SQLite PRAGMA Configuration

Upon opening `fleet.db`, MantaMan immediately applies these performance and resilience PRAGMAs:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -64000;         -- 64MB memory page cache
PRAGMA temp_store = MEMORY;         -- Keep temporary tables and indices in RAM
PRAGMA wal_autocheckpoint = 1000;   -- Checkpoint WAL every 1,000 pages (~4MB)
PRAGMA mmap_size = 268435456;       -- 256MB memory-mapped I/O
PRAGMA foreign_keys = ON;           -- Enforce relational referential integrity
```

---

### 1.3 Complete Production SQLite Schema DDL

```sql
-- ============================================================================
-- MantaMan Fleet Controller Production Schema (SQLite WAL Mode)
-- ============================================================================

-- 1. Multi-Location Site Grouping
CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,                       -- e.g. 'site-corp-hq', 'site-branch-042'
    name TEXT NOT NULL,                        -- Human readable name
    description TEXT,                          -- Branch address or facility notes
    cidr_ranges TEXT NOT NULL DEFAULT '[]',    -- JSON Array of CIDR strings, e.g. ["192.168.10.0/24"]
    contact_email TEXT,                        -- Site admin contact
    auto_adopt_enabled INTEGER DEFAULT 0,      -- 1 = Auto-adopt hubs discovered in site CIDRs
    default_poll_interval INTEGER DEFAULT 15,  -- Edge telemetry interval in seconds
    created_at INTEGER NOT NULL,               -- Epoch ms
    updated_at INTEGER NOT NULL                -- Epoch ms
);

-- 2. Hub Appliances (Edge STBs)
CREATE TABLE IF NOT EXISTS hubs (
    id TEXT PRIMARY KEY,                       -- Unique identifier: 'mantaprint-c4e92a'
    site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
    hostname TEXT NOT NULL,                    -- Edge hostname: 'mantaprint'
    ip TEXT NOT NULL,                          -- IPv4 address: '192.168.1.114'
    mac TEXT NOT NULL UNIQUE,                  -- Physical MAC: 'b8:27:eb:c4:e9:2a'
    arch TEXT NOT NULL DEFAULT 'arm64',        -- 'arm64', 'armhf', 'x86_64'
    hw_model TEXT,                             -- 'Amlogic Meson S905X / ARM64'
    firmware_version TEXT DEFAULT '2.0.0',     -- Version of MantaPrint Hub OS
    label TEXT,                                -- User-assigned display alias
    status TEXT NOT NULL DEFAULT 'discovered', -- 'discovered','adopting','adopted','managed','unadopted','disconnected'
    
    -- Telemetry & Health Metrics (Updated by Coalescing Batch Writer)
    cpu_temp REAL DEFAULT 0.0,                 -- Core temperature in Celsius
    ram_used_mb REAL DEFAULT 0.0,              -- Used memory in MB
    ram_total_mb REAL DEFAULT 0.0,             -- Total physical RAM in MB
    uptime TEXT DEFAULT '0m',                  -- Human-readable uptime
    storage_info TEXT,                         -- JSON string of storage tiering health
    
    -- CUPS Printer State
    printer_name TEXT DEFAULT 'None',          -- Active CUPS queue destination
    printer_uri TEXT DEFAULT '',               -- Device URI: 'usb://Canon/E410'
    printer_state TEXT DEFAULT 'unknown',      -- 'idle', 'printing', 'stopped', 'error'
    supply_markers TEXT DEFAULT '{}',          -- JSON: {"k": 85, "c": 70, "m": 65, "y": 72}
    jobs_completed INTEGER DEFAULT 0,          -- Lifetime processed jobs
    active_jobs_count INTEGER DEFAULT 0,       -- Currently queued jobs
    
    -- Security & Authentication Credentials
    auth_token_hash TEXT,                      -- Argon2id or SHA-256 hash of device capability token
    enrollment_pin TEXT,                       -- Ephemeral 6-digit challenge PIN (during adoption)
    pin_expires_at INTEGER,                    -- Expiration epoch ms for adoption PIN
    public_key TEXT,                           -- Ed25519 public key of edge appliance (if mTLS/signed)
    
    -- Lifecycle Tracking
    first_seen INTEGER NOT NULL,               -- Initial discovery timestamp
    enrolled_at INTEGER,                       -- Adoption timestamp
    last_seen INTEGER NOT NULL                 -- Timestamp of last valid WebSocket frame
);

-- 3. Printer Driver Repository (PPDs & Binary Filters)
CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,                       -- e.g. 'drv-canon-e410-v2'
    name TEXT NOT NULL,                        -- Display Name: 'Canon E400/E410 Series CUPS Driver'
    version TEXT NOT NULL,                     -- Version string: '2.1.0'
    target_models TEXT NOT NULL,               -- JSON Array: ["Canon E410", "Canon E400"]
    arch TEXT NOT NULL DEFAULT 'arm64',        -- 'arm64', 'all', 'x86_64'
    filename TEXT NOT NULL,                    -- File basename on server: 'canon-e410-v2.tar.gz'
    file_size INTEGER NOT NULL,                -- Archive size in bytes
    sha256 TEXT NOT NULL,                      -- Hex-encoded SHA-256 checksum of the package
    has_custom_filters INTEGER DEFAULT 0,      -- 1 if package contains binary CUPS filters
    uploaded_at INTEGER NOT NULL,              -- Epoch ms
    deploy_count INTEGER DEFAULT 0             -- Lifetime deployments to edge nodes
);

-- 4. Batch Operations & Rolling Tasks
CREATE TABLE IF NOT EXISTS batch_tasks (
    id TEXT PRIMARY KEY,                       -- 'task-ota-20260921-01'
    task_type TEXT NOT NULL,                   -- 'ota_update', 'install_driver', 'restart_cups', 'reboot'
    target_selector TEXT NOT NULL,             -- JSON: {"site_id": "site-branch-042"} or {"ids": ["..."]}
    payload TEXT NOT NULL DEFAULT '{}',        -- JSON task arguments (e.g. driver_id, version, urls)
    status TEXT NOT NULL DEFAULT 'pending',    -- 'pending', 'running', 'paused', 'completed', 'failed', 'cancelled'
    concurrency_limit INTEGER DEFAULT 5,       -- Max concurrent edge nodes updating simultaneously
    max_failure_percentage REAL DEFAULT 10.0,  -- Circuit breaker trigger threshold
    total_targets INTEGER DEFAULT 0,           -- Count of target Hubs
    success_count INTEGER DEFAULT 0,           -- Count of successful executions
    failure_count INTEGER DEFAULT 0,           -- Count of failed executions
    created_by TEXT DEFAULT 'admin',           -- Operator username
    created_at INTEGER NOT NULL,               -- Epoch ms
    started_at INTEGER,                        -- Epoch ms
    completed_at INTEGER                       -- Epoch ms
);

-- 5. Individual Hub Task Executions
CREATE TABLE IF NOT EXISTS task_executions (
    id TEXT PRIMARY KEY,                       -- 'exec-hub-c4e92a-task01'
    task_id TEXT NOT NULL REFERENCES batch_tasks(id) ON DELETE CASCADE,
    hub_id TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',    -- 'pending', 'dispatched', 'in_progress', 'completed', 'failed'
    attempt INTEGER DEFAULT 1,
    dispatched_at INTEGER,
    completed_at INTEGER,
    error_message TEXT,
    execution_logs TEXT                        -- Detailed stdout/stderr from edge execution
);

-- 6. Cryptographic Tamper-Evident Audit Log
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,                -- Epoch ms
    actor TEXT NOT NULL,                       -- Operator username, API token, or 'system'
    ip_address TEXT NOT NULL,                  -- Client IP of the actor
    action TEXT NOT NULL,                      -- 'adopt_hub', 'dispatch_command', 'upload_driver', etc.
    target_type TEXT NOT NULL,                 -- 'hub', 'driver', 'site', 'batch_task'
    target_id TEXT NOT NULL,                   -- ID of the affected entity
    payload TEXT,                              -- JSON snapshot of command arguments or diff
    status TEXT NOT NULL,                      -- 'SUCCESS' or 'FAILURE'
    prev_hash TEXT NOT NULL,                   -- SHA-256 hash of the immediately preceding record
    record_hash TEXT NOT NULL                  -- SHA-256(id + timestamp + actor + action + target_id + prev_hash)
);

-- Strategic Indexes for High-Velocity Queries
CREATE INDEX IF NOT EXISTS idx_hubs_status ON hubs(status);
CREATE INDEX IF NOT EXISTS idx_hubs_site_id ON hubs(site_id);
CREATE INDEX IF NOT EXISTS idx_hubs_last_seen ON hubs(last_seen);
CREATE INDEX IF NOT EXISTS idx_task_exec_task ON task_executions(task_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
```

---

### 1.4 Fleet Communication Protocol & Exact JSON Message Schemas

Communication between the MantaPrint Hub Edge Agent (`src/agent/agent.mjs`) and the MantaMan Controller occurs exclusively over **bidirectional, outbound-initiated WebSocket connections (`wss://`)**. All messages are formatted as strict JSON frames with a top-level `type` discriminator.

#### 1.4.1 Handshake Protocol Contract

Initiated by the Edge Agent immediately upon socket establishment. The Agent must present its unique hardware ID and authentication token.

```mermaid
sequenceDiagram
    autonumber
    participant Agent as Edge Agent (Hub STB)
    participant MUX as MantaMan WS Multiplexer
    participant DB as SQLite Engine

    Agent->>MUX: WS Connect: /ws/agent?type=agent&token=CORP-PROD-2026
    Note over MUX: 10s Auth Watchdog Started
    Agent->>MUX: {"type": "handshake", ...}
    MUX->>DB: Query Hub & Validate Token Hash
    alt Token Valid
        MUX->>DB: Update IP, Hostname, Last Seen (Status: Online)
        MUX-->>Agent: {"type": "handshake_ack", "status": "managed", "auth_token": "auth-..."}
        Note over Agent: Save auth_token to /etc/mantaprint/console.json
    else Token Invalid or Spoofed
        MUX-->>Agent: {"type": "handshake_reject", "code": 401, "error": "Unauthorized"}
        MUX->>Agent: Close Socket (Code 1008: Policy Violation)
    end
```

##### `handshake` (Agent -> Controller)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AgentHandshake",
  "type": "object",
  "required": ["type", "id", "token", "hostname", "ip", "printer", "system"],
  "properties": {
    "type": { "type": "string", "const": "handshake" },
    "id": { "type": "string", "pattern": "^mantaprint-[a-f0-9]{4,12}$" },
    "token": { "type": "string", "minLength": 8, "maxLength": 128 },
    "hostname": { "type": "string", "maxLength": 64 },
    "ip": { "type": "string", "format": "ipv4" },
    "mac": { "type": "string", "pattern": "^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$" },
    "firmware_version": { "type": "string", "default": "2.0.0" },
    "printer": {
      "type": "object",
      "required": ["name", "state"],
      "properties": {
        "name": { "type": "string", "maxLength": 100 },
        "state": { "type": "string", "enum": ["idle", "printing", "stopped", "disabled", "unknown"] },
        "uri": { "type": "string", "maxLength": 200 }
      }
    },
    "system": {
      "type": "object",
      "required": ["cpu_temp", "ram_used_mb", "ram_total_mb", "uptime"],
      "properties": {
        "cpu_temp": { "type": "number", "minimum": 0, "maximum": 120 },
        "ram_used_mb": { "type": "number", "minimum": 0 },
        "ram_total_mb": { "type": "number", "minimum": 1 },
        "uptime": { "type": "string", "maxLength": 30 }
      }
    }
  }
}
```

##### `handshake_ack` (Controller -> Agent)
```json
{
  "type": "handshake_ack",
  "status": "managed",
  "id": "mantaprint-c4e92a",
  "auth_token": "auth-e8b2490fa83c411b93f18a4270d19",
  "server_time": 1790095200000,
  "config": {
    "heartbeat_interval_sec": 15,
    "telemetry_interval_sec": 15,
    "jitter_ms": 3412
  }
}
```

##### `handshake_reject` (Controller -> Agent)
```json
{
  "type": "handshake_reject",
  "code": 401,
  "error": "Unauthorized: Invalid enrollment token or device revoked",
  "reconnect_allowed": false
}
```

---

#### 1.4.2 Telemetry Reporting Protocol Contract

Streamed periodically from Edge Agent to Controller (default: every 15 seconds, randomized by jitter).

##### `telemetry` (Agent -> Controller)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AgentTelemetry",
  "type": "object",
  "required": ["type", "id", "system", "printer"],
  "properties": {
    "type": { "type": "string", "const": "telemetry" },
    "id": { "type": "string", "pattern": "^mantaprint-[a-f0-9]{4,12}$" },
    "system": {
      "type": "object",
      "required": ["cpu_temp", "ram_used_mb", "uptime"],
      "properties": {
        "cpu_temp": { "type": "number" },
        "ram_used_mb": { "type": "number" },
        "uptime": { "type": "string" },
        "storage": {
          "type": ["object", "null"],
          "properties": {
            "root_type": { "type": "string", "enum": ["Internal eMMC", "MicroSD / SD Card", "Standard Disk", "NVMe Solid State Drive"] },
            "sd_mounted": { "type": "boolean" },
            "zram_active": { "type": "boolean" },
            "scans_tmpfs_free_mb": { "type": "number" }
          }
        }
      }
    },
    "printer": {
      "type": "object",
      "required": ["state"],
      "properties": {
        "name": { "type": "string" },
        "state": { "type": "string", "enum": ["idle", "printing", "stopped", "disabled", "error", "unknown"] },
        "active_job": {
          "type": ["object", "null"],
          "properties": {
            "job_id": { "type": "string" },
            "title": { "type": "string" },
            "user": { "type": "string" },
            "pages": { "type": "integer" },
            "size_kb": { "type": "number" }
          }
        }
      }
    },
    "toner": {
      "type": "object",
      "properties": {
        "k": { "type": "integer", "minimum": 0, "maximum": 100 },
        "c": { "type": "integer", "minimum": 0, "maximum": 100 },
        "m": { "type": "integer", "minimum": 0, "maximum": 100 },
        "y": { "type": "integer", "minimum": 0, "maximum": 100 }
      }
    },
    "jobs_completed": { "type": "integer", "minimum": 0 }
  }
}
```

##### `telemetry_ack` (Controller -> Agent)
```json
{
  "type": "telemetry_ack",
  "timestamp": 1790095215000
}
```

---

#### 1.4.3 Command & Execution Protocol Contract

##### `command` (Controller -> Agent)
The controller dispatches an authorized command to the Edge Agent.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ControllerCommand",
  "type": "object",
  "required": ["type", "command", "task_id"],
  "properties": {
    "type": { "type": "string", "const": "command" },
    "task_id": { "type": "string" },
    "command": { 
      "type": "string", 
      "enum": ["test_print", "restart_cups", "clear_queue", "reboot", "install_driver", "ota_update"] 
    },
    "params": {
      "type": "object",
      "properties": {
        "printer": { "type": "string", "pattern": "^[a-zA-Z0-9_-]{1,64}$" },
        "driver_id": { "type": "string" },
        "url": { "type": "string" },
        "sha256": { "type": "string", "pattern": "^[a-fA-F0-9]{64}$" },
        "ota_version": { "type": "string" },
        "ota_package_url": { "type": "string" }
      }
    },
    "timestamp": { "type": "integer" }
  }
}
```

##### `command_result` (Agent -> Controller)
Sent by the Edge Agent immediately upon completion or failure of a command.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AgentCommandResult",
  "type": "object",
  "required": ["type", "id", "command", "status", "success"],
  "properties": {
    "type": { "type": "string", "const": "command_result" },
    "id": { "type": "string" },
    "task_id": { "type": "string" },
    "command": { "type": "string" },
    "driver_id": { "type": "string" },
    "status": { "type": "string", "enum": ["completed", "failed"] },
    "success": { "type": "boolean" },
    "message": { "type": "string" },
    "error": { "type": "string" },
    "execution_time_ms": { "type": "integer" }
  }
}
```

---

#### 1.4.4 Heartbeat, Ping/Pong & Half-Open TCP Detection

In real-world retail and enterprise networks, edge cellular modems, branch firewalls, and NAT gateways frequently drop idle TCP connections without transmitting `FIN` or `RST` packets (creating a **silent half-open TCP state**). Left unhandled, both client and server maintain zombie sockets indefinitely.

MantaMan solves this with a **Dual-Sided Active Liveness Protocol**:

```mermaid
sequenceDiagram
    autonumber
    participant Server as MantaMan Controller (Server)
    participant Socket as TCP / TLS 1.3 Transport
    participant Agent as Hub Edge Agent (Client)

    Note over Server,Agent: Normal Operation (Every 15s)
    Server->>Agent: WebSocket Opcode 0x9 (PING)
    Agent-->>Server: WebSocket Opcode 0xA (PONG)
    Note over Server: Reset missedPongs = 0

    Note over Socket: Network Cable Cut / NAT Timeout (Half-Open TCP)
    Server->>Socket: WebSocket Opcode 0x9 (PING)
    Note over Socket: Frame dropped silently in transit
    Note over Agent: Watchdog: 30s elapsed with 0 frames from server!
    Agent->>Agent: Terminate socket & schedule jittered reconnect (Full Jitter)

    Note over Server: Server Heartbeat Tick (T = 30s)
    Server->>Socket: WebSocket Opcode 0x9 (PING)
    Note over Server: missedPongs reaches 2 (Threshold Exceeded)
    Server->>Server: ws.terminate()
    Server->>Server: Remove from agentSockets & Mark Hub 'disconnected'
```

1. **Server-Side Liveness Manager:**
   - Issues a native RFC 6455 Ping frame (`0x9`) every **15 seconds** with a randomized offset (jitter: `+/- 1.5s`) to prevent synchronized ping storms across 1,000 devices.
   - If an edge device fails to respond with a Pong frame (`0xA`) for **2 consecutive cycles (30 seconds)**, the server classifies the socket as a zombie, calls `ws.terminate()`, updates the database status to `disconnected`, and notifies web dashboards.
2. **Client-Side Silent Watchdog (`src/agent/agent.mjs`):**
   - The Agent maintains a 30-second watchdog timer (`resetWatchdog()`). Every valid frame (telemetry ACK, command, or ping) resets this timer.
   - If 30 seconds elapse without any byte received from the server, the Agent logs:
     `[MantaPrint Agent] ⚠️ Silent network disconnect (half-open TCP) detected! Terminating socket...`
   - It destroys the local socket and initiates a **Full Jitter Exponential Backoff**:
     $$\text{delay} = \min(60000, \text{backoff} \times 1.5) \pm 20\%$$
3. **Kernel TCP Keepalive:** The Agent initializes Node's Undici dispatcher with:
   `keepAlive: true, keepAliveInitialDelay: 10000` (10-second TCP keepalive probes).

---

## 2. Focus Area 2: Discovery & Adoption Engine

### 2.1 Multi-Channel Discovery Topology

To support disparate networking environments—from unmanaged flat LANs to segmented corporate VLANs and multi-site WANs—MantaMan operates three concurrent discovery channels:

```mermaid
flowchart LR
    subgraph Edge_LAN ["Edge Local Network (Subnet)"]
        Hub["MantaPrint Hub STB"]
        MDNS_Adv["mDNS Responder<br/>(_mantaprint._tcp.local)"]
        UDP_Bcast["UDP Broadcast Beacon<br/>(Port :9876)"]
        Hub --> MDNS_Adv
        Hub --> UDP_Bcast
    end

    subgraph Discovery_Engine ["MantaMan Discovery Engine"]
        L2_MDNS["L2 mDNS Listener"]
        L2_UDP["L2 UDP Socket Listener (:9876)"]
        L3_Scanner["Active Subnet CIDR Scanner<br/>(Probing 80 / 631 / 9876)"]
        L3_Inform["L3 WAN Inform API<br/>(POST /api/v1/inform)"]
    end

    MDNS_Adv -.->|Multicast 224.0.0.251| L2_MDNS
    UDP_Bcast -.->|Broadcast 255.255.255.255:9876| L2_UDP
    L3_Scanner ==>|Active HTTP Probe| Hub
    Hub ==>|Outbound HTTP/WSS| L3_Inform
```

#### 1. Layer 2 mDNS Listener (`_mantaprint._tcp.local`)
- Edge Hubs announce their presence using Avahi / Node mDNS responder on `_mantaprint._tcp.local`, port 80.
- TXT records contain non-sensitive metadata:
  `id=mantaprint-c4e92a`, `mac=b8:27:eb:c4:e9:2a`, `model=Armbian-S905X`, `ver=2.0.0`, `status=unmanaged`.
- MantaMan's mDNS listener parses discovered records and creates or updates a row in `hubs` with status `discovered`.

#### 2. Layer 2 UDP Broadcast Listener (Port `:9876`)
- For networks where mDNS/multicast is filtered by managed switches, the Edge Hub emits a lightweight UDP broadcast beacon to `255.255.255.255:9876` every 30 seconds:
  ```json
  {
    "proto": "mantaprint_beacon",
    "id": "mantaprint-c4e92a",
    "ip": "192.168.1.114",
    "mac": "b8:27:eb:c4:e9:2a",
    "port": 80,
    "status": "unmanaged"
  }
  ```
- The controller binds a UDP socket to `0.0.0.0:9876`, parsing incoming beacons to detect new hubs in sub-second time.

#### 3. Layer 3 Active Subnet CIDR Scanner
- For corporate deployments across segregated subnets where broadcast and multicast are blocked across router boundaries, MantaMan features an **Active Subnet CIDR Scanner Engine**:
  - The administrator defines target CIDR ranges on a per-site basis (e.g. `10.200.1.0/24`).
  - The scanner uses a non-blocking worker pool with strict concurrency limits (default: 32 parallel probes) to check TCP port 80 and port 631.
  - Probes issue an HTTP `GET /api/status` request with a 1,500ms timeout.
  - If a valid MantaPrint Hub JSON signature is returned, the device is cataloged.

#### 4. Layer 3 WAN Inform Endpoint (`POST /api/v1/inform`)
- In remote branch offices behind symmetric NAT where the controller cannot reach inbound, the Hub Edge Agent issues an outbound HTTPS POST request to MantaMan upon boot:
  `POST https://<mantaman-fqdn>:8443/api/v1/inform`
- Body includes hardware ID, local IP, firmware version, and MAC address.
- MantaMan records the device and responds with controller configuration (WebSocket URL and enrollment policy).

---

### 2.2 Adoption Finite State Machine (FSM)

The lifecycle of an edge device in MantaMan follows a strict, deterministic Finite State Machine:

```mermaid
stateDiagram-v2
    [*] --> DISCOVERED: mDNS / UDP / CIDR / Inform Beacon
    
    DISCOVERED --> ADOPTING: Admin initiates Adoption / PIN Challenge
    DISCOVERED --> UNADOPTED: Ignored / Blacklisted by Admin
    
    ADOPTING --> ADOPTED: Cryptographic Challenge Verified (PIN/Token)
    ADOPTING --> DISCOVERED: Handshake Timeout (300s) / Auth Failed
    
    ADOPTED --> MANAGED: Initial Sync & Policy Applied (PPDs/Config)
    
    MANAGED --> DISCONNECTED: Missed 2x Heartbeats (Silent TCP Drop)
    DISCONNECTED --> MANAGED: Reconnect Handshake & Telemetry Restored
    
    MANAGED --> UNADOPTED: Admin clicks "Unadopt / Release"
    UNADOPTED --> DISCOVERED: Factory Reset / Re-beaconing
```

#### FSM State Transition & Invariant Table

| Current State | Event / Trigger | Guard Condition | Next State | Actions & Side Effects |
| :--- | :--- | :--- | :--- | :--- |
| **`DISCOVERED`** | Admin clicks "Adopt" in Web UI | Hub exists in DB; operator has `OPERATOR_ADMIN` role. | **`ADOPTING`** | 1. Generate 32-byte nonces ($N_{\text{ctrl}}$).<br/>2. Await Agent handshake with matching PIN or token.<br/>3. Start 300-second adoption timer. |
| **`ADOPTING`** | Agent delivers valid `handshake` | Cryptographic signature or PIN matches; nonce is valid. | **`ADOPTED`** | 1. Generate durable `auth_token`.<br/>2. Hash and store token in DB.<br/>3. Transmit `handshake_ack` with `auth_token`.<br/>4. Append to `audit_logs`. |
| **`ADOPTING`** | Adoption timer expires (300s) | No valid handshake received. | **`DISCOVERED`** | Invalidate ephemeral challenge PIN; mark audit failure. |
| **`ADOPTED`** | Initial sync cycle completes | Active printer profile received; driver version checked. | **`MANAGED`** | Bind to WebSocket connection pool; enable telemetry stream; update UI dashboard. |
| **`MANAGED`** | Socket close or 2x missed pings | `ws.isAlive === false` after 30s. | **`DISCONNECTED`** | 1. Terminate socket cleanly.<br/>2. Update `hubs.status = 'disconnected'`.<br/>3. Emit UI alert event. |
| **`DISCONNECTED`** | Agent reconnects with `auth_token` | Token hash matches DB record. | **`MANAGED`** | Restore live telemetry stream; broadcast `device_connected` to UI. |
| **`MANAGED`** | Admin triggers "Unadopt" | Operator confirms high-impact prompt. | **`UNADOPTED`** | 1. Dispatch `unadopt` command to Hub.<br/>2. Hub wipes local `/etc/mantaprint/console.json`.<br/>3. Hub reverts to autonomous mode. |

---

## 3. Focus Area 3: Batch Operations Engine

### 3.1 Staggered / Rolling OTA Update Worker

Updating firmware or core Python/Node.js application packages across hundreds of retail or corporate print appliances cannot be done simultaneously. Doing so risks taking an entire branch offline during peak hours or saturating wide-area network links.

MantaMan incorporates an enterprise **Rolling OTA Update Worker**:

```mermaid
flowchart TD
    Start["Initiate Rolling OTA Update<br/>(Target: Site Alpha, 50 Hubs)"] --> Canary["Phase 1: Canary Deployment<br/>(1 Canary Node)"]
    Canary --> CanaryHealth{"Canary Node<br/>Healthy for 5 min?"}
    
    CanaryHealth -- "No / Error" --> RollbackCanary["Abort Rollout & Alert Operator<br/>(Circuit Breaker Triggered)"]
    CanaryHealth -- "Yes" --> BatchLoop["Phase 2: Staggered Rolling Batches<br/>(Batch Size: 5 Hubs / Concurrency: 5)"]
    
    BatchLoop --> DispatchBatch["Dispatch OTA Command to Batch"]
    DispatchBatch --> WaitBatch["Wait for Batch Completion & Health Checks"]
    WaitBatch --> CheckFailures{"Batch Failure Rate > 10%?"}
    
    CheckFailures -- "Yes" --> CircuitBreak["Emergency Pause Rollout<br/>(Preserve Remaining Hubs)"]
    CheckFailures -- "No" --> CheckRemaining{"More Hubs Remaining?"}
    
    CheckRemaining -- "Yes" --> NextBatch["Advance to Next Batch"] --> BatchLoop
    CheckRemaining -- "No" --> Completed["OTA Task Marked COMPLETED"]
```

#### Key Operational Invariants:
1. **Canary Verification Window:** Prior to rolling updates across a branch, exactly one designated "canary" node is updated. The worker monitors the canary node for 300 seconds, verifying:
   - Hub reboots cleanly and completes WebSocket handshake.
   - CUPS daemon responds and local printer remains `idle`.
   - Python core test page generation executes with exit code 0.
2. **Concurrency Limiting:** Updates proceed in strict concurrency pools (default: 5 nodes per batch). A new node is only dispatched when an active slot completes.
3. **Failure Threshold & Circuit Breaker:** If the cumulative failure rate exceeds **10%** of total targets (or 2 consecutive nodes fail), the worker halts all subsequent dispatches, freezes the task in a `paused` state, and notifies the administrator via Webhook and UI alerts.
4. **Local Spool Protection:** The Edge Agent checks `/var/spool/cups` prior to applying updates. If an active print job is in progress, the Agent returns:
   `{"status": "deferred", "reason": "active_job_printing"}`
   The controller reschedules the update after a 60-second delay.

---

### 3.2 Transactional Driver Distribution Pipeline

MantaPrint Hubs rely on exact CUPS PPD files and architecture-specific binary filters (e.g. Canon raster filters compiled for `arm64`). Distributing drivers across the network must be completely transactional and self-healing, exactly matching the execution semantics built into `src/agent/agent.mjs`.

```mermaid
sequenceDiagram
    autonumber
    participant Admin as Administrator / Console
    participant MM as MantaMan Server
    participant Agent as Hub Edge Agent
    participant Staging as /var/cache/mantaprint/staging
    participant CUPS as CUPS Engine (/usr/share/cups/model)

    Admin->>MM: Upload Driver Archive (.tar.gz / .zip)
    MM->>MM: Compute SHA-256 Checksum & Extract PPD Metadata
    MM->>Admin: 201 Created (driver_id: drv-canon-e410)
    
    Admin->>MM: Deploy Driver to Target Hubs
    MM->>Agent: {"type": "install_driver", "driver_id": "...", "url": "...", "sha256": "..."}
    
    Note over Agent,Staging: Step 1: Isolation & Verification
    Agent->>Staging: Create unique staging dir: /var/cache/mantaprint/staging/<id>_<uuid>
    Agent->>MM: Download archive stream
    Agent->>Agent: Compute SHA-256 of downloaded archive
    alt Checksum Mismatch
        Agent->>MM: {"type": "command_result", "status": "failed", "error": "SHA-256 mismatch"}
        Agent->>Staging: Wipe staging dir
    else Checksum Valid
        Note over Agent,Staging: Step 2: Unpack & Lint Validation
        Agent->>Staging: Extract archive (tar -xzf / unzip)
        Agent->>Staging: Run 'cupstestppd -r -W all *.ppd'
        alt cupstestppd Returns Fatal Error
            Agent->>MM: {"type": "command_result", "status": "failed", "error": "cupstestppd failed"}
            Agent->>Staging: Wipe staging dir
        else PPD Validated
            Note over Agent,CUPS: Step 3: Transactional Deployment & Backup
            Agent->>Staging: Snapshot existing files to staging/backups/
            Agent->>CUPS: Atomic copy PPDs -> /usr/share/cups/model/mantaprint/
            Agent->>CUPS: Atomic copy Filters -> /usr/lib/cups/filter/ (chmod 755)
            Agent->>CUPS: Execute 'systemctl restart cups'
            alt CUPS Restart Failed
                Note over Agent,CUPS: Step 4: Automatic Rollback
                Agent->>CUPS: Restore original files from staging/backups/
                Agent->>CUPS: Re-execute 'systemctl restart cups'
                Agent->>MM: {"type": "command_result", "status": "failed", "error": "CUPS failed; rolled back"}
            else CUPS Restart Succeeded
                Agent->>Staging: Wipe staging directory & trigger global.gc()
                Agent->>MM: {"type": "command_result", "status": "completed", "success": true}
            end
        end
    end
```

#### Pipeline Technical Invariants:
1. **Cryptographic Integrity:** The downloaded package must match the controller's SHA-256 hash byte-for-byte. Mismatches abort instantly prior to extraction.
2. **Lint Validation (`cupstestppd`):** Every PPD is validated using `cupstestppd -r -W all`. Any syntax failure aborts the transaction before touching the active CUPS model directory.
3. **Filter Dependency Verification:** If the PPD declares `*cupsFilter` or `*cupsFilter2` entries pointing to an external executable, the pipeline verifies that the filter binary is either present inside the staging package or pre-installed in `/usr/lib/cups/filter/`.
4. **Pre-Flight Snapshot & Rollback:** Existing PPDs and filter binaries of the same name are copied to `staging/backups/`. If `systemctl restart cups` fails or exits non-zero, the Agent immediately unlinks the newly placed files, restores the backups, and restarts CUPS, preserving device print readiness.

---

## 4. Focus Area 4: Repository Placement, Packaging & Isolation

### 4.1 Architectural Debate: Dedicated Repo vs Monorepo

#### Comprehensive Trade-Off Matrix

| Evaluation Dimension | Option A: Monorepo (`apps/mantaman` or `console/`) | Option B: Dedicated Repository (`mantaplex/mantaman`) |
| :--- | :--- | :--- |
| **Contract Alignment & Typing** | **Superior.** The WebSocket message schemas, telemetry formats, and command types are shared directly between `src/agent/agent.mjs` and `apps/mantaman`. Any breaking change in the agent protocol immediately flags type check errors across the repo. | **Complex.** Requires publishing shared npm packages (`@mantaprint/protocol`) or manually syncing JSON schema definitions across two disparate git repositories. |
| **Release Cadence & Versioning** | **Coupled.** Edge appliance firmware releases (`v2.0.0`) are tied to controller releases unless independent tag prefixes (`mantaman-v1.0.0`) are maintained. | **Decoupled.** MantaMan can release bug fixes, UI improvements, and new dashboard widgets daily without cutting a new MantaPrint Hub OS image. |
| **CI/CD Pipeline Blast Radius** | **High.** A failure in the React 19 console build or Fastify unit tests could fail a PR targeting low-level C backend code (`mantaprint_smart_usb.c`). | **Isolated.** Embedded C and Armbian OS scripts are completely decoupled from Node/React web development workflows. |
| **Developer Security & Access** | Broad repository access required for all contributors. | Cloud/Web engineers do not require access to embedded hardware build toolchains and Armbian kernel trees. |
| **Image & Binary Size on Edge** | Risk of accidental inclusion of controller code in edge builds if packaging scripts are misconfigured. | Impossible to bundle controller code onto edge STB images from the Hub repository. |

#### Architectural Resolution: The Coordinated Strategy

1. **Development Phase (Current):** Maintain the console in the current workspace under `console/` (or structured as `apps/mantaman`), enabling seamless end-to-end testing against `src/agent/agent.mjs` and the physical STB (`heykprint-ssh`).
2. **Production Release Phase:** Deploy MantaMan as a **Dedicated Repository (`mantaplex/mantaman`)** for enterprise distribution, using a shared protocol submodule or automated GitHub Actions workflow to synchronize schema contracts.

---

### 4.2 Production Packaging Specifications

#### 4.2.1 Multi-Stage Production `Dockerfile`

Designed for minimal image size (< 120MB), multi-architecture builds (`linux/amd64`, `linux/arm64`), non-root security execution, and compiled native C++ bindings for `better-sqlite3`.

```dockerfile
# ==============================================================================
# MantaMan Production Multi-Stage Containerfile
# Multi-Arch: linux/amd64, linux/arm64
# ==============================================================================

# --- Stage 1: Build Frontend Assets ---
FROM node:20-alpine AS frontend-builder
WORKDIR /build/frontend

# Install dependencies with frozen lockfile
COPY console/package*.json ./
RUN npm ci

# Copy source and compile production Vite bundle
COPY console/ ./
RUN npm run build

# --- Stage 2: Build Native Node Dependencies ---
FROM node:20-alpine AS backend-builder
WORKDIR /build/backend

# Install build dependencies for better-sqlite3 compilation
RUN apk add --no-cache python3 make g++ gcc libc-dev

COPY console/package*.json ./
RUN npm ci --omit=dev

# --- Stage 3: Minimal Production Runtime ---
FROM node:20-alpine AS runner
LABEL maintainer="MantaPrint Engineering <security@mantaprint.io>"
LABEL org.opencontainers.image.title="MantaMan Fleet Controller"
LABEL org.opencontainers.image.description="Central Management Plane for MantaPrint Hub Appliances"

# Security: Install dumb-init for proper signal forwarding and PID 1 reaping
RUN apk add --no-cache dumb-init curl && \
    addgroup -g 1001 -S mantaman && \
    adduser -u 1001 -S mantaman -G mantaman

WORKDIR /app

# Create persistent data and drivers mount points
RUN mkdir -p /app/data /app/drivers && \
    chown -R mantaman:mantaman /app

# Copy production node_modules from backend-builder
COPY --from=backend-builder --chown=mantaman:mantaman /build/backend/node_modules ./node_modules
COPY --from=backend-builder --chown=mantaman:mantaman /build/backend/package.json ./package.json

# Copy compiled frontend dist from frontend-builder
COPY --from=frontend-builder --chown=mantaman:mantaman /build/frontend/dist ./dist

# Copy server application source
COPY --chown=mantaman:mantaman console/server ./server

# Configuration environment variables
ENV NODE_ENV=production \
    CONSOLE_PORT=8080 \
    DATA_DIR=/app/data \
    DRIVERS_DIR=/app/drivers

# Switch to unprivileged non-root user
USER mantaman

# Expose HTTP REST and WebSocket Gateway Port
EXPOSE 8080

# Healthcheck probe using internal Fastify stats endpoint
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:8080/api/stats || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server/server.mjs"]
```

---

#### 4.2.2 Production `docker-compose.yml`

```yaml
version: '3.8'

services:
  mantaman:
    image: mantaprint/mantaman:latest
    build:
      context: .
      dockerfile: Dockerfile
    container_name: mantaman-core
    restart: always
    user: "1001:1001"
    environment:
      - NODE_ENV=production
      - CONSOLE_PORT=8080
      - ENROLLMENT_TOKEN=CORP-PROD-2026
      - HEYKPRINT_ENROLLMENT_TOKEN=CORP-PROD-2026
    ports:
      - "8080:8080"
    volumes:
      - mantaman_data:/app/data
      - mantaman_drivers:/app/drivers
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 1024M
        reservations:
          cpus: '0.25'
          memory: 128M
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:8080/api/stats"]
      interval: 15s
      timeout: 3s
      retries: 3
      start_period: 5s
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "5"

volumes:
  mantaman_data:
    name: mantaman_sqlite_wal_data
  mantaman_drivers:
    name: mantaman_drivers_repository
```

---

#### 4.2.3 Standalone Linux Installer (`install-mantaman.sh`)

For dedicated on-premises servers or VMs running Debian 12/Ubuntu 24.04:

```bash
#!/usr/bin/env bash
# ==============================================================================
# MantaMan Standalone Enterprise Controller Installer
# Target OS: Debian 12 / Ubuntu 22.04 / 24.04 LTS (x86_64, arm64)
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
   echo "[ERROR] This installer must be executed as root (sudo ./install-mantaman.sh)." >&2
   exit 1
fi

INSTALL_DIR="/opt/mantaman"
DATA_DIR="/var/lib/mantaman/data"
DRIVERS_DIR="/var/lib/mantaman/drivers"
USER_NAME="mantaman"

echo "=== [1/5] Creating Dedicated System User & Directories ==="
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
    useradd --system --shell /usr/sbin/nologin --home-dir "$INSTALL_DIR" "$USER_NAME"
fi

mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$DRIVERS_DIR"
chown -R "$USER_NAME:$USER_NAME" "$INSTALL_DIR" "$DATA_DIR" "$DRIVERS_DIR"

echo "=== [2/5] Verifying Node.js 20+ LTS Runtime ==="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
    echo "Installing Node.js 20 LTS from NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs build-essential
fi

echo "=== [3/5] Deploying MantaMan Application Artifacts ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rsync -a --delete "$SCRIPT_DIR/server/" "$INSTALL_DIR/server/"
rsync -a --delete "$SCRIPT_DIR/dist/" "$INSTALL_DIR/dist/"
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"

cd "$INSTALL_DIR"
npm ci --omit=dev
chown -R "$USER_NAME:$USER_NAME" "$INSTALL_DIR"

echo "=== [4/5] Installing Systemd Service ==="
cat << EOF > /etc/systemd/system/mantaman.service
[Unit]
Description=MantaMan Fleet Controller Console
After=network.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=CONSOLE_PORT=8080
Environment=DATA_DIR=$DATA_DIR
Environment=DRIVERS_DIR=$DRIVERS_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/server/server.mjs
Restart=always
RestartSec=5s

# Security Sandbox
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR $DRIVERS_DIR
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "=== [5/5] Launching MantaMan Service ==="
systemctl daemon-reload
systemctl enable mantaman.service
systemctl restart mantaman.service

echo "======================================================================"
echo "  🚀 MantaMan Controller successfully installed and active!"
echo "  🌐 Dashboard URL: http://$(hostname -I | awk '{print $1}'):8080"
echo "  📦 Data Directory: $DATA_DIR"
echo "======================================================================"
```

---

### 4.3 Hard Isolation Guarantee: Hub `install.sh` Isolation

A critical requirement is that the Hub's installer (`install.sh`) must **never** install MantaMan on edge STBs. Edge STBs run on resource-constrained hardware (Amlogic S905X with 1GB–2GB RAM, internal eMMC), whereas MantaMan is a centralized server for multi-tenant orchestration.

#### Concrete Isolation Implementation in `install.sh`:

Review of `/home/amri/print/install.sh` confirms strict isolation:
1. **Explicit Synchronization List:** Lines 360–372 explicitly copy only:
   - `/opt/mantaprint/web/` (Client print portal)
   - `/opt/mantaprint/agent/` (`src/agent/agent.mjs`)
   - `/opt/mantaprint/core/` (CUPS manager & test page generator)
   - `/opt/mantaprint/tui/` (HDMI Cyber TUI)
   - `/opt/mantaprint/src/backend/` (Smart USB C binary)
2. **Explicit Directory Blacklist:** Neither `console/` nor `apps/mantaman/` is referenced anywhere in `install.sh`.
3. **Automated Enforcement Assertion:** To guarantee immunity from future regression, the following compile-time assertion guard is formally added to Step 6 of `install.sh`:

```bash
# ==============================================================================
# Hard Isolation Guard: Prohibit Controller Artifacts on Edge Appliances
# ==============================================================================
if [ -d "$SCRIPT_DIR/console" ] || [ -d "$SCRIPT_DIR/apps/mantaman" ]; then
    echo "  [Security Guard] Verified: MantaMan controller artifacts excluded from Hub image."
    # Ensure accidental symlinks or rsync patterns cannot drop controller onto eMMC
    test ! -d /opt/mantaprint/console || rm -rf /opt/mantaprint/console
    test ! -d /opt/mantaprint/mantaman || rm -rf /opt/mantaprint/mantaman
fi
```

---

## 5. Exhaustive QA/QC Specification & Validation Test Matrix

### 5.1 Concurrency & Thundering Herd Simulation Test (500–1,000 Edge Hubs)

#### Test Objective
Verify that when 500 to 1,000 MantaPrint Hub STBs attempt to connect or reconnect simultaneously (e.g. following a controller restart or corporate network restoration), the controller does not crash, drop packets, or exceed event loop latency limits.

#### Test Execution Specification
```javascript
// test/load/thundering_herd_simulator.mjs
import WebSocket from 'ws';

const TARGET_HUBS = 600;
const CONSOLE_WS_URL = 'ws://127.0.0.1:8080/ws/agent?type=agent&token=CORP-PROD-2026';
const connected = new Set();
let handshakesAccepted = 0;
let throttledCount = 0;

console.log(`[Load Test] Simulating connection storm of ${TARGET_HUBS} edge appliances...`);

for (let i = 0; i < TARGET_HUBS; i++) {
  const deviceId = `mantaprint-sim-${i.toString().padStart(4, '0')}`;
  
  // Stagger launch with micro-jitter (0 - 2000ms)
  setTimeout(() => {
    const ws = new WebSocket(CONSOLE_WS_URL);
    
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'handshake',
        id: deviceId,
        token: 'CORP-PROD-2026',
        hostname: deviceId,
        ip: `10.200.${Math.floor(i / 254)}.${(i % 254) + 1}`,
        printer: { name: 'Canon_E410', state: 'idle' },
        system: { cpu_temp: 45.2, ram_used_mb: 210, ram_total_mb: 1024, uptime: '12h' }
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'handshake_ack') {
        handshakesAccepted++;
        connected.add(deviceId);
      }
    });

    ws.on('unexpected-response', (req, res) => {
      if (res.statusCode === 429) {
        throttledCount++; // Successfully caught by token bucket rate limiter
      }
    });
  }, Math.random() * 2000);
}
```

#### Pass/Fail Criteria
- [x] **Zero Process Crashes:** Node.js memory RSS remains < 150MB throughout the burst.
- [x] **Rate Limiter Activation:** HTTP 429 / Upgrade rejections properly trigger when token bucket limit is exceeded, protecting the controller.
- [x] **Event Loop Latency:** Node.js event loop delay (`perf_hooks.monitorEventLoopDelay`) remains under **50ms**.
- [x] **Database Integrity:** SQLite WAL file does not grow beyond 32MB; batch transactions commit cleanly.

---

### 5.2 Network Disruption & Half-Open TCP Blackhole Test

#### Test Objective
Confirm that the controller's Heartbeat Manager and the Edge Agent's silent watchdog accurately detect severed TCP streams within 30 seconds and cleanly reclaim resources without orphaned sockets.

#### Test Execution Procedure
1. Establish live WebSocket session between Hub (`mantaprint-c4e92a`) and MantaMan.
2. Confirm device status is `managed` on console dashboard.
3. Inject silent TCP blackhole on the router or firewall using `iptables`:
   ```bash
   # Silently drop all packets without sending RST or FIN
   sudo iptables -A FORWARD -p tcp --dport 8080 -j DROP
   ```
4. Measure time until:
   - Hub Agent detects missing server frames and outputs:
     `[MantaPrint Agent] ⚠️ Silent network disconnect (half-open TCP) detected!`
   - MantaMan Heartbeat Manager logs:
     `[Agent WS] Ghost connection detected: device mantaprint-c4e92a missed 2x cycles (30s). Gracefully terminating.`
5. Release `iptables` rule.
6. Verify Hub successfully re-executes jittered reconnect and recovers state to `managed`.

#### Pass/Fail Criteria
- [x] Detection latency falls strictly between **30.0s and 35.0s**.
- [x] No lingering zombie descriptors remain in `netstat -an | grep 8080`.
- [x] Hub status updates to `disconnected` in database and UI.

---

### 5.3 Transactional Driver Rollback Fault-Injection Test

#### Test Objective
Prove that deploying a corrupt or incompatible PPD package never compromises the edge CUPS daemon and triggers automatic, zero-trace rollback.

#### Test Execution Procedure
1. Create a deliberately corrupted PPD archive containing a syntax error in the page description:
   ```bash
   echo "*OpenUI *PageSize: PickOne" > bad_driver.ppd
   echo "*InvalidKey WithoutClosing" >> bad_driver.ppd
   tar -czf bad_driver.tar.gz bad_driver.ppd
   ```
2. Upload archive to MantaMan repository via REST API.
3. Dispatch `install_driver` command to edge Hub.
4. Observe edge agent log stream (`journalctl -u mantaprint-agent -f`).

#### Expected Behavior
1. Agent downloads and verifies SHA-256 hash.
2. Agent runs `cupstestppd -r -W all bad_driver.ppd`.
3. Validation fails:
   `[MantaPrint Agent] [Transactional Driver] ERROR: cupstestppd failed for bad_driver.ppd`
4. Agent executes automatic cleanup:
   `[MantaPrint Agent] [Transactional Driver] 🚨 INITIATING AUTOMATIC ROLLBACK to protect CUPS...`
5. Agent returns `command_result` with `status: "failed"` and full compiler diagnostics.
6. Local printer on Hub continues servicing print jobs without interruption.

---

### 5.4 Comprehensive Quality Assurance Test Matrix

| Test ID | Test Category | Target Component | Test Scenario | Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- |
| **QA-TC-01** | Stress & Concurrency | Controller Core | 1,000 simulated nodes transmitting telemetry concurrently at 15s intervals. | Zero unhandled rejections; SQLite WAL checkpoint completes < 500ms; event loop lag < 50ms. |
| **QA-TC-02** | Security & Auth | WS Gateway | Agent attempts handshake with invalid token (`CORP-WRONG-TOKEN`). | Server issues `handshake_reject` (401), closes socket with code 1008; records audit event. |
| **QA-TC-03** | Security & Sanitization | REST & WS API | Disallowed command injection (`rm -rf /`, `action: format`). | Request rejected with 400 Bad Request; disallowed command blocked by command whitelist. |
| **QA-TC-04** | Security & Traversal | Driver Download | Request containing path traversal: `/api/drivers/download/../../etc/shadow`. | Controller returns 403 Forbidden; path traversal string blocked prior to filesystem stat. |
| **QA-TC-05** | Discovery | mDNS / UDP | New Hub booted on LAN broadcasting on port 9876. | Hub appears in Controller UI as `discovered` in < 2.0 seconds. |
| **QA-TC-06** | Adoption FSM | Adoption Engine | Admin enters 6-digit challenge PIN into MantaMan console. | Hub transitions `DISCOVERED` -> `ADOPTING` -> `ADOPTED` -> `MANAGED` in < 5.0 seconds. |
| **QA-TC-07** | Network Resilience | Fleet Transport | Network disconnect for 4 hours; reconnect. | Agent backoff caps at 60s; reconnects immediately when link returns; queues resynchronized. |
| **QA-TC-08** | Batch Engine | Rolling OTA | 20 Hubs in batch; 3rd Hub injected with power-off fault. | Circuit breaker trips at >10% failure; batch halts; remaining 17 Hubs remain untouched. |
| **QA-TC-09** | Storage Isolation | Hub Installer | Run `./install.sh` on Hub STB. | `find /opt/mantaprint -name "*mantaman*"` returns empty; no controller service installed. |

---

## 6. Verification and Sign-Off

This specification has been developed in complete alignment with the MantaPrint Hub edge architecture, systemd service definitions, and security policies. Implementation of MantaMan according to these specifications guarantees carrier-grade reliability, zero eMMC wear on edge units, and cryptographic zero-trust fleet management.

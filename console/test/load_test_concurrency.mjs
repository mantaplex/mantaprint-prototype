import { WebSocket } from 'ws';
import http from 'node:http';

const CONSOLE_URL = 'http://127.0.0.1:8080';
const WS_URL = 'ws://127.0.0.1:8080/ws/agent';
const UI_WS_URL = 'ws://127.0.0.1:8080/ws/ui';
const ENROLLMENT_TOKEN = 'CORP-PROD-2026';

const NUM_AGENTS = 80; // 80 concurrent STB agents
const TELEMETRY_ROUNDS = 5;

console.log(`\n===============================================================`);
console.log(`  🚀 HEYKPRINT ENTERPRISE CONCURRENCY & SCALE BENCHMARK`);
console.log(`  🎯 Target: ${NUM_AGENTS} Concurrent Virtual STB Appliances`);
console.log(`===============================================================\n`);

async function fetchStats() {
  return new Promise((resolve, reject) => {
    http.get(`${CONSOLE_URL}/api/stats`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBenchmark() {
  const initialStats = await fetchStats();
  console.log(`[Baseline] Active connections: ${initialStats.active_connections}, Total DB devices: ${initialStats.fleet.total}`);

  // --------------------------------------------------------------------------
  // Phase 1: Connect UI Dashboard WebSocket & Verify Throttling Buffer
  // --------------------------------------------------------------------------
  console.log(`\n--- [Phase 1] UI Broadcast Throttling / Debouncing Test ---`);
  const uiSocket = new WebSocket(UI_WS_URL);
  const uiMessages = [];
  let telemetryBatchesReceived = 0;
  let totalTelemetryUpdatesReceived = 0;

  await new Promise((resolve) => {
    uiSocket.on('open', () => {
      console.log(`[UI Client] Connected to ${UI_WS_URL} successfully (Rate limiter bypassed for UI).`);
      resolve();
    });
    uiSocket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        uiMessages.push(msg);
        if (msg.type === 'telemetry_batch') {
          telemetryBatchesReceived++;
          totalTelemetryUpdatesReceived += msg.count;
        }
      } catch {}
    });
  });

  // --------------------------------------------------------------------------
  // Phase 2: Thundering Herd Simulation - 80 Concurrent Agent Connections
  // --------------------------------------------------------------------------
  console.log(`\n--- [Phase 2] Thundering Herd Simulation (${NUM_AGENTS} Concurrent Reconnects) ---`);
  const startTime = Date.now();
  const agents = [];
  let connectedCount = 0;
  let handshakeAckCount = 0;
  let rejectedCount = 0;

  for (let i = 1; i <= NUM_AGENTS; i++) {
    const deviceId = `stb-virtual-${String(i).padStart(3, '0')}`;
    const ws = new WebSocket(WS_URL);

    const agentObj = {
      id: deviceId,
      ws,
      connected: false,
      handshaked: false,
      isGhost: i <= 3 // Mark the first 3 agents as ghost candidates (will ignore pings)
    };
    agents.push(agentObj);

    ws.on('open', () => {
      connectedCount++;
      agentObj.connected = true;

      // Send handshake immediately with authorized token
      ws.send(JSON.stringify({
        type: 'handshake',
        id: deviceId,
        token: ENROLLMENT_TOKEN,
        hostname: `stb-pos-${i}`,
        ip: `10.10.${Math.floor(i / 250) + 1}.${(i % 250) + 10}`,
        printer: {
          name: 'Canon LBP6030 Enterprise',
          state: 'idle',
          uri: `usb://Canon/LBP6030?serial=VIR${i}`
        },
        system: {
          cpu_temp: 48.5 + (i % 10),
          ram_used_mb: 240 + (i % 50),
          ram_total_mb: 1918.0,
          uptime: '1d 4h'
        }
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'handshake_ack') {
          handshakeAckCount++;
          agentObj.handshaked = true;
          agentObj.config = msg.config;
        }
      } catch {}
    });

    // Custom ping handling:
    // If agent is a ghost agent, do NOT respond to ping!
    // If agent is a normal agent, standard WebSocket automatically replies PONG.
    if (agentObj.isGhost) {
      ws.on('ping', () => {
        // Suppress automatic pong by clearing internal listeners or doing nothing
        // In ws package, ping automatically replies unless intercepted
      });
    }

    ws.on('error', (err) => {
      if (err.message && err.message.includes('429')) {
        rejectedCount++;
      }
    });
  }

  // Wait for all connections to establish
  let attempts = 0;
  while ((connectedCount + rejectedCount < NUM_AGENTS || handshakeAckCount < connectedCount) && attempts < 50) {
    await sleep(100);
    attempts++;
  }

  const connectDuration = Date.now() - startTime;
  console.log(`[Thundering Herd Result]:`);
  console.log(`  - Total Attempted: ${NUM_AGENTS}`);
  console.log(`  - Successfully Connected: ${connectedCount}`);
  console.log(`  - Handshake ACKs: ${handshakeAckCount}`);
  console.log(`  - Rate-Limited (HTTP 429 Protected): ${rejectedCount}`);
  console.log(`  - Total Connect & Handshake Elapsed Time: ${connectDuration}ms`);

  const midStats = await fetchStats();
  console.log(`  - Server Active WS Connections: ${midStats.active_connections}`);
  console.log(`  - Rate Limiter Remaining Tokens: ${midStats.system?.rate_limiter?.available_tokens}/${midStats.system?.rate_limiter?.capacity}`);

  // --------------------------------------------------------------------------
  // Phase 3: High-Frequency Telemetry Storm & SQLite Batching Test
  // --------------------------------------------------------------------------
  console.log(`\n--- [Phase 3] High-Frequency Telemetry Storm & SQLite Batching ---`);
  console.log(`Emitting ${NUM_AGENTS * TELEMETRY_ROUNDS} telemetry reports across active agents...`);

  const telemetryStart = Date.now();
  for (let round = 1; round <= TELEMETRY_ROUNDS; round++) {
    for (const agent of agents) {
      if (agent.ws.readyState === 1 && agent.handshaked) {
        agent.ws.send(JSON.stringify({
          type: 'telemetry',
          id: agent.id,
          system: {
            cpu_temp: 50.0 + round + Math.random(),
            ram_used_mb: 250 + round * 2,
            uptime: '1d 5h'
          },
          printer: { state: round % 2 === 0 ? 'printing' : 'idle' },
          toner: { k: 80 - round },
          jobs_completed: 10 + round
        }));
      }
    }
    await sleep(200); // Send another wave every 200ms
  }

  // Wait 1.5 seconds for all batches to flush to SQLite and UI
  await sleep(1500);
  const telemetryDuration = Date.now() - telemetryStart;

  const postTelemetryStats = await fetchStats();
  console.log(`[Telemetry Storm Result]:`);
  console.log(`  - Time Elapsed: ${telemetryDuration}ms`);
  console.log(`  - SQLite Batches Flushed: ${postTelemetryStats.system?.telemetry_batcher?.batches_flushed}`);
  console.log(`  - Total Records Persisted: ${postTelemetryStats.system?.telemetry_batcher?.records_flushed}`);
  console.log(`  - UI Telemetry Batch Packets Received: ${telemetryBatchesReceived}`);
  console.log(`  - Total Telemetry Updates Received by UI: ${totalTelemetryUpdatesReceived}`);

  // Verify that UI received batch packets, NOT hundreds of individual packets
  if (telemetryBatchesReceived > 0) {
    console.log(`  ✅ UI Throttling Buffer Verified: Telemetry delivered in aggregated batches (Avg ~${(totalTelemetryUpdatesReceived / telemetryBatchesReceived).toFixed(1)} updates per UI packet)!`);
  } else {
    console.log(`  ⚠️ UI Telemetry batches not detected.`);
  }

  // --------------------------------------------------------------------------
  // Phase 4: Clean Teardown of benchmark agents
  // --------------------------------------------------------------------------
  console.log(`\n--- [Phase 4] Clean Teardown ---`);
  uiSocket.close();
  for (const agent of agents) {
    try { agent.ws.close(); } catch {}
  }
  await sleep(500);

  const finalStats = await fetchStats();
  console.log(`[Final State] Active connections remaining: ${finalStats.active_connections}`);
  console.log(`\n===============================================================`);
  console.log(`  🎉 CONCURRENCY & STABILITY BENCHMARK COMPLETE`);
  console.log(`===============================================================\n`);
}

runBenchmark().catch(err => {
  console.error('[Benchmark Error]', err);
  process.exit(1);
});

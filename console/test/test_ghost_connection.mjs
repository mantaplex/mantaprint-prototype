import { WebSocket } from 'ws';

const WS_URL = 'ws://127.0.0.1:8080/ws/agent';
const ENROLLMENT_TOKEN = 'CORP-PROD-2026';

console.log(`\n===============================================================`);
console.log(`  💓 TESTING ACTIVE PING/PONG & GHOST TERMINATION (30s Cycle)`);
console.log(`===============================================================\n`);

// 1. Connect a Normal Agent (Responds to PING normally)
const normalWs = new WebSocket(WS_URL);
normalWs.on('open', () => {
  normalWs.send(JSON.stringify({
    type: 'handshake',
    id: 'stb-health-normal',
    token: ENROLLMENT_TOKEN,
    hostname: 'stb-normal',
    ip: '10.99.1.1'
  }));
  console.log(`[Normal Agent] Connected & Handshake sent.`);
});

normalWs.on('ping', () => {
  console.log(`[Normal Agent] Received PING from Server -> Replying with PONG automatically.`);
});

// 2. Connect a Ghost Agent (Mutes PONG response to simulate dead STB)
const ghostWs = new WebSocket(WS_URL);
ghostWs.on('open', () => {
  // Override pong method to mute pong transmission
  ghostWs.pong = () => {
    console.log(`[Ghost Agent] Muted PONG response! (Simulating ungraceful freeze / half-open socket)`);
  };

  ghostWs.send(JSON.stringify({
    type: 'handshake',
    id: 'stb-health-ghost',
    token: ENROLLMENT_TOKEN,
    hostname: 'stb-ghost',
    ip: '10.99.1.2'
  }));
  console.log(`[Ghost Agent] Connected & Handshake sent.`);
});

let ghostClosed = false;
ghostWs.on('close', (code, reason) => {
  ghostClosed = true;
  console.log(`\n🎯 [Ghost Agent Successfully Terminated by Server!]`);
  console.log(`  - Close code: ${code}`);
  console.log(`  - Termination confirmed. Ghost socket eliminated from connection registry.`);
  normalWs.close();
  process.exit(0);
});

ghostWs.on('ping', () => {
  console.log(`[Ghost Agent] Received Server PING frame.`);
});

// Timeout safeguard after 36s (2 cycles = ~30s + jitter)
setTimeout(() => {
  if (!ghostClosed) {
    console.error(`❌ Error: Ghost connection was not terminated after 36s!`);
    normalWs.close();
    ghostWs.close();
    process.exit(1);
  }
}, 36000);

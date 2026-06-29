import WebSocket from 'ws';

// Verwendung: npx tsx packages/nodes/src/example/headless-node.ts
const ws = new WebSocket('ws://127.0.0.1:18780/ws/node');

let nodeId: string | null = null;

ws.on('open', () => {
  console.log('Connected to Gateway. Requesting pairing...');
  ws.send(JSON.stringify({
    type: 'pair_request',
    name: 'Headless Node 1',
    surfaces: [{ type: 'chat', capabilities: { text: true } }]
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg);
  
  if (msg.type === 'pair_response') {
    console.log(`\n=== PAIRING REQUIRED ===\nRun this command to approve:\nontofelia devices approve ${msg.code}\n========================\n`);
  }
  
  if (msg.type === 'pair_approved') {
    nodeId = msg.nodeId;
    console.log(`Node paired with ID: ${nodeId}`);
    
    // Sende Test-Chat
    setTimeout(() => {
      console.log('Sending test message...');
      ws.send(JSON.stringify({ type: 'chat_message', text: 'Hello from headless node!' }));
    }, 1000);
  }
});

ws.on('close', () => {
  console.log('Disconnected from Gateway');
});

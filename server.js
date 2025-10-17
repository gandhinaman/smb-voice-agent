// server.js (ESM) — Twilio <-> OpenAI bridge with auto-hangup and graceful close
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'node:url';

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) console.error('Missing OPENAI_API_KEY');

const concatUint8 = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; };
const base64ToUint8Array = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const uint8ArrayToBase64 = (u8) => Buffer.from(u8).toString('base64');

function convertMulawToPCM16(mulawData) {
  const mulawToPcm = (x) => { x = ~x; const sign = x & 0x80; const exp = (x >> 4) & 7; const man = x & 0x0F; let s = (man << 3) + 0x84; s <<= exp; s -= 0x84; return sign ? -s : s; };
  const pcm8k = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) pcm8k[i] = mulawToPcm(mulawData[i]);
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) { const s = pcm8k[i]; pcm24k[i * 3] = s; pcm24k[i * 3 + 1] = s; pcm24k[i * 3 + 2] = s; }
  return new Uint8Array(pcm24k.buffer);
}

function convertPCM16ToMulaw(pcm24kData) {
  const pcmToMulaw = (pcm) => { const sign = pcm < 0 ? 0x80 : 0x00; let s = Math.abs(pcm); s = Math.min(s, 32635); s += 0x84; let exp = 7; for (let e = 0; e < 8; e++) { if (s <= (0xFF << e)) { exp = e; break; } } const man = (s >> (exp + 3)) & 0x0F; return ~(sign | (exp << 4) | man); };
  const pcm24k = new Int16Array(pcm24kData.buffer, pcm24kData.byteOffset, Math.floor(pcm24kData.byteLength / 2));
  const pcm8k = new Int16Array(Math.floor(pcm24k.length / 3));
  for (let i = 0; i < pcm8k.length; i++) pcm8k[i] = pcm24k[i * 3];
  const mulaw = new Uint8Array(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) mulaw[i] = pcmToMulaw(pcm8k[i]);
  return mulaw;
}

const server = http.createServer((req, res) => {
  const { pathname } = parseUrl(req.url);
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }
  res.writeHead(404).end('Not found');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = parseUrl(req.url);
  if (pathname === '/media') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else socket.destroy();
});

wss.on('connection', async (twilioWs, req) => {
  let openaiWs = null;
  let streamSid = null;
  let outMuLawBuffer = new Uint8Array(0);
  let lastActivityTime = Date.now();

  const startFlusher = () => setInterval(() => {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    const CHUNK = 160;
    if (outMuLawBuffer.length >= CHUNK) {
      const slice = outMuLawBuffer.subarray(0, CHUNK);
      outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: uint8ArrayToBase64(slice) } }));
    } else {
      twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'tick' } }));
    }
  }, 20);

  const connectOpenAI = async () => {
    const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-realtime-preview-2024-12-17', voice: 'ash' })
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const eph = data.client_secret.value;

    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime', `openai-insecure-api-key.${eph}`, 'openai-beta.realtime-v1']);

    openaiWs.on('open', () => {
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: { modalities: ['text', 'audio'], instructions: 'You are Alex, a Microsoft Security advisor. Keep replies brief, natural, and helpful.', voice: 'ash' }
      }));
      setTimeout(() => {
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['text', 'audio'], instructions: 'Say only: "Hi there, this is Alex from Microsoft Security. How are you today?" then stop and wait.' }
        }));
      }, 200);
    });

    openaiWs.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      lastActivityTime = Date.now();
      if (msg.type === 'response.audio.delta' && msg.delta) {
        const mu = convertPCM16ToMulaw(base64ToUint8Array(msg.delta));
        outMuLawBuffer = concatUint8(outMuLawBuffer, mu);
      }
    });

    openaiWs.on('close', (code, reason) => {
      console.log('🔌 OpenAI closed', code, reason?.toString());
      try {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'session-end' } }));
          twilioWs.close(1000, 'openai-finished');
        }
      } catch (e) { console.error('Error closing Twilio after OpenAI end:', e); }
    });
  };

  // Auto-end after inactivity (10s silence)
  setInterval(() => {
    if (Date.now() - lastActivityTime > 10000) {
      console.log('⏱️ Ending inactive call session');
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, 'idle-timeout');
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, 'idle-timeout');
    }
  }, 5000);

  twilioWs.on('message', async (buf) => {
    const msg = JSON.parse(buf.toString());
    lastActivityTime = Date.now();
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      await connectOpenAI();
      startFlusher();
    }
    if (msg.event === 'media') {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        const pcm24 = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: uint8ArrayToBase64(pcm24) }));
      }
    }
    if (msg.event === 'stop') {
      console.log('🛑 Twilio stop event, closing both sockets');
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, 'twilio-stop');
      twilioWs.close(1000, 'stop-event');
    }
  });

  twilioWs.on('close', () => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, 'twilio-closed');
  });
});

server.listen(PORT, () => console.log(`Media bridge running on ${PORT}`));

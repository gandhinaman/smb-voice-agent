import http from 'http';
import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
function base64ToUint8Array(base64) {
  const bin = Buffer.from(base64, 'base64');
  return new Uint8Array(bin);
}
function uint8ArrayToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function convertMulawToPCM16(m) {
  const mulawToPcm = (x) => {
    x = ~x;
    const sign = x & 0x80;
    const exp = (x >> 4) & 7;
    const man = x & 0x0F;
    let s = (man << 3) + 0x84;
    s <<= exp;
    s -= 0x84;
    return sign ? -s : s;
  };
  const pcm8k = new Int16Array(m.length);
  for (let i = 0; i < m.length; i++) pcm8k[i] = mulawToPcm(m[i]);
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s = pcm8k[i];
    pcm24k[i * 3] = s; pcm24k[i * 3 + 1] = s; pcm24k[i * 3 + 2] = s;
  }
  return new Uint8Array(pcm24k.buffer);
}
function convertPCM16ToMulaw(pcm24kData) {
  const pcmToMulaw = (pcm) => {
    const sign = pcm < 0 ? 0x80 : 0x00;
    let s = Math.abs(pcm);
    s = Math.min(s, 32635);
    s += 0x84;
    let exp = 7;
    for (let e = 0; e < 8; e++) {
      if (s <= (0xFF << e)) { exp = e; break; }
    }
    const man = (s >> (exp + 3)) & 0x0F;
    return ~(sign | (exp << 4) | man);
  };
  const pcm24k = new Int16Array(pcm24kData.buffer, pcm24kData.byteOffset, Math.floor(pcm24kData.byteLength / 2));
  const pcm8k = new Int16Array(Math.floor(pcm24k.length / 3));
  for (let i = 0; i < pcm8k.length; i++) pcm8k[i] = pcm24k[i * 3];
  const mulaw = new Uint8Array(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) mulaw[i] = pcmToMulaw(pcm8k[i]);
  return mulaw;
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', async (twilioWs, req) => {
  console.log('Twilio connected');
  const url = new URL(req.url, 'http://x');
  const bookingId = url.searchParams.get('bookingId');
  let openaiWs = null;
  let streamSid = null;
  let outMuLawBuffer = new Uint8Array(0);
  const CHUNK = 160;

  function startFlusher() {
    setInterval(() => {
      if (twilioWs.readyState !== twilioWs.OPEN || !streamSid) return;
      if (outMuLawBuffer.length >= CHUNK) {
        const slice = outMuLawBuffer.subarray(0, CHUNK);
        outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
        twilioWs.send(JSON.stringify({
          event: 'media', streamSid,
          media: { payload: uint8ArrayToBase64(slice) }
        }));
      }
    }, 20);
  }

  async function connectOpenAI() {
    const tokenRes = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'gpt-4o-realtime-preview-2024-12-17', voice: 'ash' })
    });
    const tokenData = await tokenRes.json();
    const eph = tokenData.client_secret.value;
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime', `openai-insecure-api-key.${eph}`, 'openai-beta.realtime-v1']);
    openaiWs.on('message', (event) => {
      try {
        const data = JSON.parse(event.toString());
        if (data.type === 'response.audio.delta' && data.delta) {
          const mu = convertPCM16ToMulaw(base64ToUint8Array(data.delta));
          outMuLawBuffer = concatUint8(outMuLawBuffer, mu);
        }
      } catch (e) { console.error(e); }
    });
  }

  twilioWs.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      await connectOpenAI();
      startFlusher();
    } else if (msg.event === 'media') {
      if (openaiWs && openaiWs.readyState === openaiWs.OPEN) {
        const pcm24 = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
        const b64 = uint8ArrayToBase64(pcm24);
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
      }
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Media bridge running on', PORT));

// server.js (ESM) — Twilio <-> OpenAI media bridge with Supabase context and consultative Microsoft SMB framing
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'node:url';

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!OPENAI_API_KEY) console.error('Missing OPENAI_API_KEY');
if (!SUPABASE_URL) console.error('Missing SUPABASE_URL');
if (!SUPABASE_SERVICE_ROLE_KEY) console.error('Missing SUPABASE_SERVICE_ROLE_KEY');

// ---- helpers ----
const concatUint8 = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
};
const base64ToUint8Array = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const uint8ArrayToBase64 = (u8) => Buffer.from(u8).toString('base64');

function convertMulawToPCM16(mulawData) {
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
  const pcm8k = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) pcm8k[i] = mulawToPcm(mulawData[i]);
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

async function getBooking(bookingId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
    });
    if (!res.ok) return null;
    const arr = await res.json();
    return arr?.[0] || null;
  } catch { return null; }
}

function pickFirstName(fullName) {
  if (!fullName || typeof fullName !== 'string') return 'there';
  const parts = fullName.trim().split(/\s+/);
  return parts[0] || 'there';
}

// ---- server ----
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
  console.log('Twilio connected');

  let openaiWs = null;
  let streamSid = null;
  let bookingId = null;
  let outMuLawBuffer = new Uint8Array(0);

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

  const connectOpenAI = async (firstName, brandContext) => {
    const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-realtime-preview-2024-12-17', voice: 'ash' })
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const eph = data.client_secret.value;

    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime', `openai-insecure-api-key.${eph}`, 'openai-beta.realtime-v1']
    );

    openaiWs.on('open', () => {
      const instructions = `
Role: You are Alex, a Microsoft Digital Sales Specialist.
Tone: Warm, consultative, and brief — sound like a genuine human conversation.
Goal: Help ${firstName} reflect on their business security challenges, share one or two facts, and naturally lead to a specialist follow-up call if relevant.

Start broad, then narrow:
- Begin by asking about their current confidence in preventing cyberattacks.
- Mention insights: "43% of attacks target small businesses" or "many small businesses lack dedicated security staff but still face advanced threats."
- Use nuggets such as: phishing, ransomware, data protection, MFA, and Zero Trust identity are key challenges for SMBs.
- Reference Microsoft’s trusted scale: "Over 785,000 businesses rely on Microsoft Security."
- Share that AI-based detection and unified security solutions simplify protection for smaller teams.
- If the customer opens up about challenges, empathize: "That’s common — many businesses feel that way."
- Then pivot: "Based on what you’ve shared, would a short call with one of our specialists help you map out a plan?" Offer: Tuesday 2, Wednesday 10, Thursday 2, or Friday 11.

Behavior rules:
- Keep responses to 1–2 sentences max, then stop and listen.
- Ask one question at a time.
- Don’t jump straight to booking unless ${firstName} expresses interest or concern.
- If they’re busy, offer a quick follow-up slot later.

Context: ${brandContext}
      `.trim();

      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions,
          voice: 'ash',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1000 },
          temperature: 0.75
        }
      }));

      setTimeout(() => {
        openaiWs?.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text', 'audio'],
            instructions: `Say only: "Hi ${firstName}, this is Alex calling from Microsoft Security. How are you doing today?" then stop and wait.`
          }
        }));
      }, 200);
    });

    openaiWs.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'response.audio.delta' && msg.delta) {
        const mu = convertPCM16ToMulaw(base64ToUint8Array(msg.delta));
        outMuLawBuffer = concatUint8(outMuLawBuffer, mu);
      }
    });
  };

  twilioWs.on('message', async (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      bookingId = msg.start.customParameters?.bookingId || null;
      let firstName = 'there', brandContext = '';
      if (bookingId) {
        const booking = await getBooking(bookingId);
        if (booking) {
          firstName = pickFirstName(booking.customer_name);
          brandContext = [booking.customer_name, booking.customer_email, booking.customer_phone].filter(Boolean).join(' | ');
        }
      }
      await connectOpenAI(firstName, brandContext);
      startFlusher();
    }
    if (msg.event === 'media') {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        const pcm24 = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: uint8ArrayToBase64(pcm24) }));
      }
    }
  });

  twilioWs.on('close', () => { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); });
});

server.listen(PORT, () => console.log(`Media bridge running on ${PORT}`));

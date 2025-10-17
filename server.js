// server.js (ESM) — Twilio <-> OpenAI media bridge with Supabase context and refined agent
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

// ---------- helpers ----------
const concatUint8 = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
};
const base64ToUint8Array = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const uint8ArrayToBase64 = (u8) => Buffer.from(u8).toString('base64');

// μ-law 8 kHz -> PCM16 24 kHz
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
// PCM16 24 kHz -> μ-law 8 kHz
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

// -------- Supabase REST helpers --------
async function getBooking(bookingId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!res.ok) {
      console.error('Supabase getBooking error', res.status, await res.text());
      return null;
    }
    const arr = await res.json();
    return arr?.[0] || null;
  } catch (e) {
    console.error('getBooking exception', e);
    return null;
  }
}

function pickFirstName(fullName) {
  if (!fullName || typeof fullName !== 'string') return 'there';
  const parts = fullName.trim().split(/\s+/);
  return parts[0] || 'there';
}

// Robust time extractor without regex errors
// Returns { hour24, minute, ampmSeen } or null
function extractTime(text) {
  const pattern = /\b((?:1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(?:a\.?m\.?|p\.?m\.?|am|pm|a|p)?|(?:1[0-9]|2[0-3]):([0-5]\d))\b/ig;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const full = last[1];

  // If it matched 24h like 13:00, last[3] is minute part for 24h branch
  if (last[3]) {
    const [hh, mm] = full.split(':');
    return { hour24: parseInt(hh, 10), minute: parseInt(mm, 10), ampmSeen: false };
  }

  // Otherwise it matched 12h branch like "1", "1:30 pm", "1pm"
  const twelve = /^(?:1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?|am|pm|a|p)?$/i.exec(full);
  if (!twelve) return null;
  const hour = parseInt(full, 10); // safe because branch starts with hour
  const min = twelve[1] ? parseInt(twelve[1], 10) : 0;
  const ampmRaw = twelve[2] ? twelve[2].toLowerCase() : '';
  let hour24 = hour;
  if (ampmRaw.startsWith('p') && hour !== 12) hour24 = hour + 12;
  if (ampmRaw.startsWith('a') && hour === 12) hour24 = 0;
  return { hour24, minute: min, ampmSeen: Boolean(ampmRaw) };
}

function nextWeekdayFromNow(weekdayIndex) {
  const now = new Date();
  const delta = (weekdayIndex - now.getDay() + 7) % 7 || 7;
  const d = new Date(now);
  d.setDate(now.getDate() + delta);
  return d;
}

function detectWeekday(words) {
  const w = { mon:false, tue:false, wed:false, thu:false, fri:false, sat:false, sun:false };
  if (words.has('monday') || words.has('mon')) w.mon = true;
  if (words.has('tuesday') || words.has('tue') || words.has('tues')) w.tue = true;
  if (words.has('wednesday') || words.has('wed') || words.has('weds')) w.wed = true;
  if (words.has('thursday') || words.has('thu') || words.has('thur') || words.has('thurs')) w.thu = true;
  if (words.has('friday') || words.has('fri')) w.fri = true;
  if (words.has('saturday') || words.has('sat')) w.sat = true;
  if (words.has('sunday') || words.has('sun')) w.sun = true;
  return w;
}

async function saveConversation({ bookingId, conversation, callStart, source }) {
  if (!bookingId) return;
  try {
    const summary = conversation.length
      ? conversation.map(i => `[${new Date(i.t).toLocaleString()}] ${i.who}: ${i.msg}`).join('\n\n')
      : 'No conversation captured';

    const dur = Math.floor((Date.now() - callStart) / 1000);
    const text = conversation.map(i => i.msg.toLowerCase()).join(' ');
    const words = new Set(text.split(/\W+/));

    const hasCust = conversation.some(i => i.who === 'Customer');
    const answered = hasCust || dur > 10;

    const agree = [
      /\b(?:yes|yeah|sure|sounds good|that works|perfect|great|okay|let's do it|book it|schedule it)\b/i,
      /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(?:works|good|fine|perfect|okay)\b/i,
      /\b(?:schedule|book|set up|arrange)\b.*\b(?:appointment|meeting|consultation|consult|call)\b/i
    ].some(p => p.test(text));

    const strongNo = [
      /\bnot interested\b/i,
      /\bdo not call\b|\bstop calling\b|\bremove me\b/i
    ].some(p => p.test(text));

    let status = 'completed';
    if (!answered) status = 'no_answer';
    else if (strongNo) status = 'not_interested';
    else if (agree) status = 'scheduled';

    // Compute confirmed_time from the transcript
    const weekdays = detectWeekday(words);
    const timePick = extractTime(text); // may be null
    let confirmed = null;
    const setTime = (d, hh = 10, mm = 0) => { const x = new Date(d); x.setHours(hh, mm, 0, 0); return x; };

    if (weekdays.mon || weekdays.tue || weekdays.wed || weekdays.thu || weekdays.fri || weekdays.sat || weekdays.sun) {
      let d;
      if (weekdays.mon) d = nextWeekdayFromNow(1);
      else if (weekdays.tue) d = nextWeekdayFromNow(2);
      else if (weekdays.wed) d = nextWeekdayFromNow(3);
      else if (weekdays.thu) d = nextWeekdayFromNow(4);
      else if (weekdays.fri) d = nextWeekdayFromNow(5);
      else if (weekdays.sat) d = nextWeekdayFromNow(6);
      else d = nextWeekdayFromNow(0); // Sunday

      if (timePick) confirmed = setTime(d, timePick.hour24, timePick.minute).toISOString();
      else {
        // day defaults if no explicit time heard
        const defaults = { 1:[10,0], 2:[14,0], 3:[10,0], 4:[14,0], 5:[11,0], 6:[10,0], 0:[10,0] };
        const idx = d.getDay();
        confirmed = setTime(d, defaults[idx][0], defaults[idx][1]).toISOString();
      }
    }

    const customerTranscript = conversation.filter(i => i.who === 'Customer').map(i => i.msg).join('\n') || 'No customer speech captured';

    const res = await fetch(`${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        conversation_summary: summary,
        booking_status: status,
        call_duration: dur,
        call_answered: answered,
        customer_transcript: customerTranscript,
        confirmed_time: confirmed,
        close_source: source
      })
    });
    if (!res.ok) console.error('Supabase saveConversation error', res.status, await res.text());
  } catch (e) {
    console.error('saveConversation exception', e);
  }
}

// ---------- HTTP server ----------
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

// ---------- per-connection logic ----------
wss.on('connection', async (twilioWs, req) => {
  console.log('Twilio connected');

  let openaiWs = null;
  let streamSid = null;
  let bookingId = null;
  let callStart = Date.now();
  let conversation = []; // { t, who, msg }
  let outMuLawBuffer = new Uint8Array(0);
  let flusher = null;
  let keepAlive = null;

  const startFlusher = () => {
    if (flusher) return;
    flusher = setInterval(() => {
      try {
        if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
        const CHUNK = 160; // 20 ms at 8 kHz
        if (outMuLawBuffer.length >= CHUNK) {
          const slice = outMuLawBuffer.subarray(0, CHUNK);
          outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
          twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: uint8ArrayToBase64(slice) } }));
        } else {
          twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'tick' } }));
        }
      } catch (e) { console.error('Flusher error', e); }
    }, 20);
  };
  const stopFlusher = () => { if (flusher) { clearInterval(flusher); flusher = null; } };

  const startKeepAlive = () => {
    if (keepAlive) return;
    keepAlive = setInterval(() => {
      try {
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'keepalive' } }));
        }
      } catch {}
    }, 3000);
  };
  const stopKeepAlive = () => { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } };

  const connectOpenAI = async (firstName, brandContext) => {
    const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-realtime-preview-2024-12-17', voice: 'ash' })
    });
    if (!resp.ok) { console.error('OpenAI token error', await resp.text()); return; }
    const data = await resp.json();
    const eph = data.client_secret.value;

    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime', `openai-insecure-api-key.${eph}`, 'openai-beta.realtime-v1']
    );

    openaiWs.on('open', () => {
      const instructions = `
Role: You are Alex, a Microsoft Digital Sales Specialist.
Persona: Warm, concise, natural. Use ${firstName}'s name occasionally. Do not oversell.
Purpose: Book a short security consultation, not to sell anything on this call.

Brand framing:
- You are calling from Microsoft Security. Many SMBs rely on Microsoft for identity, endpoint, and data protection.
- Reassure the customer this call is about understanding their priorities and optionally booking time with a specialist.

Turn-taking rules:
- Keep replies to one or two sentences, then stop and wait.
- Ask one question at a time.
- If the user asks a question, answer briefly and ask one follow-up question.
- If the user is busy, offer to reschedule and present two specific choices.

Compliance rules:
- Do not ask what security products they currently use.
- If they request do-not-call or removal, apologize and end politely.
- Never fabricate details.

Scheduling logic:
- If the customer suggests a day/time, repeat back the exact day and time you heard and ask to confirm.
- Never change the day name or time. If unclear, ask a yes or no confirmation.
- If asked to propose times, offer: Tuesday 2 pm, Wednesday 10 am, Thursday 2 pm, or Friday 11 am.
- After they confirm, say you will send a calendar invite and confirm their email on file only if they volunteer it.

Examples:
Customer: "Friday at 1 works."
Assistant: "Just to confirm, Friday at 1 pm your time, correct?" [stop]
Customer: "Yes."
Assistant: "Great. I will book Friday at 1 pm." [stop]

Context you can reference lightly: ${brandContext}
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
          temperature: 0.7
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
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.type === 'response.audio.delta' && msg.delta) {
          const mu = convertPCM16ToMulaw(base64ToUint8Array(msg.delta));
          outMuLawBuffer = concatUint8(outMuLawBuffer, mu);
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          conversation.push({ t: new Date().toISOString(), who: 'Customer', msg: msg.transcript });
        } else if (msg.type === 'response.audio_transcript.done') {
          conversation.push({ t: new Date().toISOString(), who: 'AI', msg: msg.transcript });
        }
      } catch (e) { console.error('OpenAI message error', e); }
    });

    openaiWs.on('close', (code, reason) => {
      console.log('OpenAI closed', code, reason?.toString());
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, 'openai-closed');
    });
    openaiWs.on('error', (e) => console.error('OpenAI WS error', e));
  };

  // ---------- Twilio events ----------
  twilioWs.on('message', async (buf) => {
    const msg = JSON.parse(buf.toString());

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      bookingId = msg.start.customParameters?.bookingId || null;
      if (!bookingId && msg.start.streamUrl) {
        const u = new URL(msg.start.streamUrl);
        bookingId = u.searchParams.get('bookingId');
      }

      let firstName = 'there';
      let brandContext = '';
      if (bookingId) {
        const booking = await getBooking(bookingId);
        if (booking) {
          firstName = pickFirstName(booking.customer_name);
          // Build lightweight context string if available
          const pieces = [];
          if (booking.customer_name) pieces.push(`Customer: ${booking.customer_name}`);
          if (booking.customer_email) pieces.push(`Email: ${booking.customer_email}`);
          if (booking.customer_phone) pieces.push(`Phone: ${booking.customer_phone}`);
          brandContext = pieces.join(' | ');
        }
      }
      await connectOpenAI(firstName, brandContext);
      startFlusher();
      startKeepAlive();
    }

    if (msg.event === 'media') {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        const pcm24 = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: uint8ArrayToBase64(pcm24) }));
      }
    }

    if (msg.event === 'stop') {
      await saveConversation({ bookingId, conversation, callStart, source: 'stop' });
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, 'twilio-stop');
      stopFlusher();
      stopKeepAlive();
    }
  });

  twilioWs.on('close', async () => {
    stopFlusher();
    stopKeepAlive();
    await saveConversation({ bookingId, conversation, callStart, source: 'close' });
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, 'twilio-closed');
  });

  twilioWs.on('error', (e) => console.error('Twilio WS error', e));
});

server.listen(PORT, () => console.log(`Media bridge running on ${PORT}`));

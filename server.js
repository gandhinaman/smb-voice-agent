
// server.js (ESM) — Render/Node
// Requires: "ws" dependency, Node 18+
// ENV needed: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TZ_REGION (optional: ET|CT|MT|PT)

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 10000;

// ---------- US timezone helpers for SPEECH ONLY (DB stores UTC) ----------
const US_TIMEZONES = {
  PT: { code: 'PT', name: 'Pacific Time', offsetMin: -480 }, // UTC-8 standard (speech label only)
  MT: { code: 'MT', name: 'Mountain Time', offsetMin: -420 },
  CT: { code: 'CT', name: 'Central Time', offsetMin: -360 },
  ET: { code: 'ET', name: 'Eastern Time', offsetMin: -300 }
};
const DEFAULT_TZ = US_TIMEZONES[(process.env.TZ_REGION || 'CT').toUpperCase()] || US_TIMEZONES.CT;

function addMinutes(d, min) { return new Date(d.getTime() + min * 60000); }
function withOffset(d, offsetMin) { return addMinutes(d, offsetMin); }
function toSpoken(d, tz = DEFAULT_TZ) {
  const local = withOffset(d, tz.offsetMin);
  const day = local.toLocaleDateString('en-US', { weekday: 'long' });
  const month = local.toLocaleDateString('en-US', { month: 'long' });
  const date = local.getDate();
  const time = local.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${month} ${date} at ${time} ${tz.code}`;
}
function nextWeekdayAt(targetDow, hour24, minute, tz = DEFAULT_TZ, now = new Date()) {
  // compute next occurrence in local wall clock, then return as real UTC Date
  const localNow = withOffset(now, tz.offsetMin);
  const delta = (targetDow - localNow.getDay() + 7) % 7;
  const candidate = new Date(localNow);
  candidate.setDate(localNow.getDate() + delta);
  candidate.setHours(hour24, minute, 0, 0);
  if (candidate <= localNow) candidate.setDate(candidate.getDate() + 7);
  // convert back to UTC Date by subtracting offset
  return addMinutes(candidate, -tz.offsetMin);
}
function pickNextTwoOffers(tz = DEFAULT_TZ, now = new Date()) {
  const windows = [
    { dow: 2, h: 14, m: 0 }, // Tue 2:00p
    { dow: 3, h: 10, m: 0 }, // Wed 10:00a
    { dow: 4, h: 14, m: 0 }, // Thu 2:00p
    { dow: 5, h: 11, m: 0 }  // Fri 11:00a
  ];
  const upcoming = windows.map(w => ({ when: nextWeekdayAt(w.dow, w.h, w.m, tz, now), ...w }))
                          .sort((a, b) => a.when - b.when);
  const unique = [];
  for (const x of upcoming) {
    if (!unique.length || x.when.getTime() !== unique[unique.length - 1].when.getTime()) unique.push(x);
    if (unique.length === 2) break;
  }
  while (unique.length < 2) {
    const plus7 = addMinutes(upcoming[0].when, 7 * 24 * 60);
    unique.push({ when: plus7, ...upcoming[0] });
  }
  return unique.map(x => x.when);
}

// ---------- Audio encoding helpers (μ-law <-> PCM16 24k) ----------
function base64ToU8(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}
function u8ToBase64(u8) {
  return Buffer.from(u8).toString('base64');
}
function concatU8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
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

// ---------- Supabase REST helpers ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function fetchBooking(bookingId) {
  if (!bookingId || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0] || null;
}
async function updateBooking(bookingId, body) {
  if (!bookingId || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const url = `${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(body)
  });
}

// ---------- HTTP + WS server ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', at: new Date().toISOString() }));
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/media') {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (twilioWs, req) => {
  // Per-call state
  let openaiWs = null;
  let streamSid = null;
  let callSid = null;
  let bookingId = null;
  let firstName = 'there';
  let conversation = [];
  let callStart = Date.now();
  let lastActivity = Date.now();
  let twilioFlusher = null;
  let idleTimer = null;
  let outMu = new Uint8Array(0);
  let offered = []; // two Date objects in UTC for pending offers

  const CHUNK = 160; // 20 ms @ 8 kHz μ-law

  function clearAllTimers() {
    if (twilioFlusher) { clearInterval(twilioFlusher); twilioFlusher = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }
  function hardCloseAll(reason = 'server-close') {
    try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, reason); } catch {}
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, reason); } catch {}
    clearAllTimers();
  }

  // Pace audio to Twilio
  function startFlusher() {
    if (twilioFlusher) return;
    twilioFlusher = setInterval(() => {
      // If both sockets are closed, stop looping
      if ((!openaiWs || openaiWs.readyState === WebSocket.CLOSED) && twilioWs.readyState === WebSocket.CLOSED) {
        clearInterval(twilioFlusher);
        twilioFlusher = null;
        return;
      }
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
      if (outMu.length >= CHUNK) {
        const slice = outMu.subarray(0, CHUNK);
        outMu = outMu.subarray(CHUNK);
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: u8ToBase64(slice) } }));
      } else {
        twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'tick' } }));
      }
    }, 20);
  }

  // Idle timeout: end call after 10 s of inactivity
  idleTimer = setInterval(() => {
    if ((!openaiWs || openaiWs.readyState === WebSocket.CLOSED) && twilioWs.readyState === WebSocket.CLOSED) {
      clearInterval(idleTimer);
      idleTimer = null;
      return;
    }
    if (Date.now() - lastActivity > 10000) {
      console.log('⏱️ Ending inactive call session');
      hardCloseAll('idle-timeout');
    }
  }, 5000);

  async function connectOpenAI() {
    try {
      const tokenRes = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'gpt-4o-realtime-preview-2024-12-17', voice: 'ash' })
      });
      if (!tokenRes.ok) {
        console.error('OpenAI token error:', await tokenRes.text());
        return;
      }
      const token = (await tokenRes.json()).client_secret.value;

      openaiWs = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
        ['realtime', `openai-insecure-api-key.${token}`, 'openai-beta.realtime-v1']
      );

      openaiWs.on('open', () => {
        lastActivity = Date.now();

        // Build dynamic offers
        offered = pickNextTwoOffers(DEFAULT_TZ, new Date());
        const [o1, o2] = offered;
        const opt1Spoken = toSpoken(o1, DEFAULT_TZ);
        const opt2Spoken = toSpoken(o2, DEFAULT_TZ);

        const instructions = `
Role: You are Alex, a Microsoft Security advisor speaking with ${firstName}.
Style: brief and consultative. One or two sentences per turn.

Path:
1) Start with one open question about their current security posture.
2) Share at most one short fact before each question. Examples (use naturally):
   • 43% of cyberattacks target small businesses.
   • A breach can cost over $200,000.
   • MFA and strong identity often stop phishing.
   • AI-driven detection can help small teams stay protected.
3) Adapt:
   • If engaged → explore one level deeper, then ask if a short specialist call would help.
   • If uncertain → reassure with one fact, then ask if a short follow-up makes sense.
   • If busy → skip facts and offer two times immediately.
4) If they show interest, offer two choices and then stop speaking:
   “Would ${opt1Spoken} or ${opt2Spoken} work for you?”

Rules:
- Never stack more than one fact at a time.
- Do not lecture. Ask, listen, and pivot.
- When they accept, confirm with weekday, full date, time, and timezone code.
- If they decline, thank them and end.
`;

        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions,
            voice: 'ash',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 900 },
            temperature: 0.6
          }
        }));

        setTimeout(() => {
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['text', 'audio'],
                instructions: `Hi ${firstName}, this is Alex with Microsoft. How are you feeling about your company’s protection against threats lately?`
              }
            }));
          }
        }, 200);
      });

      openaiWs.on('message', (buf) => {
        lastActivity = Date.now();
        const data = JSON.parse(buf.toString());

        if (data.type === 'response.audio.delta' && data.delta) {
          const mu = convertPCM16ToMulaw(base64ToU8(data.delta));
          outMu = concatU8(outMu, mu);
        } else if (data.type === 'conversation.item.input_audio_transcription.completed') {
          conversation.push({ t: new Date().toISOString(), who: 'Customer', msg: data.transcript });
        } else if (data.type === 'response.audio_transcript.done') {
          conversation.push({ t: new Date().toISOString(), who: 'AI', msg: data.transcript });
        }
      });

      openaiWs.on('close', (code, reason) => {
        console.log('🔌 OpenAI closed', code, reason?.toString());
        try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, 'openai-closed'); } catch {}
        clearAllTimers();
      });

      openaiWs.on('error', (e) => console.error('OpenAI WS error:', e?.message || e));

    } catch (e) {
      console.error('connectOpenAI error:', e);
    }
  }

  function computeConfirmedUTCFromTranscript(text) {
    const lower = text.toLowerCase();

    // Detect weekday
    const dayMap = { mon:1, monday:1, tue:2, tues:2, tuesday:2, wed:3, weds:3, wednesday:3, thu:4, thur:4, thurs:4, thursday:4, fri:5, friday:5 };
    let targetDow = null;
    for (const key of Object.keys(dayMap)) {
      if (lower.includes(key)) { targetDow = dayMap[key]; break; }
    }

    // Detect time like "1", "1 pm", "1:30", "13:30"
    const timeRegex = /\b((1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?)\b|\b((1[0-9]|2[0-3]):([0-5]\d))\b/ig;
    let hour24 = null, minute = 0;
    let m;
    while ((m = timeRegex.exec(lower))) {
      if (m[1]) {
        // 12h with optional am/pm
        const h12 = parseInt(m[2], 10);
        minute = m[3] ? parseInt(m[3], 10) : 0;
        const suffix = (m[4] || '').replace(/\./g, '');
        if (!suffix) {
          // if no am/pm, choose nearest future hour by assuming next occurrence in business hours, bias to PM 9–17
          hour24 = h12 === 12 ? 12 : h12; // default noon-ish
          if (hour24 < 9) hour24 += 12;
        } else if (suffix === 'am' || suffix === 'a' ) {
          hour24 = h12 === 12 ? 0 : h12;
        } else {
          hour24 = h12 === 12 ? 12 : h12 + 12;
        }
      } else if (m[5]) {
        // 24h like 13:30
        hour24 = parseInt(m[6], 10);
        minute = parseInt(m[7], 10);
      }
      if (hour24 !== null) break;
    }

    if (targetDow !== null && hour24 !== null) {
      const when = nextWeekdayAt(targetDow, hour24, minute, DEFAULT_TZ, new Date());
      return when; // UTC Date object
    }
    return null;
  }

  async function saveConversation(source) {
    try {
      if (!bookingId) return;
      const dur = Math.floor((Date.now() - callStart) / 1000);
      const transcript = conversation.map(x => `${x.who}: ${x.msg}`).join('\n');
      const hasCustomer = conversation.some(x => x.who === 'Customer');

      // Detect booking intent
      const text = transcript.toLowerCase();
      const agree = /\b(yes|yeah|sure|sounds good|that works|okay|ok|let'?s do it)\b/.test(text);
      let confirmedUTC = null;

      // If they referenced a weekday/time explicitly
      const parsed = computeConfirmedUTCFromTranscript(text);
      if (parsed) confirmedUTC = parsed;

      // If they said "first" or "second" take offered[0]/offered[1]
      if (!confirmedUTC && offered.length === 2) {
        if (/\b(first|1st|one)\b/.test(text)) confirmedUTC = offered[0];
        if (/\b(second|2nd|two)\b/.test(text)) confirmedUTC = offered[1];
      }

      const status = !hasCustomer ? 'no_answer' : (confirmedUTC || agree) ? 'scheduled' : 'completed';

      await updateBooking(bookingId, {
        conversation_summary: transcript || 'No conversation captured',
        booking_status: status,
        call_duration: dur,
        call_answered: hasCustomer || dur > 10,
        customer_transcript: conversation.filter(x => x.who === 'Customer').map(x => x.msg).join('\n') || 'No customer speech captured',
        confirmed_time: confirmedUTC ? confirmedUTC.toISOString() : null, // store UTC ISO
        close_source: source
      });
    } catch (e) {
      console.error('saveConversation error:', e);
    }
  }

  // Twilio WS
  twilioWs.on('open', () => {
    lastActivity = Date.now();
  });

  twilioWs.on('message', async (msg) => {
    try {
      lastActivity = Date.now();
      const data = JSON.parse(msg.toString());
      const ev = data.event;

      if (ev === 'start') {
        streamSid = data.start.streamSid;
        callSid = data.start.callSid;

        // Pull identifiers from customParameters or URL
        const urlStr = data.start.streamUrl || req.url || '';
        const url = new URL(urlStr, 'http://localhost');
        bookingId = data.start.customParameters?.bookingId || url.searchParams.get('bookingId') || bookingId;
        const paramFirst = data.start.customParameters?.firstName || data.start.customParameters?.name || data.start.customParameters?.customerName
          || url.searchParams.get('firstName') || url.searchParams.get('name');

        if (paramFirst && String(paramFirst).trim()) {
          firstName = String(paramFirst).trim().split(/\s+/)[0];
        } else if (bookingId) {
          const booking = await fetchBooking(bookingId);
          if (booking?.customer_name) firstName = String(booking.customer_name).split(/\s+/)[0];
        }

        startFlusher();
        await connectOpenAI();
      }

      else if (ev === 'media') {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const pcm24 = convertMulawToPCM16(base64ToU8(data.media.payload));
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: u8ToBase64(pcm24) }));
        }
      }

      else if (ev === 'mark') {
        // optional: ignore
      }

      else if (ev === 'stop') {
        console.log('🛑 Twilio stop event');
        await saveConversation('stop');
        hardCloseAll('twilio-stop');
      }
    } catch (e) {
      console.error('Twilio message error:', e);
    }
  });

  twilioWs.on('close', async () => {
    clearAllTimers();
    await saveConversation('close');
    try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, 'twilio-closed'); } catch {}
  });

  twilioWs.on('error', (e) => console.error('Twilio WS error:', e?.message || e));
});

server.listen(PORT, () => {
  console.log('Media bridge running on', PORT);
});

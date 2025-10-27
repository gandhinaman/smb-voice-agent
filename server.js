// server.js  (Node 18+/ESM on Render)
// Run with: node server.js
// Env vars required on Render:
//   PORT (Render sets automatically)
//   OPENAI_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import http from "http";
import { WebSocketServer } from "ws";

// -------- env ----------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// -------- tiny HTTP server just for health ----------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("OK");
});

// -------- WebSocket server (Twilio connects here) ----------
const wss = new WebSocketServer({ noServer: true });

// Per-connection state
wss.on("connection", (twilioWs, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const initialBookingId = url.searchParams.get("bookingId") || null;

  // State
  let streamSid = null;
  let callSid = null;
  let bookingId = initialBookingId;
  let firstName = "there"; // will be replaced once we fetch booking
  let customerName = null;

  let openaiWs = null;
  let lastActivity = Date.now();

  // Outbound audio pacing (OAI -> Twilio)
  let outMuLawBuffer = new Uint8Array(0);
  const CHUNK = 160; // 20ms @8kHz μ-law
  let flusher = null;

  // Conversation log
  const convo = []; // { t, who, msg }
  const callStart = Date.now();

  // ---- helpers ----
  const log = (...args) => console.log(new Date().toISOString(), ...args);

  function concatUint8(a, b) {
    const o = new Uint8Array(a.length + b.length);
    o.set(a, 0);
    o.set(b, a.length);
    return o;
  }
  function b64ToU8(b64) {
    const bin = Buffer.from(b64, "base64");
    return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  }
  function u8ToB64(u8) {
    return Buffer.from(u8).toString("base64");
  }

  // μ-law 8kHz -> PCM16 24kHz (naive)
  function mulawToPCM16(m) {
    m = ~m;
    const sign = m & 0x80;
    const exponent = (m >> 4) & 7;
    const mantissa = m & 0x0f;
    let sample = (mantissa << 3) + 0x84;
    sample <<= exponent;
    sample -= 0x84;
    return sign ? -sample : sample;
  }
  function convertMulawToPCM16(mulaw) {
    const pcm8k = new Int16Array(mulaw.length);
    for (let i = 0; i < mulaw.length; i++) pcm8k[i] = mulawToPCM16(mulaw[i]);
    const pcm24k = new Int16Array(pcm8k.length * 3);
    for (let i = 0; i < pcm8k.length; i++) {
      const s = pcm8k[i];
      pcm24k[i * 3] = s;
      pcm24k[i * 3 + 1] = s;
      pcm24k[i * 3 + 2] = s;
    }
    return new Uint8Array(pcm24k.buffer);
  }

  // PCM16 24kHz -> μ-law 8kHz (naive)
  function pcmToMulaw(pcm) {
    const sign = pcm < 0 ? 0x80 : 0x00;
    let s = Math.abs(pcm);
    s = Math.min(s, 32635);
    s += 0x84;
    let exp = 7;
    for (let e = 0; e < 8; e++) {
      if (s <= (0xff << e)) {
        exp = e;
        break;
      }
    }
    const man = (s >> (exp + 3)) & 0x0f;
    return ~(sign | (exp << 4) | man);
  }
  function convertPCM16ToMulaw(pcm24) {
    const pcm24i = new Int16Array(pcm24.buffer, pcm24.byteOffset, Math.floor(pcm24.byteLength / 2));
    const pcm8k = new Int16Array(Math.floor(pcm24i.length / 3));
    for (let i = 0; i < pcm8k.length; i++) pcm8k[i] = pcm24i[i * 3];
    const out = new Uint8Array(pcm8k.length);
    for (let i = 0; i < pcm8k.length; i++) out[i] = pcmToMulaw(pcm8k[i]);
    return out;
  }

  function startFlusher() {
    if (flusher) return;
    flusher = setInterval(() => {
      try {
        if (!streamSid || twilioWs.readyState !== 1) return;
        if (outMuLawBuffer.length >= CHUNK) {
          const slice = outMuLawBuffer.subarray(0, CHUNK);
          outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
          const payload = u8ToB64(slice);
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
        } else {
          // lightweight keepalive to keep Twilio stream hot
          twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tick" } }));
        }
      } catch (e) {
        log("flusher error", e.message || e);
      }
    }, 20);
  }
  function stopFlusher() {
    if (flusher) {
      clearInterval(flusher);
      flusher = null;
    }
  }

  async function fetchBooking(id) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(id)}&select=*`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      if (!res.ok) return null;
      const arr = await res.json();
      return arr?.[0] || null;
    } catch {
      return null;
    }
  }

  function endCall(reason = "normal-end") {
    try {
      if (openaiWs && openaiWs.readyState === 1) {
        openaiWs.close(1000, reason);
      }
    } catch {}
    try {
      if (twilioWs && twilioWs.readyState === 1) {
        twilioWs.close(1000, reason);
      }
    } catch {}
    stopFlusher();
  }

  async function connectOpenAI() {
    try {
      // 1) ephemeral token
      const tok = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2024-12-17",
          voice: "ash",
        }),
      });
      if (!tok.ok) {
        log("OAI token error", await tok.text());
        return;
      }
      const td = await tok.json();
      const eph = td.client_secret.value;

      // 2) websocket
      openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        ["realtime", `openai-insecure-api-key.${eph}`, "openai-beta.realtime-v1"]
      );

      openaiWs.onopen = () => {
        log("OAI ▶ open");
        lastActivity = Date.now();

        // Configure session (role + VAD + formats)
        const instructions = `
You are the CALLER named **Alex** from Microsoft's SMB Security Digital Sales team.
The person you are calling is **${firstName}** (the prospect).

Identity & role rules (critical):
- You are **Alex** (the caller). The other person is **${firstName}**.
- Never say "Hi Alex" or speak as if you are the callee.
- Do not invent what ${firstName} says—only react to real audio.
- Keep turns very short (one sentence or a simple question), then WAIT.

Consultative flow:
- Clear intro: who you are, why you're calling (brief security value), then a simple permission ask.
- Be consultative: ask one question about their current focus or concerns, then listen.
- Use **light** fact nuggets only when helpful (avoid stacking):
  • About ~40–45% of attacks hit small businesses.
  • A single breach can cost well into six figures when downtime & recovery are included.
  • Many SMBs use Microsoft Security across identity, email, and devices to reduce risk and overhead.
- If engaged: suggest a short follow-up with a Security Specialist, and offer 1–2 concrete times (in the user's US timezone if they mention it; otherwise keep it generic but confirm).
- If hesitant: frame ROI/risk briefly, ask one clarifying question.
- If busy: ask for a better time—keep it friendly.
- Avoid asking which vendor or tools they use.

End of call:
- If they clearly decline multiple times or you say a natural goodbye, end gracefully with a brief thanks.
- No monologues. Ask, then listen.
        `.trim();

        openaiWs.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["audio", "text"],
              instructions,
              voice: "ash",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: { model: "whisper-1" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 900,
              },
              temperature: 0.7,
            },
          })
        );

        // Immediate greeting (prevents opening silence)
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions: `Hi ${firstName}, this is Alex with Microsoft’s SMB Security team. Do you have a quick minute to talk about keeping your business secure and whether a short follow-up with a specialist could help?`,
            },
          })
        );
      };

      openaiWs.onmessage = (evt) => {
        lastActivity = Date.now();
        try {
          const data = JSON.parse(evt.data);

          // session lifecycle logs
          if (data.type === "session.created" || data.type === "session.updated") {
            log("OAI ▶", data.type);

          } else if (data.type === "response.audio.delta" && data.delta) {
            // PCM16 24k -> μ-law 8k and enqueue
            const mu = convertPCM16ToMulaw(b64ToU8(data.delta));
            outMuLawBuffer = concatUint8(outMuLawBuffer, mu);

          } else if (data.type === "conversation.item.input_audio_transcription.completed") {
            convo.push({ t: new Date().toISOString(), who: "Customer", msg: data.transcript });

          } else if (data.type === "response.audio_transcript.done") {
            convo.push({ t: new Date().toISOString(), who: "AI", msg: data.transcript });

          } else if (data.type === "response.done") {
            // If the model just finished a response, we do nothing—wait for next user speech.
            // If we want to end the call after a deliberate farewell, you can ask the model
            // to end calls by saying “goodbye” and then detect that here to endCall().
          } else if (data.type === "error") {
            log("OAI ▶ error", JSON.stringify(data, null, 2));
          }
        } catch (e) {
          log("OAI ▶ msg error", e.message || e);
        }
      };

      openaiWs.onclose = (evt) => {
        log("OAI ▶ closed", evt?.reason);
        // If OpenAI ends first, hang up Twilio too
        if (twilioWs.readyState === 1) {
          try { twilioWs.close(1000, "openai-closed"); } catch {}
        }
        stopFlusher();
      };

      openaiWs.onerror = (err) => {
        log("OAI ▶ error", err?.message || err);
      };
    } catch (e) {
      log("connectOpenAI error", e.message || e);
    }
  }

  function saveConversationFinal(source = "close") {
    // Same logic you already had, kept simple here. You can keep your richer version if needed.
    (async () => {
      try {
        if (!bookingId) return;
        const formatted = convo.length
          ? convo.map(i => `[${new Date(i.t).toLocaleString()}] ${i.who}: ${i.msg}`).join("\n\n")
          : "No conversation captured";
        const dur = Math.floor((Date.now() - callStart) / 1000);
        const text = convo.map(i => i.msg.toLowerCase()).join(" ");

        const hasCust = convo.some(i => i.who === "Customer");
        const answered = hasCust || dur > 10;

        // very light signals
        const hasDay = /(monday|tuesday|wednesday|thursday|friday|mon|tue|tues|wed|thu|thur|thurs|fri)/i.test(text);
        const hasAgree = /(sounds good|works|sure|yes|okay|ok)/i.test(text);
        const strongNo = /(not interested( at all)?|stop calling|no thanks)/i.test(text);

        const status = !answered ? "no_answer" : (hasAgree && hasDay) ? "scheduled" : strongNo ? "not_interested" : "completed";

        // naive next weekday picker just to populate confirmed_time when clear
        let confirmed = null;
        if (status === "scheduled") {
          const now = new Date();
          const map = { monday:1, mon:1, tuesday:2, tue:2, tues:2, wednesday:3, wed:3, thursday:4, thu:4, thur:4, thurs:4, friday:5, fri:5 };
          let hit = 0;
          for (const k of Object.keys(map)) if (text.includes(k)) { hit = map[k]; break; }
          if (hit) {
            const delta = (hit - now.getDay() + 7) % 7 || 7;
            const d = new Date(now);
            d.setDate(now.getDate() + delta);
            // default: 11:00 local -> store as UTC string
            d.setHours(11, 0, 0, 0);
            confirmed = d.toISOString();
          }
        }

        await fetch(`${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}`, {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            conversation_summary: formatted,
            booking_status: status,
            call_duration: dur,
            call_answered: answered,
            customer_transcript: convo.filter(i => i.who === "Customer").map(i => i.msg).join("\n") || "No customer speech captured",
            confirmed_time: confirmed,
            close_source: source,
          }),
        });
      } catch (e) {
        log("saveConversation error", e.message || e);
      }
    })();
  }

  // ---- Twilio socket events ----
  twilioWs.on("message", async (raw) => {
    lastActivity = Date.now();
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;

        // Prefer customParameters.bookingId; fallback to URL query
        bookingId = msg.start?.customParameters?.bookingId || bookingId || null;

        // try to fetch booking -> name
        if (bookingId) {
          const booking = await fetchBooking(bookingId);
          if (booking?.customer_name) {
            customerName = booking.customer_name;
            firstName = String(customerName).split(/\s+/)[0] || "there";
          }
        }

        log("▶ START", { streamSid, bookingId, firstName });
        // OpenAI connect & start flusher
        await connectOpenAI();
        startFlusher();

      } else if (msg.event === "media") {
        // caller audio → OAI (μ-law 8k -> PCM16 24k)
        if (openaiWs && openaiWs.readyState === 1) {
          const pcm24 = convertMulawToPCM16(b64ToU8(msg.media.payload));
          const b64 = u8ToB64(pcm24);
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        }

      } else if (msg.event === "mark") {
        // keepalive ack; nothing to do

      } else if (msg.event === "stop") {
        log("🛑 STOP received");
        saveConversationFinal("stop");
        endCall("twilio-stop");
      }
    } catch (e) {
      log("twilio msg error", e.message || e);
    }
  });

  twilioWs.on("close", () => {
    log("Twilio closed");
    saveConversationFinal("close");
    endCall("twilio-closed");
  });

  twilioWs.on("error", (e) => {
    log("Twilio WS error", e?.message || e);
  });
});

// Handle HTTP upgrade → WS
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const bookingId = u.searchParams.get("bookingId") || null;
      const firstName = u.searchParams.get("firstName") || null;
      console.log(`[${new Date().toISOString()}] 🔗 WS connected`, { bookingId, firstName: firstName || "there" });
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`${new Date().toISOString()} Media bridge running on ${PORT}`);
});

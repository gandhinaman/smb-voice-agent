// server.js  (Node ESM, Render)
//
// Requirements (Render Environment Variables):
//  - OPENAI_API_KEY
//  - SUPABASE_URL
//  - SUPABASE_SERVICE_ROLE_KEY
//  - WEBHOOK_URL (optional webhook back to call-handler with booking status)
//
// npm deps: "ws" (for server + client)

import http from "http";
import { WebSocketServer, WebSocket as WSClient } from "ws";

// ----------- constants -----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""; // optional

// ----------- tiny utils -----------
const nowIso = () => new Date().toISOString();
const safeJson = (v) => {
  try { return JSON.stringify(v); } catch { return String(v); }
};

function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

function base64ToUint8Array(base64) {
  const bin = Buffer.from(base64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

function uint8ArrayToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

// μ-law 8 kHz → PCM16 24 kHz
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

// PCM16 24 kHz → μ-law 8 kHz
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
  // view as int16
  const pcm24k = new Int16Array(
    pcm24kData.buffer,
    pcm24kData.byteOffset,
    Math.floor(pcm24kData.byteLength / 2)
  );
  // downsample
  const pcm8k = new Int16Array(Math.floor(pcm24k.length / 3));
  for (let i = 0; i < pcm8k.length; i++) pcm8k[i] = pcm24k[i * 3];
  // μ-law encode
  const mulaw = new Uint8Array(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) mulaw[i] = pcmToMulaw(pcm8k[i]);
  return mulaw;
}

// ----------- HTTP server (health) -----------
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", ts: nowIso() }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// ----------- WebSocket server for Twilio -----------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  if (url.pathname === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, url);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs, req, url) => {
  // ---- per-call state
  let bookingId = url.searchParams.get("bookingId") || null;
  let firstName = url.searchParams.get("firstName") || null; // from query if provided
  let customerName = null;
  let streamSid = null;
  let callSid = null;

  let openaiWs = null;
  let outMuLawBuffer = new Uint8Array(0);
  let flusher = null;
  let healthTimer = null;
  let lastActivity = Date.now();

  let conversation = []; // { t, who, msg }
  const callStart = Date.now();

  const CHUNK = 160; // 20ms @ 8kHz μ-law

  const log = (...a) => console.log(`[${nowIso()}]`, ...a);

  // ----- helpers
  const twilioOpen = () => twilioWs && twilioWs.readyState === WSClient.OPEN;
  const openaiOpen = () => openaiWs && openaiWs.readyState === WSClient.OPEN;

  function closeTwilio(code = 1000, reason = "normal") {
    try { if (twilioOpen()) twilioWs.close(code, reason); } catch {}
  }
  function closeOpenAI(code = 1000, reason = "normal") {
    try { if (openaiOpen()) openaiWs.close(code, reason); } catch {}
  }
  function clearTimers() {
    if (flusher) { clearInterval(flusher); flusher = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  async function saveOutcome(source) {
    try {
      if (!bookingId) return;

      // very lightweight analysis
      const txt = conversation.map(i => i.msg?.toLowerCase?.() || "").join(" ");
      const hasCustomerSpeech = conversation.some(i => i.who === "Customer");
      const dur = Math.floor((Date.now() - callStart) / 1000);

      const agree = [
        /\b(yes|yeah|sure|sounds good|that works|perfect|great|okay)\b.*\b(mon|tue|tues|weds?|thu|thur|thurs|fri|monday|tuesday|wednesday|thursday|friday)\b/i,
        /\b(mon|tue|tues|weds?|thu|thur|thurs|fri|monday|tuesday|wednesday|thursday|friday)\b.*\b(works|good|fine|perfect)\b/i,
        /\b(schedule|book|set up|arrange)\b.*\b(appointment|meeting|consult|call)\b/i,
      ].some(r => r.test(txt));

      const hardNo = [
        /\bnot interested\b/i,
        /\bstop calling\b/i,
        /\bremove me\b/i,
      ].some(r => r.test(txt));

      const status =
        !hasCustomerSpeech && dur <= 10 ? "no_answer"
        : agree ? "scheduled"
        : hardNo ? "not_interested"
        : "completed";

      const body = {
        conversation_summary: conversation.map(i => `[${i.t}] ${i.who}: ${i.msg}`).join("\n\n") || "No conversation captured",
        booking_status: status,
        call_duration: dur,
        call_answered: hasCustomerSpeech || dur > 10,
        customer_transcript: conversation.filter(i => i.who === "Customer").map(i => i.msg).join("\n") || "No customer speech captured",
        close_source: source
      };

      await fetch(`${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "return=minimal"
        },
        body: JSON.stringify(body)
      });

      // optional webhook back to call-handler (for email follow-up, etc.)
      if (WEBHOOK_URL) {
        try {
          await fetch(`${WEBHOOK_URL}?bookingId=${encodeURIComponent(bookingId)}&action=webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bookingStatus: status,
              callAnswered: body.call_answered,
              confirmedTime: null
            })
          });
        } catch (e) {
          log("Webhook error (non-fatal):", e?.message || e);
        }
      }

      log("✅ Outcome saved:", status, "source:", source);
    } catch (e) {
      log("saveOutcome error:", e?.message || e);
    }
  }

  // ---- OpenAI Realtime
  async function connectOpenAI(effectiveFirst) {
    try {
      const tokenRes = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2024-12-17",
          voice: "ash"
        })
      });
      if (!tokenRes.ok) {
        log("OpenAI token error:", await tokenRes.text());
        return;
      }
      const tokenData = await tokenRes.json();
      const eph = tokenData.client_secret.value;

      openaiWs = new WSClient(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        ["realtime", `openai-insecure-api-key.${eph}`, "openai-beta.realtime-v1"]
      );

      openaiWs.on("open", () => {
        lastActivity = Date.now();
        // Configure consultative persona: short turns, one question, light facts
        const consultativeInstructions = `
You are Alex, a Digital Sales Specialist with Microsoft speaking to ${effectiveFirst}.
Goal: have a short, consultative chat about improving their business security and, if it makes sense, propose a brief follow-up with a security specialist.

Style:
- One sentence or question at a time. Then STOP and wait.
- Use ${effectiveFirst}'s name occasionally (every 2–3 turns).
- Be empathetic; acknowledge their answers before asking the next question.
- Keep it natural and short—no monologues.

When to use quick fact nuggets (never stack more than one in a single turn):
- If ${effectiveFirst} is unsure whether security matters: briefly mention a single risk/impact for small businesses.
- If ${effectiveFirst} is evaluating ROI: briefly mention that many breaches cost small businesses in the six-figure range and can cause multi-day downtime.
- If ${effectiveFirst} seems proactive: briefly note Microsoft’s broad adoption and integrated protection.

Approved fact nuggets (use at most one at a time, and only when helpful):
- Many cyberattacks target small and mid-sized businesses.
- A single breach can cost small businesses around the six-figure range (e.g., ~$200k) including downtime.
- Microsoft Security is trusted by hundreds of thousands of businesses and covers identities, devices, email, and data.

Never:
- Ask what tool or vendor they currently use.
- List multiple stats in one turn.
- Hard sell. Keep it consultative.

If there’s alignment:
- Offer a specific, short follow-up with a specialist. Propose 2–3 concrete slots in ${effectiveFirst}'s local business hours (e.g., “Tue 2 PM, Wed 10 AM, Thu 2 PM”). If they want a different time, ask what generally works.
- Confirm clearly in one sentence.

End the call politely if they repeatedly decline or ask to stop.
        `.trim();

        try {
          openaiWs.send(JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              instructions: consultativeInstructions,
              voice: "ash",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: { model: "whisper-1" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 1000
              },
              temperature: 0.7
            }
          }));
        } catch (e) {
          log("session.update error:", e?.message || e);
        }

        // Short, human greeting
        setTimeout(() => {
          if (!openaiOpen()) return;
          openaiWs.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: `Say only: "Hi ${effectiveFirst}, this is Alex calling from Microsoft. How are you doing today?" Then stop and wait.`
            }
          }));
        }, 200);
      });

      openaiWs.on("message", (raw) => {
        lastActivity = Date.now();
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        // audio to Twilio (paced by flusher)
        if (data.type === "response.audio.delta" && data.delta) {
          const mu = convertPCM16ToMulaw(base64ToUint8Array(data.delta));
          outMuLawBuffer = concatUint8(outMuLawBuffer, mu);
        } else if (data.type === "conversation.item.input_audio_transcription.completed") {
          conversation.push({ t: nowIso(), who: "Customer", msg: data.transcript });
        } else if (data.type === "response.audio_transcript.done") {
          conversation.push({ t: nowIso(), who: "AI", msg: data.transcript });
        }
      });

      openaiWs.on("close", (code, reason) => {
        log("OpenAI closed", code, reason?.toString?.());
        // Make sure Twilio ends too
        closeTwilio(1000, "openai-closed");
      });

      openaiWs.on("error", (e) => {
        log("OpenAI WS error:", e?.message || e);
      });

    } catch (e) {
      log("connectOpenAI error:", e?.message || e);
    }
  }

  // ---- Twilio WS events
  twilioWs.on("open", () => {
    lastActivity = Date.now();
    log("Twilio connected");

    // 20 ms flusher to send μ-law back to Twilio
    flusher = setInterval(() => {
      try {
        if (!twilioOpen() || !streamSid) return;
        if (outMuLawBuffer.length >= CHUNK) {
          const slice = outMuLawBuffer.subarray(0, CHUNK);
          outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: uint8ArrayToBase64(slice) }
          }));
        } else {
          // light keepalive mark
          twilioWs.send(JSON.stringify({
            event: "mark",
            streamSid,
            mark: { name: "tick" }
          }));
        }
      } catch (e) {
        // avoid crashing on network blips
      }
    }, 20);

    // health/logging + inactivity end
    healthTimer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      const stats = {
        twilio: twilioOpen() ? "OPEN" : "CLOSED",
        openai: openaiOpen() ? "OPEN" : "CLOSED",
        idleMs: idle,
        outBuf: outMuLawBuffer.length
      };
      log("health", stats);

      // If both sockets are gone, stop timers
      if (!twilioOpen() && !openaiOpen()) {
        clearTimers();
      }

      // If idle for > 90s, end call
      if (idle > 90_000) {
        log("⏱️ Ending inactive call session");
        saveOutcome("idle");
        closeOpenAI(1000, "idle");
        closeTwilio(1000, "idle");
        clearTimers();
      }
    }, 5_000);
  });

  twilioWs.on("message", async (raw) => {
    lastActivity = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      // Prefer Twilio customParameters firstName if present
      const fromParam = msg.start?.customParameters?.firstName;
      if (!firstName && fromParam) firstName = fromParam;
      if (!firstName) firstName = "there";

      log("start {",
        "streamSid:", streamSid,
        ", callSid:", callSid,
        ", bookingId:", bookingId,
        ", firstName:", firstName,
        "}"
      );

      await connectOpenAI(firstName);

    } else if (msg.event === "media") {
      if (openaiOpen()) {
        try {
          const audio = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: uint8ArrayToBase64(audio) }));
        } catch (e) {
          log("forward media error:", e?.message || e);
        }
      }

    } else if (msg.event === "mark") {
      // keepalive ack (no-op)

    } else if (msg.event === "stop") {
      log("🛑 Twilio stop event");
      saveOutcome("stop");
      // Close both
      closeOpenAI(1000, "twilio-stop");
      closeTwilio(1000, "twilio-stop");
    }
  });

  twilioWs.on("close", () => {
    log("Twilio closed");
    clearTimers();
    // If OpenAI still up, close it and save
    saveOutcome("twilio-close");
    closeOpenAI(1000, "twilio-close");
  });

  twilioWs.on("error", (e) => {
    log("Twilio WS error:", e?.message || e);
  });
});

// ----------- start server -----------
server.listen(PORT, () => {
  console.log("////////////////////////////////////////////////");
  console.log("Media bridge running on", PORT);
  console.log("==> Your service is live 🎉");
  console.log("////////////////////////////////////////////////");
  console.log("==> Available at your primary URL");
  console.log("////////////////////////////////////////////////");
});

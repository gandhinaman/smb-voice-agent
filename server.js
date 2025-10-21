// server.js (ESM)
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

// --- env ---
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";

// ---------- helpers ----------
function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
function base64ToUint8Array(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
function uint8ArrayToBase64(u8) {
  return Buffer.from(u8).toString("base64");
}

// μ-law 8k -> PCM16 24k
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
  const pcm8 = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) pcm8[i] = mulawToPcm(mulawData[i]);
  const pcm24 = new Int16Array(pcm8.length * 3);
  for (let i = 0; i < pcm8.length; i++) {
    const s = pcm8[i];
    pcm24[i * 3] = s; pcm24[i * 3 + 1] = s; pcm24[i * 3 + 2] = s;
  }
  return new Uint8Array(pcm24.buffer);
}

// PCM16 24k -> μ-law 8k
function convertPCM16ToMulaw(pcm24kData) {
  const pcmToMulaw = (pcm) => {
    const sign = pcm < 0 ? 0x80 : 0x00;
    let s = Math.abs(pcm);
    s = Math.min(s, 32635);
    s += 0x84;
    let exp = 7;
    for (let e = 0; e < 8; e++) { if (s <= (0xff << e)) { exp = e; break; } }
    const man = (s >> (exp + 3)) & 0x0F;
    return ~(sign | (exp << 4) | man);
  };
  const pcm24 = new Int16Array(
    pcm24kData.buffer,
    pcm24kData.byteOffset,
    Math.floor(pcm24kData.byteLength / 2)
  );
  const pcm8 = new Int16Array(Math.floor(pcm24.length / 3));
  for (let i = 0; i < pcm8.length; i++) pcm8[i] = pcm24[i * 3];
  const mulaw = new Uint8Array(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) mulaw[i] = pcmToMulaw(pcm8[i]);
  return mulaw;
}

async function hangupCallIfPossible(callSid) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const body = new URLSearchParams({ Status: "completed" });
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    console.log("☎️ hangup status", res.status);
  } catch (e) { console.error("☎️ hangup failed", e); }
}

// ---------- HTTP & WS ----------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
  }
  res.writeHead(404); res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname !== "/media") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (twilioWs, req) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let bookingId = u.searchParams.get("bookingId");
  let firstName = u.searchParams.get("firstName") || "there";

  let openaiWs = null;
  let streamSid = null;
  let callSid = null;

  let outMuLaw = new Uint8Array(0);
  let flushTimer = null, keepaliveTimer = null, healthTimer = null, idleTimer = null;
  let lastActivity = Date.now();

  const CHUNK = 160; // 20ms @ 8kHz
  const isOpen = (sock) => sock && sock.readyState === WebSocket.OPEN;

  function startFlusher() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      try {
        if (!streamSid || !isOpen(twilioWs)) return;
        if (outMuLaw.length >= CHUNK) {
          const slice = outMuLaw.subarray(0, CHUNK);
          outMuLaw = outMuLaw.subarray(CHUNK);
          const payload = uint8ArrayToBase64(slice);
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
        } else {
          twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tick" } }));
        }
      } catch (e) { console.error("flusher error:", e); }
    }, 20);
  }
  function stopTimers() {
    if (flushTimer) clearInterval(flushTimer), flushTimer = null;
    if (keepaliveTimer) clearInterval(keepaliveTimer), keepaliveTimer = null;
    if (healthTimer) clearInterval(healthTimer), healthTimer = null;
    if (idleTimer) clearInterval(idleTimer), idleTimer = null;
  }
  function safeClose(sock, why = "normal") {
    try { if (isOpen(sock)) sock.close(1000, why); } catch {}
  }

  async function connectOpenAI() {
    if (!OPENAI_API_KEY) { console.error("OPENAI_API_KEY missing"); return; }
    try {
      const tokenRes = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-realtime-preview-2024-12-17", voice: "ash" })
      });
      if (!tokenRes.ok) { console.error("token error:", await tokenRes.text()); return; }
      const eph = (await tokenRes.json())?.client_secret?.value;
      if (!eph) { console.error("no ephemeral token"); return; }

      openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        ["realtime", `openai-insecure-api-key.${eph}`, "openai-beta.realtime-v1"]
      );

      openaiWs.onopen = () => {
        lastActivity = Date.now();
        // Consultative, short-turn instructions
        openaiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: `
You are Alex, a Digital Sales Specialist with Microsoft. You’re calling ${firstName} about practical ways to improve small-business security. Goal: determine if a short follow-up with a Security Specialist would help — not a hard sell.

Style:
- One sentence OR one question, then stop and wait.
- Use ${firstName}'s name every 2–3 exchanges.
- Never ask what tools they currently use.
- Acknowledge their answer, then ask one clear next question.
- Offer a single brief fact only when it helps them decide:
  • Many attacks target SMBs
  • Breaches can cost hundreds of thousands incl. downtime/recovery
  • Microsoft Security is trusted by many businesses
- If they’re undecided, mention simple ROI/risk in one line, then ask.
- If they decline, thank them and wrap politely.
- If interested, propose two concrete times. After they pick one, confirm day, calendar date, and local time in words, then stop.
            `.trim(),
            voice: "ash",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1000 },
            temperature: 0.7
          }
        }));

        // Short opener
        setTimeout(() => {
          if (!isOpen(openaiWs)) return;
          openaiWs.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: `Say only: "Hi ${firstName}, this is Alex with Microsoft Security. Do you have a quick minute for one question?" Then stop and wait.`
            }
          }));
        }, 300);
      };

      openaiWs.onmessage = (evt) => {
        try {
          lastActivity = Date.now();
          const data = JSON.parse(evt.data);
          if (data.type === "response.audio.delta" && data.delta) {
            const mulaw = convertPCM16ToMulaw(base64ToUint8Array(data.delta));
            outMuLaw = concatUint8(outMuLaw, mulaw);
          }
        } catch (e) { console.error("OpenAI msg error:", e); }
      };

      openaiWs.onclose = async (evt) => {
        console.log("🔌 OpenAI closed", evt.code, evt.reason, evt.wasClean);
        safeClose(twilioWs, "openai-closed");
        await hangupCallIfPossible(callSid);
      };
      openaiWs.onerror = (e) => console.error("OpenAI WS error:", e?.message || e);

    } catch (e) { console.error("connectOpenAI error:", e); }
  }

  twilioWs.on("message", async (raw) => {
    try {
      lastActivity = Date.now();
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;

        // allow <Parameter name="firstName"> or URL ?firstName=
        const fromParam = msg.start?.customParameters?.firstName;
        if (fromParam && (!firstName || firstName === "there")) firstName = fromParam;

        console.log("📞 start", { streamSid, callSid, bookingId, firstName });
        startFlusher();

        keepaliveTimer = setInterval(() => {
          if (isOpen(twilioWs) && streamSid) {
            try { twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "keepalive" } })); } catch {}
          }
        }, 3000);

        healthTimer = setInterval(() => {
          const idle = Date.now() - lastActivity;
          console.log("🏥 health", {
            twilio: twilioWs.readyState,
            openai: openaiWs ? openaiWs.readyState : null,
            idleMs: idle,
            outBuf: outMuLaw.length
          });
        }, 5000);

        idleTimer = setInterval(async () => {
          const idle = Date.now() - lastActivity;
          if (idle > 45000) {
            console.log("⏱️ idle timeout, ending");
            stopTimers();
            safeClose(openaiWs, "idle-timeout");
            safeClose(twilioWs, "idle-timeout");
            await hangupCallIfPossible(callSid);
          }
        }, 5000);

        await connectOpenAI();
        return;
      }

      if (msg.event === "media") {
        if (isOpen(openaiWs)) {
          try {
            const pcm24 = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
            const b64 = uint8ArrayToBase64(pcm24);
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          } catch (e) { console.error("to OpenAI audio error:", e); }
        }
        return;
      }

      if (msg.event === "stop") {
        console.log("🛑 Twilio stop event");
        stopTimers();
        safeClose(openaiWs, "twilio-stop");
        safeClose(twilioWs, "twilio-stop");
        await hangupCallIfPossible(callSid);
        return;
      }
    } catch (e) { console.error("Twilio msg error:", e); }
  });

  twilioWs.on("close", async () => {
    console.log("🔌 Twilio closed");
    stopTimers();
    safeClose(openaiWs, "twilio-closed");
    await hangupCallIfPossible(callSid);
  });

  twilioWs.on("error", (e) => console.error("Twilio WS error:", e?.message || e));
});

server.listen(PORT, () => console.log(`Media bridge running on ${PORT}`));

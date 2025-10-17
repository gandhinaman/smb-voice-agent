// server.js (ESM)

import http from "http";
import { WebSocketServer } from "ws";

// --- env ---
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Optional: if set, we can hang up the PSTN call when AI is done
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// ---------- helpers (binary/audio) ----------
function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function base64ToUint8Array(base64) {
  const bin = Buffer.from(base64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
function uint8ArrayToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
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
  // naive 3x upsample to 24 kHz
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s = pcm8k[i];
    pcm24k[i * 3] = s;
    pcm24k[i * 3 + 1] = s;
    pcm24k[i * 3 + 2] = s;
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
      if (s <= (0xff << e)) { exp = e; break; }
    }
    const man = (s >> (exp + 3)) & 0x0F;
    return ~(sign | (exp << 4) | man);
  };
  const pcm24 = new Int16Array(pcm24kData.buffer, pcm24kData.byteOffset, Math.floor(pcm24kData.byteLength / 2));
  const pcm8 = new Int16Array(Math.floor(pcm24.length / 3));
  for (let i = 0; i < pcm8.length; i++) pcm8[i] = pcm24[i * 3];
  const mulaw = new Uint8Array(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) mulaw[i] = pcmToMulaw(pcm8[i]);
  return mulaw;
}

// Optional: hang up the PSTN call via Twilio REST
async function hangupCallIfPossible(callSid) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: "completed" });
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    console.log("☎️ Twilio hangup status:", res.status);
  } catch (e) {
    console.error("☎️ Twilio hangup failed:", e);
  }
}

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/media") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ---------- per-connection state ----------
wss.on("connection", async (twilioWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let firstName =
    url.searchParams.get("firstName") ||
    "there";
  let bookingId = url.searchParams.get("bookingId") || null;

  let openaiWs = null;
  let streamSid = null;
  let callSid = null;

  let outMuLawBuffer = new Uint8Array(0);
  let flushTimer = null;
  let keepaliveTimer = null;
  let healthTimer = null;
  let idleTimer = null;
  let lastActivity = Date.now();

  const CHUNK = 160; // 20 ms @ 8 kHz μ-law

  function startFlusher() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      try {
        if (!streamSid || twilioWs.readyState !== twilioWs.OPEN) return;
        if (outMuLawBuffer.length >= CHUNK) {
          const slice = outMuLawBuffer.subarray(0, CHUNK);
          outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
          const payload = uint8ArrayToBase64(slice);
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
        } else {
          // cheap keepalive mark when we have no audio to send
          twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tick" } }));
        }
      } catch (e) {
        console.error("flusher error:", e);
      }
    }, 20);
  }

  function stopTimers() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }

  function safeCloseTwilio(code = 1000, reason = "normal") {
    try {
      if (twilioWs.readyState === twilioWs.OPEN) twilioWs.close(code, reason);
    } catch {}
  }
  function safeCloseOpenAI(code = 1000, reason = "normal") {
    try {
      if (openaiWs && openaiWs.readyState === openaiWs.OPEN) openaiWs.close(code, reason);
    } catch {}
  }

  // --- OpenAI Realtime connection ---
  async function connectOpenAI() {
    if (!OPENAI_API_KEY) {
      console.error("Missing OPENAI_API_KEY");
      return;
    }
    try {
      // ephemeral token
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
        console.error("OpenAI token error:", await tokenRes.text());
        return;
      }
      const tokenData = await tokenRes.json();
      const eph = tokenData?.client_secret?.value;
      if (!eph) {
        console.error("No ephemeral token returned");
        return;
      }

      openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        ["realtime", `openai-insecure-api-key.${eph}`, "openai-beta.realtime-v1"]
      );

      openaiWs.onopen = () => {
        lastActivity = Date.now();
        // Configure consultative session
        openaiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: `
You are Alex, a Digital Sales Specialist with Microsoft. You’re calling ${firstName} about practical ways to improve small-business security. Your goal is to determine if a short follow-up call with a Security Specialist would be useful — not to hard sell.

Principles:
- Keep turns short: one sentence or one question, then stop and wait.
- Use ${firstName}'s name occasionally, every 2 to 3 exchanges.
- Never ask what tools they currently use.
- Acknowledge what they say and ask one clear next question.
- Be consultative. Offer a quick fact only when it helps them decide.
- If they’re thinking it through, compare simple ROI or risk in one line, then ask a question.
- If they’re not ready, propose a brief specialist call and give two concrete time options. After they pick one, confirm day, calendar date, and local time in words, then stop.

Helpful fact nuggets (use sparingly, max one at a time, only when relevant):
- Many attacks target small and mid-size businesses.
- A single breach can cost hundreds of thousands of dollars including downtime and recovery.
- Microsoft Security is trusted by a large number of businesses.

Politeness and exit:
- If they decline clearly, thank them and wrap up.
- Do not monologue. Keep it conversational and brief.
            `.trim(),
            voice: "ash",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1000 },
            temperature: 0.7
          }
        }));

        // Short opening, then stop
        setTimeout(() => {
          if (openaiWs?.readyState !== openaiWs.OPEN) return;
          openaiWs.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: `Say only: "Hi ${firstName}, this is Alex with Microsoft Security. Do you have a quick minute for one question?" Then stop and wait.`
            }
          }));
        }, 300);
      };

      // OpenAI → Twilio audio bridge and transcript capture
      openaiWs.onmessage = (evt) => {
        try {
          lastActivity = Date.now();
          const data = JSON.parse(evt.data);
          if (data.type === "response.audio.delta" && data.delta) {
            const mulaw = convertPCM16ToMulaw(base64ToUint8Array(data.delta));
            outMuLawBuffer = concatUint8(outMuLawBuffer, mulaw);
          }
        } catch (e) {
          console.error("OpenAI message error:", e);
        }
      };

      openaiWs.onclose = async (evt) => {
        console.log("🔌 OpenAI closed", evt.code, evt.reason, evt.wasClean);
        // close Twilio stream and optionally hang up the call
        safeCloseTwilio(1000, "openai-closed");
        await hangupCallIfPossible(callSid);
      };

      openaiWs.onerror = (e) => {
        console.error("OpenAI WS error:", e?.message || e);
      };
    } catch (e) {
      console.error("connectOpenAI error:", e);
    }
  }

  // --- Twilio stream handlers ---
  twilioWs.on("open", () => {
    console.log("✅ Twilio WS connected");
  });

  twilioWs.on("message", async (raw) => {
    try {
      lastActivity = Date.now();
      const msg = JSON.parse(raw.toString());

      switch (msg.event) {
        case "start": {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;

          // allow <Parameter name="firstName"> or query ?firstName=
          const startUrl = msg.start.streamUrl ? new URL(msg.start.streamUrl) : null;
          const fromParam =
            (msg.start.customParameters && msg.start.customParameters.firstName) ||
            (startUrl && startUrl.searchParams.get("firstName"));
          if (fromParam && (!firstName || firstName === "there")) firstName = fromParam;

          console.log("📞 start: streamSid", streamSid, "callSid", callSid, "firstName", firstName, "bookingId", bookingId);
          startFlusher();

          // keepalives and health logs
          keepaliveTimer = setInterval(() => {
            if (twilioWs.readyState === twilioWs.OPEN && streamSid) {
              try {
                twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "keepalive" } }));
              } catch {}
            }
          }, 3000);

          healthTimer = setInterval(() => {
            const idle = Date.now() - lastActivity;
            console.log("🏥 health", { twilio: twilioWs.readyState, openai: openaiWs?.readyState, idleMs: idle, outBuf: outMuLawBuffer.length });
          }, 5000);

          // idle shutdown if nothing happens for 45s
          idleTimer = setInterval(async () => {
            const idle = Date.now() - lastActivity;
            if (idle > 45000) {
              console.log("⏱️ Ending inactive call session");
              stopTimers();
              safeCloseOpenAI(1000, "idle-timeout");
              safeCloseTwilio(1000, "idle-timeout");
              await hangupCallIfPossible(callSid);
            }
          }, 5000);

          await connectOpenAI();
          break;
        }

        case "media": {
          if (openaiWs?.readyState === openaiWs.OPEN) {
            try {
              const pcm24 = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
              const b64 = uint8ArrayToBase64(pcm24);
              openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
            } catch (e) {
              console.error("to OpenAI audio error:", e);
            }
          }
          break;
        }

        case "mark":
          // ignore
          break;

        case "stop": {
          console.log("🛑 Twilio stop event, closing both sockets");
          stopTimers();
          safeCloseOpenAI(1000, "twilio-stop");
          safeCloseTwilio(1000, "twilio-stop");
          await hangupCallIfPossible(callSid);
          break;
        }

        default:
          console.log("⚠️ Unknown Twilio event:", msg.event);
      }
    } catch (e) {
      console.error("Twilio msg error:", e);
    }
  });

  twilioWs.on("close", async () => {
    console.log("🔌 Twilio WS closed");
    stopTimers();
    safeCloseOpenAI(1000, "twilio-closed");
    await hangupCallIfPossible(callSid);
  });

  twilioWs.on("error", (e) => {
    console.error("Twilio WS error:", e?.message || e);
  });
});

server.listen(PORT, () => {
  console.log(`Media bridge running on ${PORT}`);
});

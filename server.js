// server.js (ESM) — Render media bridge for Twilio <Stream> ↔ OpenAI Realtime
// Node 18+ with "type": "module" in package.json

import http from "node:http";
import { parse as parseUrl } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

// ---------- env ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---------- utilities ----------
const log = (...a) => console.log(new Date().toISOString(), ...a);

function base64ToUint8Array(base64) {
  const bin = Buffer.from(base64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
function uint8ArrayToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// μ-law 8 kHz → PCM16 24 kHz
function convertMulawToPCM16(mulawData) {
  const mulawToPcm = (x) => {
    x = ~x;
    const sign = x & 0x80;
    const exp = (x >> 4) & 7;
    const man = x & 0x0f;
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
    pcm24k[i * 3] = s;
    pcm24k[i * 3 + 1] = s;
    pcm24k[i * 3 + 2] = s;
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
      if (s <= (0xff << e)) { exp = e; break; }
    }
    const man = (s >> (exp + 3)) & 0x0f;
    return ~(sign | (exp << 4) | man);
  };
  const pcm24 = new Int16Array(pcm24kData.buffer, pcm24kData.byteOffset, Math.floor(pcm24kData.byteLength / 2));
  const pcm8 = new Int16Array(Math.floor(pcm24.length / 3));
  for (let i = 0; i < pcm8.length; i++) pcm8[i] = pcm24[i * 3];
  const mulaw = new Uint8Array(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) mulaw[i] = pcmToMulaw(pcm8[i]);
  return mulaw;
}

// ---------- HTTP (health) ----------
const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// ---------- WS UPGRADE ----------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parseUrl(req.url, true);
  if (pathname === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, query);
    });
  } else {
    socket.destroy();
  }
});

// ---------- CONNECTION HANDLER ----------
wss.on("connection", (twilioWs, req, query) => {
  // Per-call state
  let streamSid = null;
  let callSid = null;

  // From query (belt) — will also try to read from Twilio "start" customParameters
  let bookingId = query?.bookingId || null;
  let firstFromQuery = query?.firstName || null;

  // Effective first name
  let effectiveFirst = (firstFromQuery && String(firstFromQuery).trim()) || "there";

  // OpenAI
  let openaiWs = null;
  const openaiOpen = () => openaiWs && openaiWs.readyState === WebSocket.OPEN;
  let gotAnyOpenAIAudio = false;

  // Pacing to Twilio
  let outMuLawBuffer = new Uint8Array(0);
  const CHUNK = 160; // 20 ms at 8k μ-law
  let flusher = null;

  // Timers
  let healthTimer = null;
  let vadTimer = null;
  let lastActivity = Date.now();
  let lastCallerAudioAt = 0;

  const clearTimers = () => {
    if (flusher) { clearInterval(flusher); flusher = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
  };

  log("start", { streamSid, callSid, bookingId, firstName: effectiveFirst });

  // 20ms audio flusher → Twilio
  flusher = setInterval(() => {
    try {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
      if (outMuLawBuffer.length >= CHUNK) {
        const slice = outMuLawBuffer.subarray(0, CHUNK);
        outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: uint8ArrayToBase64(slice) }
        }));
      } else {
        // lightweight mark to keep stream alive
        twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tick" } }));
      }
    } catch (e) {
      log("flusher error:", e?.message || e);
    }
  }, 20);

  // Connection health logs
  healthTimer = setInterval(() => {
    log("health", {
      twilio: twilioWs.readyState,
      openai: openaiWs ? openaiWs.readyState : -1,
      idleMs: Date.now() - lastActivity,
      outBuf: outMuLawBuffer.length
    });
  }, 5000);

  // Simple server-side VAD → commit utterances if silence > 700ms
  vadTimer = setInterval(() => {
    const now = Date.now();
    if (openaiOpen() && lastCallerAudioAt && (now - lastCallerAudioAt) > 700) {
      try {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {}
      lastCallerAudioAt = 0;
    }
  }, 120);

  // ---------- Twilio socket events ----------
  twilioWs.on("message", async (event) => {
    try {
      lastActivity = Date.now();
      const msg = JSON.parse(event.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;

        // Extract bookingId / firstName from customParameters if present
        const cp = msg.start.customParameters || {};
        if (!bookingId && cp.bookingId) bookingId = cp.bookingId;
        if (cp.firstName && String(cp.firstName).trim()) {
          effectiveFirst = String(cp.firstName).trim();
        }

        log("twilio start", { streamSid, callSid, bookingId, firstName: effectiveFirst });
        await connectOpenAIAndGreet(effectiveFirst);

      } else if (msg.event === "media") {
        lastCallerAudioAt = Date.now();
        if (openaiOpen()) {
          try {
            const audio = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: uint8ArrayToBase64(audio)
            }));
          } catch (e) {
            log("forward media error:", e?.message || e);
          }
        }

      } else if (msg.event === "mark") {
        // ignore

      } else if (msg.event === "stop") {
        log("🛑 Twilio stop event");
        // Close both sockets; Twilio will hang up the call
        try { if (openaiOpen()) openaiWs.close(1000, "twilio-stop"); } catch {}
        try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, "twilio-stop"); } catch {}

      } else {
        // ignore other events
      }
    } catch (e) {
      log("Twilio msg error:", e?.message || e);
    }
  });

  twilioWs.on("close", () => {
    log("Twilio closed");
    clearTimers();
    try { if (openaiOpen()) openaiWs.close(1000, "twilio-closed"); } catch {}
  });

  twilioWs.on("error", (e) => log("Twilio ws error:", e?.message || e));

  // ---------- OpenAI Realtime ----------
  async function connectOpenAIAndGreet(firstName) {
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
        const txt = await tokenRes.text();
        log("OpenAI token error:", txt);
        return;
      }
      const tokenData = await tokenRes.json();
      const eph = tokenData?.client_secret?.value;
      if (!eph) {
        log("OpenAI token missing client_secret.value");
        return;
      }

      openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        ["realtime", `openai-insecure-api-key.${eph}`, "openai-beta.realtime-v1"]
      );

      openaiWs.on("open", () => {
        gotAnyOpenAIAudio = false;

        // Configure session (consultative, short-turn)
        openaiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            voice: "ash",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1000 },
            temperature: 0.8,
            instructions: [
              `You are Alex from Microsoft having a short, consultative conversation about small-business security with ${firstName}.`,
              `Goal: politely qualify and book a follow-up with a Security Specialist. Use ONE–TWO sentence turns; ask one question, then pause.`,
              `Tone: calm, helpful, not salesy. Avoid product names unless asked.`,
              `Use the first name naturally every 2–3 turns.`,
              `NEVER ask what tools/brands they use (competitive info).`,
              `If they’re busy, offer a quick reschedule instead of pushing.`,
              `Use concise nuggets only when helpful: “~43% of attacks target small businesses”; “A breach can cost ~$200k on average”; “Hundreds of thousands of businesses use Microsoft security.”`,
              `Adapt: if they’re already thinking about next steps, mention ROI/time-saved. If they’re unsure, clarify what they’re protecting (data, devices, email).`,
              `When there’s interest, offer 2–3 appointment slots (Tue 2pm, Wed 10am, Thu 2pm, Fri 11am — caller’s local time). Confirm once picked.`,
              `Only end when they clearly disengage or firmly decline multiple times.`
            ].join("\n")
          }
        }));

        // Initial greeting
        setTimeout(() => {
          if (!openaiOpen()) return;
          openaiWs.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: `Hi ${firstName}, this is Alex from Microsoft. Do you have a quick minute to talk about keeping your business secure?`
            }
          }));

          // Re-prompt once if we never get any audio deltas
          setTimeout(() => {
            if (openaiOpen() && !gotAnyOpenAIAudio) {
              openaiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["text", "audio"],
                  instructions: `Just briefly, ${firstName}: I can share one quick tip and set up a short follow-up if it’s useful—does that work?`
                }
              }));
            }
          }, 2000);
        }, 150);
      });

      openaiWs.on("message", (event) => {
        try {
          lastActivity = Date.now();
          const data = JSON.parse(event.toString());

          if (data.type === "response.audio.delta" && data.delta) {
            gotAnyOpenAIAudio = true;
            const mu = convertPCM16ToMulaw(base64ToUint8Array(data.delta));
            outMuLawBuffer = concatUint8(outMuLawBuffer, mu);
          } else if (data.type === "conversation.item.input_audio_transcription.completed") {
            log("user said:", data.transcript);
          } else if (data.type === "response.audio_transcript.done") {
            log("ai said:", data.transcript);
          } else if (data.type === "response.completed") {
            // turn ended; nothing to do
          }
        } catch (e) {
          log("OpenAI msg error:", e?.message || e);
        }
      });

      openaiWs.on("close", (ev) => {
        log("OpenAI closed", ev.code, ev.reason || "");
        // close Twilio if still open
        try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, "openai-closed"); } catch {}
      });

      openaiWs.on("error", (e) => log("OpenAI ws error:", e?.message || e));
    } catch (e) {
      log("connectOpenAI error:", e?.message || e);
    }
  }
});

// ---------- start server ----------
server.listen(PORT, () => {
  log("Media bridge running on", PORT);
  log("==> Your service is live 🎉");
  log("==> Available at", `https://twilio-media-bridge-<random>.onrender.com (or your service URL)`);
});

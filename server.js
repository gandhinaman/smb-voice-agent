// server.js — Twilio <Stream> ↔ OpenAI Realtime bridge (Node 18+, "type":"module")

import http from "node:http";
import { parse as parseUrl } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---------- small helpers ----------
const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
const u8ToB64 = (u8) => Buffer.from(u8).toString("base64");
const concatU8 = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

// ---------- μ-law/PCM ----------
function mulawToPcm16Byte(m) {
  m = ~m;
  const s = m & 0x80;
  const e = (m >> 4) & 7;
  const x = m & 0x0f;
  let t = (x << 3) + 0x84;
  t <<= e;
  t -= 0x84;
  return s ? -t : t;
}
function pcm16ToMulawByte(pcm) {
  const sign = pcm < 0 ? 0x80 : 0x00;
  let s = Math.abs(pcm);
  s = Math.min(s, 32635);
  s += 0x84;
  let e = 7;
  for (let i = 0; i < 8; i++) {
    if (s <= (0xff << i)) { e = i; break; }
  }
  const x = (s >> (e + 3)) & 0x0f;
  return ~(sign | (e << 4) | x);
}
function mulaw8kToPcm24k(u8) {
  const pcm8 = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) pcm8[i] = mulawToPcm16Byte(u8[i]);
  const pcm24 = new Int16Array(pcm8.length * 3);
  for (let i = 0; i < pcm8.length; i++) {
    const s = pcm8[i];
    pcm24[i * 3] = s;
    pcm24[i * 3 + 1] = s;
    pcm24[i * 3 + 2] = s;
  }
  return new Uint8Array(pcm24.buffer);
}
function pcm24kToMulaw8k(u8pcm24) {
  const pcm24 = new Int16Array(u8pcm24.buffer, u8pcm24.byteOffset, u8pcm24.byteLength / 2);
  const pcm8 = new Int16Array(Math.floor(pcm24.length / 3));
  for (let i = 0; i < pcm8.length; i++) pcm8[i] = pcm24[i * 3];
  const out = new Uint8Array(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) out[i] = pcm16ToMulawByte(pcm8[i]);
  return out;
}

// ---------- Beep generator ----------
function makeBeepMs(ms = 400) {
  const sr = 8000;
  const n = Math.floor((ms / 1000) * sr);
  const pcm = new Int16Array(n);
  const f = 1000;
  for (let i = 0; i < n; i++) pcm[i] = Math.floor(Math.sin((2 * Math.PI * f * i) / sr) * 12000);
  const mu = new Uint8Array(n);
  for (let i = 0; i < n; i++) mu[i] = pcm16ToMulawByte(pcm[i]);
  return mu;
}
const BEEP = makeBeepMs(400);

// ---------- HTTP (health) ----------
const httpServer = http.createServer((req, res) => {
  if (req.url?.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
  } else {
    res.writeHead(404); res.end("Not found");
  }
});

// ---------- WS upgrade ----------
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parseUrl(req.url, true);
  if (pathname === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, query);
    });
  } else socket.destroy();
});

// ---------- Bridge logic ----------
wss.on("connection", (twilioWs, req, query) => {
  const bookingId = query?.bookingId || null;
  let firstName = query?.firstName || "there";
  let openaiWs = null;
  let outMu = new Uint8Array(0);
  const CHUNK = 160;

  log("🔗 WS connected", { bookingId, firstName });

  // ---- Twilio → OpenAI ----
  twilioWs.on("message", async (evt) => {
    const msg = JSON.parse(evt.toString());
    if (msg.event === "start") {
      log("▶ START", msg.start.customParameters);
      const cp = msg.start.customParameters || {};
      if (cp.firstName && cp.firstName.trim()) firstName = cp.firstName;
      outMu = concatU8(outMu, BEEP); // prove audio path
      await connectOpenAI(firstName, twilioWs);
    } else if (msg.event === "media" && openaiWs?.readyState === WebSocket.OPEN) {
      const pcm24 = mulaw8kToPcm24k(b64ToU8(msg.media.payload));
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: u8ToB64(pcm24)
      }));
    } else if (msg.event === "stop") {
      log("🛑 STOP received");
      openaiWs?.close(1000, "twilio-stop");
      twilioWs?.close(1000, "twilio-stop");
    }
  });
});

// ---------- Connect to OpenAI ----------
async function connectOpenAI(firstName, twilioWs) {
  const tRes = await fetch("https://api.openai.com/v1/realtime/sessions", {
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
  if (!tRes.ok) {
    log("❌ token error:", await tRes.text());
    return;
  }
  const eph = (await tRes.json())?.client_secret?.value;
  if (!eph) return log("❌ no ephemeral token");

  const oai = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    ["realtime", `openai-insecure-api-key.${eph}`, "openai-beta.realtime-v1"]
  );

  let outMu = new Uint8Array(0);
  const CHUNK = 160;
  const flushTimer = setInterval(() => {
    if (twilioWs.readyState !== WebSocket.OPEN) return;
    if (outMu.length >= CHUNK) {
      const slice = outMu.subarray(0, CHUNK);
      outMu = outMu.subarray(CHUNK);
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: "fake",
        media: { payload: u8ToB64(slice) }
      }));
    }
  }, 20);

  oai.on("open", () => {
    log("OAI ▶ open");

    // Consultative session setup
    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "ash",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1000 },
        temperature: 0.8,
        instructions: `
You are Alex from Microsoft, having a consultative conversation about small-business security with ${firstName}.
Goal: politely engage and see if a short specialist follow-up makes sense.
Use ${firstName}'s name naturally, keep each turn short (1–2 sentences), and never stack multiple facts.
Use quick, relevant nuggets only when helpful:
- About 43% of cyberattacks target small and mid-sized businesses.
- The average breach costs around $200,000, including downtime and recovery.
- Many SMBs use Microsoft Security for identity, email, and device protection.
Be conversational and human. If ${firstName} is busy, ask for a better time. If they’re engaged, offer 2–3 appointment slots (Tue 2, Wed 10, Thu 2). Confirm and stop.`
      }
    }));

    // Initial greeting
    oai.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        audio: { voice: "ash" },
        instructions: `Hi ${firstName}, this is Alex from Microsoft. Do you have a quick minute to talk about keeping your business secure?`
      }
    }));
  });

  oai.on("message", (evt) => {
    const data = JSON.parse(evt.toString());
    if (data.type === "response.audio.delta" && data.delta) {
      const mu = pcm24kToMulaw8k(b64ToU8(data.delta));
      outMu = concatU8(outMu, mu);
    } else if (data.type !== "response.audio.delta") {
      log("OAI ▶", data.type);
    }
  });

  oai.on("close", (e) => {
    clearInterval(flushTimer);
    log("OAI ▶ closed", e.code, e.reason || "");
    try { twilioWs.close(1000, "oai-closed"); } catch {}
  });

  oai.on("error", (e) => log("OAI ▶ error", e?.message || e));
}

// ---------- start ----------
httpServer.listen(PORT, () => log(`Media bridge running on ${PORT}`));

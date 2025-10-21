// server.js — Twilio <Stream> ↔ OpenAI Realtime bridge (Node 18+, "type":"module")

import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";

// -------- env --------
const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// -------- Supabase fetch for name fallback --------
async function fetchFirstNameByBookingId(bookingId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !bookingId) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}&select=customer_name`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!res.ok) {
      log("Supabase name fetch failed:", res.status, await res.text());
      return null;
    }
    const rows = await res.json();
    const full = rows?.[0]?.customer_name || "";
    const f = (full.split(" ").filter(Boolean)[0]) || null;
    return f;
  } catch (e) {
    log("Supabase name fetch error:", e);
    return null;
  }
}

// ---------- HTTP (health) ----------
const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
  } else {
    res.writeHead(404); res.end("Not found");
  }
});

// ---------- WS upgrade ----------
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/media") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, u);
      });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

// ---------- Bridge logic ----------
wss.on("connection", (twilioWs, req, urlObj) => {
  let bookingId = urlObj.searchParams.get("bookingId");
  let firstName = urlObj.searchParams.get("firstName") || "there";
  let streamSid = null;

  let openaiWs = null;
  let outMu = new Uint8Array(0);
  const CHUNK = 160;

  log("🔗 WS connected", { bookingId, firstName });

  const flushTimer = setInterval(() => {
    try {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
      if (outMu.length >= CHUNK) {
        const slice = outMu.subarray(0, CHUNK);
        outMu = outMu.subarray(CHUNK);
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: u8ToB64(slice) }
        }));
      } else {
        twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tick" } }));
      }
    } catch (e) {
      log("flush error:", e);
    }
  }, 20);

  twilioWs.on("message", async (evt) => {
    const msg = JSON.parse(evt.toString());

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;

      // Prefer customParameters
      const cp = msg.start.customParameters || {};
      if (!bookingId && cp.bookingId) bookingId = cp.bookingId;
      if ((!firstName || firstName === "there") && cp.firstName) firstName = cp.firstName;

      // Fallback to Supabase lookup if still missing name
      if ((!firstName || firstName === "there") && bookingId) {
        const f = await fetchFirstNameByBookingId(bookingId);
        if (f) firstName = f;
      }

      log("▶ START", { streamSid, bookingId, firstName });

      // Connect OpenAI
      await connectOpenAI(firstName, twilioWs, () => streamSid, (muChunk) => {
        outMu = concatU8(outMu, muChunk);
      });

    } else if (msg.event === "media") {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        const pcm24 = mulaw8kToPcm24k(b64ToU8(msg.media.payload));
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: u8ToB64(pcm24)
        }));
      }
    } else if (msg.event === "stop") {
      log("🛑 STOP received");
      try { openaiWs?.close(1000, "twilio-stop"); } catch {}
      try { twilioWs?.close(1000, "twilio-stop"); } catch {}
      clearInterval(flushTimer);
    }
  });

  twilioWs.on("close", () => {
    log("Twilio closed");
    try { openaiWs?.close(1000, "twilio-closed"); } catch {}
    clearInterval(flushTimer);
  });

  twilioWs.on("error", (e) => log("Twilio WS error:", e?.message || e));

  function setOpenAI(ws) { openaiWs = ws; }
  twilioWs._setOpenAI = setOpenAI;
});

// ---------- Connect to OpenAI ----------
async function connectOpenAI(firstName, twilioWs, getStreamSid, pushMuLaw) {
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
  twilioWs._setOpenAI?.(oai);

  oai.on("open", () => {
    log("OAI ▶ open");

    // Configure concise, consultative session with voice here
    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "ash",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 900 },
        temperature: 0.7,
        instructions: `
You are Alex from Microsoft, having a brief, consultative chat about small-business security with ${firstName}.
Goal: understand where they are and see if a short specialist follow-up makes sense. Keep each turn to 1–2 sentences.
Use one nugget only when helpful, not all at once:
- About 43% of cyberattacks target SMBs.
- A breach can cost around $200,000 including downtime and recovery.
- Many SMBs rely on Microsoft Security across identity, email, and devices.
Tactics:
- Start with a light opener and one question.
- If they seem uncertain, briefly frame ROI or risk in plain language and ask a single follow-up.
- If engaged, offer two or three specific time options for a specialist call (Tue 2, Wed 10, Thu 2). Then confirm and stop.
- If busy, ask for a better time instead of pushing details.
Avoid: long monologues, tool comparisons, or asking what vendor they use.`
      }
    }));

    // Initial greeting — no per-response audio object
    oai.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: `Hi ${firstName}, this is Alex from Microsoft. Do you have a quick minute to talk about keeping your business secure?`
      }
    }));
  });

  oai.on("message", (evt) => {
    const data = JSON.parse(evt.toString());
    if (data.type === "response.audio.delta" && data.delta) {
      const mu = pcm24kToMulaw8k(b64ToU8(data.delta));
      pushMuLaw(mu);
    } else if (data.type === "error") {
      log("OAI ▶ error", JSON.stringify(data, null, 2));
    } else if (data.type !== "response.audio.delta") {
      log("OAI ▶", data.type);
    }
  });

  oai.on("close", (e) => {
    log("OAI ▶ closed", e.code, e.reason || "");
    const sid = getStreamSid();
    if (sid && twilioWs.readyState === WebSocket.OPEN) {
      try { twilioWs.close(1000, "oai-closed"); } catch {}
    }
  });

  oai.on("error", (e) => log("OAI ▶ error", e?.message || e));
}

// ---------- start ----------
httpServer.listen(PORT, () => log(`Media bridge running on ${PORT}`));

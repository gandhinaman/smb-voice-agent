// server.js (ESM)
// Run: node server.js
// Env needed: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import http from "http";
import { WebSocketServer } from "ws";
import { URL } from "url";

const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing required env vars: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

// ---------- WebSocket (Twilio <Connect><Stream>) ----------
const wss = new WebSocketServer({ noServer: true });

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

// ----- Utilities -----
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
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

// μ-law 8 kHz → PCM16 24 kHz (naive 3x upsample)
function convertMulawToPCM16(mulawData) {
  const mulawToPcm = (x) => {
    x = ~x & 0xff;
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

// PCM16 24 kHz → μ-law 8 kHz (downsample by 3)
function convertPCM16ToMulaw(pcm24kData) {
  const pcmToMulaw = (pcm) => {
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
    return ~(sign | (exp << 4) | man) & 0xff;
  };

  const pcm24 = new Int16Array(
    pcm24kData.buffer,
    pcm24kData.byteOffset,
    Math.floor(pcm24kData.byteLength / 2)
  );
  const pcm8 = new Int16Array(Math.floor(pcm24.length / 3));
  for (let i = 0; i < pcm8.length; i++) pcm8[i] = pcm24[i * 3];

  const mu = new Uint8Array(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) mu[i] = pcmToMulaw(pcm8[i]);
  return mu;
}

// Supabase REST fetch
async function fetchBooking(bookingId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) {
      console.error("Supabase fetch error:", res.status, await res.text());
      return null;
    }
    const arr = await res.json();
    return arr?.[0] || null;
  } catch (e) {
    console.error("Supabase fetch exception:", e);
    return null;
  }
}

async function patchBooking(bookingId, body) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(bookingId)}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Supabase patch exception:", e);
  }
}

// ----- OpenAI realtime connect -----
function buildConsultativeInstructions(firstName) {
  return `
You are the CALLER named **Alex**, from Microsoft’s **SMB Security Digital Sales** team.
You are calling **${firstName}** (the prospect). You speak as Alex; ${firstName} is the other person.

STRICT ROLE & VOICE
- Always speak as Alex (the caller). Never imitate or speak as ${firstName}.
- Never start with "Hi Alex" unless the callee’s name is Alex. If you say your own name, it must be “This is Alex”.
- Keep each turn short (one sentence or a single question), then STOP to listen.
- Respond only to what you actually hear from ${firstName}. Do **not** invent their words.

OPENING & FLOW
- Open clearly: who you are, why you're calling (Microsoft SMB Security), ask if they have a quick minute.
- Be consultative: ask one focused question, then wait.
- Use *light* facts only when helpful (avoid stacking):
  • Roughly 40–45% of attacks hit small businesses.
  • A single breach can cost into six figures including downtime & recovery.
  • Many SMBs rely on Microsoft Security across identity, email, and devices.
- If engaged: offer a short follow-up with a Security Specialist and propose 1–2 concrete times; confirm day/time.
- If hesitant: briefly frame ROI/risk and ask one clarifying question.
- If busy: politely ask for a better time.
- Avoid asking which vendors/tools they currently use.

ENDING
- If they clearly decline multiple times or you deliver a natural goodbye, keep it brief and stop talking.
`.trim();
}

function farewellHeard(text) {
  const t = (text || "").toLowerCase();
  return /\b(thanks.*(your|the) time|have a (great|good) (day|one)|goodbye|bye for now|speak soon)\b/i.test(t);
}

wss.on("connection", async (twilioWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let bookingId = url.searchParams.get("bookingId") || null;
  let firstName = "there";
  let streamSid = null;

  let openaiWs = null;
  let outMuLawBuffer = new Uint8Array(0);
  let flusher = null;
  let keepAlive = null;
  let greetedOnce = false;
  const convo = [];
  const callStart = Date.now();

  const endCall = (reason = "normal-end") => {
    try {
      if (openaiWs && openaiWs.readyState === 1) openaiWs.close(1000, reason);
    } catch {}
    try {
      if (twilioWs && twilioWs.readyState === 1) twilioWs.close(1000, reason);
    } catch {}
    if (flusher) clearInterval(flusher);
    if (keepAlive) clearInterval(keepAlive);
  };

  const saveAndClose = async (source) => {
    if (!bookingId) return endCall("no-booking");
    const dur = Math.floor((Date.now() - callStart) / 1000);
    const formatted = convo.length
      ? convo.map(i => `[${new Date(i.t).toLocaleString()}] ${i.who}: ${i.msg}`).join("\n\n")
      : "No conversation captured";

    const text = convo.map(i => i.msg.toLowerCase()).join(" ");
    const hasCustomer = convo.some(i => i.who === "Customer");
    const answered = hasCustomer || dur > 10;

    // very light booking detection (unchanged)
    const agree = [
      /\b(yes|yeah|sure|sounds good|that works|perfect|great|okay)\b.*\b(monday|tuesday|wednesday|thursday|friday)\b/i,
      /\b(monday|tuesday|wednesday|thursday|friday)\b.*\b(works|good|fine|perfect)\b/i,
      /\b(schedule|book|set up|arrange)\b.*\b(appointment|meeting|consultation|consult|call)\b/i
    ].some(p => p.test(text));
    const strongNo = [
      /\bnot interested\b/i,
      /\bstop calling\b/i,
      /\bno thanks\b/i
    ].some(p => p.test(text));

    const status = !answered ? "no_answer" : agree ? "scheduled" : strongNo ? "not_interested" : "completed";

    await patchBooking(bookingId, {
      conversation_summary: formatted,
      booking_status: status,
      call_duration: dur,
      call_answered: answered,
      customer_transcript: convo.filter(i => i.who === "Customer").map(i => i.msg).join("\n") || "No customer speech captured",
      close_source: source,
    });

    endCall(source);
  };

  console.log(new Date().toISOString(), "🔗 WS connected", { bookingId, firstName });

  // 20ms flusher for μ-law → Twilio
  const CHUNK = 160; // 20ms @ 8kHz μ-law
  flusher = setInterval(() => {
    try {
      if (!streamSid || twilioWs.readyState !== 1) return;
      if (outMuLawBuffer.length >= CHUNK) {
        const slice = outMuLawBuffer.subarray(0, CHUNK);
        outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: uint8ArrayToBase64(slice) },
        }));
      } else {
        // keepalive mark keeps Twilio happy when AI is idle
        twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tick" } }));
      }
    } catch (e) {
      console.error("Flusher error:", e);
    }
  }, 20);

  // Twilio message handling
  twilioWs.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;

        // Resolve bookingId from customParameters or streamUrl fallback
        if (!bookingId) {
          bookingId = msg.start?.customParameters?.bookingId || null;
          if (!bookingId && msg.start?.streamUrl) {
            const su = new URL(msg.start.streamUrl);
            bookingId = su.searchParams.get("bookingId");
          }
        }

        // Fetch first name from Supabase
        if (bookingId) {
          const booking = await fetchBooking(bookingId);
          if (booking?.customer_name) {
            const parts = String(booking.customer_name).trim().split(/\s+/);
            if (parts.length) firstName = parts[0];
          }
        }

        console.log(new Date().toISOString(), "▶ START", { streamSid, bookingId, firstName });

        // Connect to OpenAI
        await connectOpenAI(firstName);

      } else if (msg.event === "media") {
        // Customer audio → OpenAI
        if (openaiWs?.readyState === 1) {
          const mulawBytes = base64ToUint8Array(msg.media.payload);
          const pcm24 = convertMulawToPCM16(mulawBytes);
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: uint8ArrayToBase64(pcm24) }));
        }
      } else if (msg.event === "mark") {
        // no-op
      } else if (msg.event === "stop") {
        console.log(new Date().toISOString(), "🛑 STOP received");
        await saveAndClose("twilio-stop");
      }
    } catch (e) {
      console.error("Twilio msg error:", e);
    }
  });

  twilioWs.on("close", () => {
    console.log(new Date().toISOString(), "Twilio closed");
    endCall("twilio-closed");
  });

  twilioWs.on("error", (e) => {
    console.error("Twilio WS error:", e);
    endCall("twilio-error");
  });

  // ----- OpenAI realtime wiring -----
  async function connectOpenAI(firstNameForPrompt) {
    try {
      // Ephemeral token
      const tokRes = await fetch("https://api.openai.com/v1/realtime/sessions", {
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
      if (!tokRes.ok) {
        console.error("OpenAI token err:", tokRes.status, await tokRes.text());
        return;
      }
      const tok = await tokRes.json();
      const eph = tok.client_secret.value;

      openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        ["realtime", `openai-insecure-api-key.${eph}`, "openai-beta.realtime-v1"]
      );

      openaiWs.on("open", () => {
        console.log(new Date().toISOString(), "OAI ▶ open");

        // Configure session
        openaiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["audio","text"],
            instructions: buildConsultativeInstructions(firstNameForPrompt),
            voice: "ash",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1000 },
            temperature: 0.8,
          }
        }));

        // Force a crisp opener immediately (no initial silence)
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio","text"],
            instructions: `Hi ${firstNameForPrompt}, this is Alex with Microsoft’s SMB Security team. Do you have a quick minute to talk about keeping your business secure and whether a brief follow-up with a specialist might help?`
          }
        }));

        // If nothing came out in ~1.2s, resend once
        setTimeout(() => {
          if (!greetedOnce && openaiWs?.readyState === 1) {
            openaiWs.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio","text"],
                instructions: `Hi ${firstNameForPrompt}, this is Alex with Microsoft’s SMB Security team. Is now a bad time, or do you have a quick minute?`
              }
            }));
          }
        }, 1200);
      });

      openaiWs.on("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          const t = data.type;

          if (t === "session.created") {
            console.log(new Date().toISOString(), "OAI ▶ session.created");
          } else if (t === "session.updated") {
            console.log(new Date().toISOString(), "OAI ▶ session.updated");
          } else if (t === "error") {
            console.log(new Date().toISOString(), "OAI ▶ error", JSON.stringify(data, null, 2));
          } else if (t === "response.audio.delta" && data.delta) {
            // AI audio → Twilio (μ-law pacing)
            const mu = convertPCM16ToMulaw(base64ToUint8Array(data.delta));
            outMuLawBuffer = concatUint8(outMuLawBuffer, mu);
          } else if (t === "conversation.item.input_audio_transcription.completed") {
            convo.push({ t: new Date().toISOString(), who: "Customer", msg: data.transcript });
          } else if (t === "response.audio_transcript.delta") {
            // first audible token after our opener
            greetedOnce = true;
          } else if (t === "response.audio_transcript.done") {
            const said = (data.transcript || "").trim();
            convo.push({ t: new Date().toISOString(), who: "AI", msg: said });

            // Guard: if it wrongly says "Hi Alex" and callee isn't Alex, correct immediately
            if (/^\s*hi\s+alex\b/i.test(said) && String(firstName).toLowerCase() !== "alex") {
              try { openaiWs.send(JSON.stringify({ type: "response.cancel" })); } catch {}
              openaiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio","text"],
                  instructions: `Apologies—let me restate that. Hi ${firstName}, this is Alex with Microsoft’s SMB Security team. Do you have a quick minute to talk about keeping your business secure and whether a brief follow-up with a specialist might help?`
                }
              }));
            }

            // If it said goodbye, end the call (prevents Twilio lingering)
            if (farewellHeard(said)) {
              endCall("model-farewell");
            }
          } else if (t === "response.done") {
            // noop
          }
        } catch (e) {
          console.error("OAI msg error:", e);
        }
      });

      openaiWs.on("close", (code, reason) => {
        console.log(new Date().toISOString(), "OAI ▶ closed", code, reason);
        // If OpenAI ends first, close Twilio if still open
        if (twilioWs.readyState === 1) twilioWs.close(1000, "openai-closed");
      });

      openaiWs.on("error", (e) => {
        console.error("OpenAI WS error:", e);
      });

    } catch (e) {
      console.error("connectOpenAI error:", e);
    }
  }
});

server.listen(PORT, () => {
  console.log(new Date().toISOString(), `Media bridge running on ${PORT}`);
});

// server.js
// Node HTTP + ws (no Express) media bridge for Twilio <-> OpenAI Realtime

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws'); // force ws client
const url = require('url');

// ---- config ----
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;                    // optional, only if you log/save
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- helpers ----
const concatUint8 = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
};

const base64ToUint8Array = (b64) => {
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
};
const uint8ArrayToBase64 = (u8) => Buffer.from(u8).toString('base64');

// μ-law 8kHz -> PCM16 24kHz
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

// PCM16 24kHz -> μ-law 8kHz
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

// ---- HTTP server (health + WS upgrade) ----
const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);

  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  res.writeHead(404).end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = url.parse(req.url);

  if (pathname === '/media') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---- Per-connection state + logic ----
wss.on('connection', async (twilioWs, req) => {
  console.log('Twilio connected');

  let openaiWs = null;
  let streamSid = null;
  let outMuLawBuffer = new Uint8Array(0);
  let flusher = null;

  // 20ms flusher to pace audio toward Twilio
  const startFlusher = () => {
    if (flusher) return;
    flusher = setInterval(() => {
      try {
        if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
        const CHUNK = 160; // 20ms at 8kHz μ-law
        if (outMuLawBuffer.length >= CHUNK) {
          const slice = outMuLawBuffer.subarray(0, CHUNK);
          outMuLawBuffer = outMuLawBuffer.subarray(CHUNK);
          const payload = uint8ArrayToBase64(slice);
          twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
        } else {
          twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'tick' } }));
        }
      } catch (e) {
        console.error('Flusher error', e);
      }
    }, 20);
  };

  const stopFlusher = () => {
    if (flusher) { clearInterval(flusher); flusher = null; }
  };

  const connectOpenAI = async (firstName) => {
    // 1) get ephemeral token
    const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'ash'
      })
    });

    if (!resp.ok) {
      console.error('OpenAI token error', await resp.text());
      return;
    }
    const data = await resp.json();
    const eph = data.client_secret.value;

    // 2) create OpenAI Realtime client using ws
    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime', `openai-insecure-api-key.${eph}`, 'openai-beta.realtime-v1']
    );

    openaiWs.on('open', () => {
      // configure session
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `You are Alex with Microsoft. Your goal is to book an appointment with ${firstName}. Keep turns short.`,
          voice: 'ash',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1000 },
          temperature: 0.8
        }
      }));

      // initial greeting
      setTimeout(() => {
        openaiWs?.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text', 'audio'],
            instructions: `Say ONLY: "Hi ${firstName}, this is Alex calling from Microsoft. How are you doing today?" then stop and wait.`
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
        }
        // you can also capture transcripts here if desired
      } catch (e) {
        console.error('OpenAI message error', e);
      }
    });

    openaiWs.on('close', (code, reason) => {
      console.log('OpenAI closed', code, reason?.toString());
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, 'openai-closed');
    });

    openaiWs.on('error', (e) => console.error('OpenAI WS error', e));
  };

  // --- Twilio socket events ---
  twilioWs.on('open', () => {
    startFlusher();
  });

  twilioWs.on('message', async (buf) => {
    const msg = JSON.parse(buf.toString());

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;

      // bookingId for context if needed
      const u = new URL(msg.start.streamUrl);
      const bookingId = msg.start?.customParameters?.bookingId || u.searchParams.get('bookingId') || '';
      const firstName = 'there'; // optionally look up in DB using bookingId

      // connect to OpenAI now
      await connectOpenAI(firstName);
      startFlusher();
    }

    if (msg.event === 'media') {
      // caller audio -> OpenAI
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        const pcm24 = convertMulawToPCM16(base64ToUint8Array(msg.media.payload));
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: uint8ArrayToBase64(pcm24) }));
      }
    }

    if (msg.event === 'stop') {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, 'twilio-stop');
      stopFlusher();
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio closed');
    stopFlusher();
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, 'twilio-closed');
  });

  twilioWs.on('error', (e) => console.error('Twilio WS error', e));
});

// ---- start server ----
server.listen(PORT, () => {
  console.log(`Media bridge running on ${PORT}`);
});

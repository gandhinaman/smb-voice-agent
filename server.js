// server.js (ESM) — Final consultative, timezone-friendly, UTC-saving version
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'node:url';

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- US timezone map for speech ----
const US_TZ = {
  PT: { code: 'PT', name: 'Pacific Time', offset: -480 },
  MT: { code: 'MT', name: 'Mountain Time', offset: -420 },
  CT: { code: 'CT', name: 'Central Time', offset: -360 },
  ET: { code: 'ET', name: 'Eastern Time', offset: -300 }
};
const DEFAULT_TZ = US_TZ[(process.env.TZ_REGION || 'CT').toUpperCase()] || US_TZ.CT;

// ---- time helpers ----
const addMin = (d, m) => new Date(d.getTime() + m * 60000);
const withOffset = (d, off) => addMin(d, off);
const spoken = (d, tz = DEFAULT_TZ) => {
  const local = withOffset(d, tz.offset);
  const day = local.toLocaleDateString('en-US', { weekday: 'long' });
  const month = local.toLocaleDateString('en-US', { month: 'long' });
  const date = local.getDate();
  const time = local.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${month} ${date} at ${time} ${tz.code}`;
};
const nextAt = (dow, h, m, tz = DEFAULT_TZ, now = new Date()) => {
  const local = withOffset(now, tz.offset);
  const diff = (dow - local.getDay() + 7) % 7;
  const target = new Date(local);
  target.setDate(local.getDate() + diff);
  target.setHours(h, m, 0, 0);
  if (target <= local) target.setDate(target.getDate() + 7);
  return addMin(target, -tz.offset);
};
const nextTwo = (tz = DEFAULT_TZ) => {
  const slots = [
    { d: 2, h: 14, m: 0 },
    { d: 3, h: 10, m: 0 },
    { d: 4, h: 14, m: 0 },
    { d: 5, h: 11, m: 0 }
  ].map(s => nextAt(s.d, s.h, s.m, tz))
   .sort((a, b) => a - b);
  return [slots[0], slots[1]];
};

// ---- Supabase ----
async function fetchBooking(id) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(id)}&select=*`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!res.ok) return null;
  const arr = await res.json();
  return arr?.[0] || null;
}
async function updateBooking(id, body) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/call_bookings?id=eq.${encodeURIComponent(id)}`, {
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

// ---- audio helpers ----
const b2u = (b) => Uint8Array.from(Buffer.from(b, 'base64'));
const u2b = (u) => Buffer.from(u).toString('base64');
const concatU8 = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; };
function mulawToPCM16(m) {
  const f = (x) => { x = ~x; const s = x & 0x80; const e = (x >> 4) & 7; const n = x & 0x0F; let y = (n << 3) + 0x84; y <<= e; y -= 0x84; return s ? -y : y; };
  const pcm8k = new Int16Array(m.length); for (let i=0;i<m.length;i++) pcm8k[i]=f(m[i]);
  const pcm24k = new Int16Array(pcm8k.length*3);
  for (let i=0;i<pcm8k.length;i++){const s=pcm8k[i];pcm24k[i*3]=s;pcm24k[i*3+1]=s;pcm24k[i*3+2]=s;}
  return new Uint8Array(pcm24k.buffer);
}
function pcm16ToMulaw(p) {
  const f = (pcm) => { const s=pcm<0?0x80:0x00; let x=Math.abs(pcm); x=Math.min(x,32635); x+=0x84; let e=7; for(let i=0;i<8;i++){if(x<=(0xFF<<i)){e=i;break;}} const n=(x>>(e+3))&0x0F; return ~(s|(e<<4)|n); };
  const pcm=new Int16Array(p.buffer); const pcm8k=new Int16Array(Math.floor(pcm.length/3)); for(let i=0;i<pcm8k.length;i++)pcm8k[i]=pcm[i*3];
  const mu=new Uint8Array(pcm8k.length); for(let i=0;i<pcm8k.length;i++)mu[i]=f(pcm8k[i]); return mu;
}

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({status:'ok',now:new Date().toISOString()}));
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = parseUrl(req.url);
  if (pathname === '/media') wss.handleUpgrade(req, socket, head, (ws)=>wss.emit('connection',ws,req));
  else socket.destroy();
});

wss.on('connection', async (twilioWs, req) => {
  let openaiWs=null, streamSid=null, bookingId=null, firstName='there', outMu=new Uint8Array(0);
  let conversation=[], start=Date.now(), lastAct=Date.now(), idleTimer=null, flusher=null;
  const CHUNK=160;

  const stopAll=()=>{if(flusher){clearInterval(flusher);}if(idleTimer){clearInterval(idleTimer);}try{if(openaiWs?.readyState===1)openaiWs.close();}catch{}try{if(twilioWs?.readyState===1)twilioWs.close();}catch{};}
  const startFlusher=()=>{if(flusher)return;flusher=setInterval(()=>{
    if(!streamSid||twilioWs.readyState!==1)return;
    if(outMu.length>=CHUNK){const slice=outMu.subarray(0,CHUNK);outMu=outMu.subarray(CHUNK);
      twilioWs.send(JSON.stringify({event:'media',streamSid,media:{payload:u2b(slice)}}));
    }else{twilioWs.send(JSON.stringify({event:'mark',streamSid,mark:{name:'tick'}}));}
  },20);};
  const startIdle=()=>{if(idleTimer)return;idleTimer=setInterval(()=>{
    if(Date.now()-lastAct>10000){console.log('⏱️ End idle');stopAll();}
  },5000);};

  async function connectOpenAI(){
    const tok=await fetch('https://api.openai.com/v1/realtime/sessions',{
      method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'gpt-4o-realtime-preview-2024-12-17',voice:'ash'})
    });
    if(!tok.ok){console.error('OpenAI token error',await tok.text());return;}
    const eph=(await tok.json()).client_secret.value;
    openaiWs=new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime',`openai-insecure-api-key.${eph}`,'openai-beta.realtime-v1']);
    openaiWs.on('open',()=>{
      const [o1,o2]=nextTwo(DEFAULT_TZ);const t1=spoken(o1,DEFAULT_TZ);const t2=spoken(o2,DEFAULT_TZ);
      const instructions=`
Role: You are Alex, a Microsoft Security advisor speaking with ${firstName}.
Tone: conversational, consultative, concise (1-2 sentences).

Goal: Explore ${firstName}'s business security posture, share short credible facts when relevant, and guide toward a follow-up specialist call.

Approach:
1. Start with an open question about their confidence in handling cyber threats.
2. Listen, then adapt:
   • If unaware → share one fact then ask a question.
   • If thinking about ROI → note that preventing one breach (~$200K loss) often pays for improvements.
   • If engaged → dig slightly deeper, then suggest a 15-min specialist call.
   • If busy → skip facts, propose quick follow-up times.
3. Use 1 fact at a time, from these examples:
   • 47% of small businesses have faced an attack.
   • Phishing and ransomware are top threats.
   • MFA and Zero Trust identity block most phishing.
   • 785,000+ businesses trust Microsoft Security.
4. When ready, offer times naturally:
   "Would ${t1} or ${t2} work for you?" then stop.

Rules:
- One fact per few turns max.
- Never stack or sound like a pitch.
- Confirm time with weekday, date, and timezone code.
- If they decline, thank and end politely.`;
      openaiWs.send(JSON.stringify({type:'session.update',session:{modalities:['text','audio'],instructions,voice:'ash',input_audio_format:'pcm16',output_audio_format:'pcm16',input_audio_transcription:{model:'whisper-1'},turn_detection:{type:'server_vad',threshold:0.5,prefix_padding_ms:300,silence_duration_ms:900},temperature:0.6}}));
      setTimeout(()=>{openaiWs.send(JSON.stringify({type:'response.create',response:{modalities:['text','audio'],instructions:`Hi ${firstName}, this is Alex with Microsoft Security. How are you feeling about your company's protection against threats lately?`}}));},200);
    });
    openaiWs.on('message',(b)=>{lastAct=Date.now();const d=JSON.parse(b);if(d.type==='response.audio.delta'&&d.delta){const mu=pcm16ToMulaw(b2u(d.delta));outMu=concatU8(outMu,mu);}if(d.type==='conversation.item.input_audio_transcription.completed')conversation.push({t:new Date().toISOString(),who:'Customer',msg:d.transcript});if(d.type==='response.audio_transcript.done')conversation.push({t:new Date().toISOString(),who:'AI',msg:d.transcript});});
    openaiWs.on('close',()=>{try{if(twilioWs.readyState===1)twilioWs.close(1000,'openai-closed');}catch{}stopAll();});
  }

  async function saveConv(source){
    if(!bookingId)return;const dur=Math.floor((Date.now()-start)/1000);
    const txt=conversation.map(x=>`${x.who}: ${x.msg}`).join('\n');
    await updateBooking(bookingId,{conversation_summary:txt,booking_status:'completed',call_duration:dur,call_answered:dur>10,customer_transcript:conversation.filter(x=>x.who==='Customer').map(x=>x.msg).join('\n')||'No customer speech',close_source:source});
  }

  startIdle();
  twilioWs.on('message',async(b)=>{
    const m=JSON.parse(b);lastAct=Date.now();
    if(m.event==='start'){streamSid=m.start.streamSid;bookingId=m.start.customParameters?.bookingId||null;
      const fn=m.start.customParameters?.firstName||m.start.customParameters?.name||null;if(fn)firstName=fn.split(' ')[0];
      else if(bookingId){const bk=await fetchBooking(bookingId);if(bk?.customer_name)firstName=bk.customer_name.split(' ')[0];}
      startFlusher();await connectOpenAI();}
    else if(m.event==='media'){if(openaiWs&&openaiWs.readyState===1){const pcm24=mulawToPCM16(b2u(m.media.payload));openaiWs.send(JSON.stringify({type:'input_audio_buffer.append',audio:u2b(pcm24)}));}}
    else if(m.event==='stop'){await saveConv('stop');stopAll();}
  });
  twilioWs.on('close',()=>{saveConv('close');stopAll();});
  twilioWs.on('error',(e)=>console.error('Twilio WS error',e));
});

server.listen(PORT,()=>console.log('Media bridge running on',PORT));

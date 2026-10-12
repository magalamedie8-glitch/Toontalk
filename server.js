// ToonTalk voice server
// Run:  npm start   then open http://localhost:3000
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* ---- tiny .env loader (works on any Node version, Windows included) ---- */
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env file, fine */ }

const PORT = +process.env.PORT || 3000;
const KEY = process.env.AZURE_SPEECH_KEY || '';
const REGION = process.env.AZURE_SPEECH_REGION || '';
const IS_PROD = process.env.NODE_ENV === 'production';

// Sunbird AI (Luganda and other Ugandan languages): https://docs.sunbird.ai
// AI script helper (Claude). The key stays on the server and is never sent to the browser.
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const AI_BASE = (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
const AI_LIMIT = +process.env.AI_LIMIT_PER_10_MIN || 20;
const SB_KEY = process.env.SUNBIRD_API_KEY || '';
const SB_BASE = (process.env.SUNBIRD_API_BASE || 'https://api.sunbird.ai').replace(/\/+$/, '');

// Providers: azure (official), sunbird (Luganda), edge (unofficial, local testing only), mock (test tones), none
// If Sunbird is set up alongside another provider, its Luganda voices are added to the voice list.
let PROVIDER = (process.env.TTS_PROVIDER || '').toLowerCase();
if (!PROVIDER) PROVIDER = KEY && REGION ? 'azure' : (SB_KEY ? 'sunbird' : (IS_PROD ? 'none' : 'edge'));

// Luganda speakers listed in the Sunbird docs. Add more with SUNBIRD_EXTRA_VOICES="id:lang:Label,id2:lang2:Label2"
const SB_VOICES = [['salt_lug_0001', 'Luganda voice 1'], ...[2, 3, 4, 5, 6, 7, 8].map(n => ['waxal_lug_000' + n, 'Luganda voice ' + n])]
  .map(([id, name]) => ({ id, lang: 'lug', gender: '', label: name, prov: 'sunbird', auto: PROVIDER === 'sunbird' }));
(process.env.SUNBIRD_EXTRA_VOICES || '').split(',').map(x => x.trim()).filter(Boolean).forEach(x => {
  const [id, lang, ...lab] = x.split(':');
  if (id) SB_VOICES.push({ id, lang: lang || 'lug', gender: '', label: lab.join(':') || id, prov: 'sunbird', auto: false });
});

const CACHE = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sgn = n => (n >= 0 ? '+' : '') + n + '%';
const esc = s => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/* ---- voice catalogue ---- */
// Best first. These are East African / African English voices that suit Ugandan audiences, alternating male/female.
const AUTO_ORDER = ['en-KE-ChilembaNeural', 'en-KE-AsiliaNeural', 'en-TZ-ElimuNeural', 'en-TZ-ImaniNeural', 'en-NG-AbeoNeural', 'en-NG-EzinneNeural', 'en-US-GuyNeural', 'en-US-JennyNeural'];
const KEEP = /^(en-(KE|TZ|NG|ZA|US|GB|AU|IN)|sw-)/;
const FALLBACK = [
  ['en-KE-ChilembaNeural', 'Male'], ['en-KE-AsiliaNeural', 'Female'], ['en-TZ-ElimuNeural', 'Male'], ['en-TZ-ImaniNeural', 'Female'],
  ['en-NG-AbeoNeural', 'Male'], ['en-NG-EzinneNeural', 'Female'], ['en-US-GuyNeural', 'Male'], ['en-US-JennyNeural', 'Female'],
  ['en-GB-RyanNeural', 'Male'], ['en-GB-SoniaNeural', 'Female'], ['sw-KE-RafikiNeural', 'Male'], ['sw-KE-ZuriNeural', 'Female'],
  ['sw-TZ-DaudiNeural', 'Male'], ['sw-TZ-RehemaNeural', 'Female']
].map(([ShortName, Gender]) => ({ ShortName, Gender, Locale: ShortName.split('-').slice(0, 2).join('-') }));

function normalize(list) {
  const out = list
    .filter(v => /Neural$/.test(v.ShortName) && KEEP.test(v.ShortName))
    .map(v => {
      const name = v.ShortName.split('-').slice(2).join('-').replace(/Neural$/, '');
      return { id: v.ShortName, lang: v.Locale, gender: v.Gender, label: `${name} (${v.Locale}, ${v.Gender})`, auto: AUTO_ORDER.includes(v.ShortName) };
    });
  const rank = v => { const i = AUTO_ORDER.indexOf(v.id); return i >= 0 ? i : 100; };
  return out.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

let voiceCache = null;
async function getVoices() {
  if (voiceCache) return voiceCache;
  const sb = SB_KEY ? SB_VOICES : [];
  if (PROVIDER === 'none' || PROVIDER === 'sunbird') return (voiceCache = sb);
  let raw = null;
  try {
    if (PROVIDER === 'azure') {
      const r = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': KEY } });
      if (r.ok) raw = await r.json();
    } else if (PROVIDER === 'edge') {
      const { MsEdgeTTS } = require('msedge-tts');
      raw = await new MsEdgeTTS().getVoices();
    }
  } catch (e) { /* use fallback list */ }
  voiceCache = normalize(raw && raw.length ? raw : FALLBACK).map(v => ({ ...v, prov: PROVIDER })).concat(sb);
  return voiceCache;
}

/* ---- providers ---- */
function ssml(locale, voice, text, r, p) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voice}"><prosody rate="${sgn(Math.round((r - 1) * 100))}" pitch="${sgn(Math.round((p - 1) * 50))}">${esc(text)}</prosody></voice></speak>`;
}
async function synthAzure(v, text, r, p) {
  const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'toontalk'
    },
    body: ssml(v.lang, v.id, text, r, p)
  });
  if (!res.ok) throw new Error('azure ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
async function synthEdge(v, text, r, p) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(v.id, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: sgn(Math.round((r - 1) * 100)), pitch: sgn(Math.round((p - 1) * 50)) });
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data', d => chunks.push(d));
      audioStream.on('close', resolve);
      audioStream.on('error', reject);
      setTimeout(() => reject(new Error('edge timeout')), 20000);
    });
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('edge returned no audio');
    return buf;
  } finally { try { tts.close(); } catch (e) {} }
}
function synthMock(v, text, r, p) { // test tones, no network
  const sr = 16000, dur = Math.max(0.6, text.length * 0.065 / r), n = Math.floor(sr * dur);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = 180 * p + 40 * Math.sin(t * 9), gate = Math.sin(t * 12) > -0.3 ? 1 : 0.1;
    b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * t) * 9000 * gate), 44 + i * 2);
  }
  return b;
}
async function synthSunbird(v, text) {
  if (!SB_KEY) throw new Error('SUNBIRD_API_KEY is not set');
  const call = async () => {
    const res = await fetch(SB_BASE + '/tasks/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: v.id, language: v.lang, response_mode: 'url' }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error('sunbird ' + res.status + ' ' + (await res.text()).slice(0, 160));
    const j = await res.json();
    if (!j.audio_url) throw new Error('sunbird returned no audio_url');
    const a = await fetch(j.audio_url, { signal: AbortSignal.timeout(60000) });
    if (!a.ok) throw new Error('sunbird audio download ' + a.status);
    const buf = Buffer.from(await a.arrayBuffer());
    if (buf.length < 100) throw new Error('sunbird audio was empty');
    return buf;
  };
  try { return await call(); } catch (e) { if (/ 4\d\d /.test(e.message) && !/ 429 /.test(e.message)) throw e; await new Promise(r => setTimeout(r, 1500)); return call(); }
}
const synth = { azure: synthAzure, edge: synthEdge, sunbird: synthSunbird, mock: async (...a) => synthMock(...a) };
const isWav = v => v.prov === 'sunbird' || v.prov === 'mock';

/* ---- app ---- */
const app = express();
app.use(express.json({ limit: '48kb' }));
app.use((req, res, next) => { // lets index.html work even when opened straight from disk
  res.set('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const hits = new Map(); // simple per-IP rate limit to protect your voice quota
setInterval(() => hits.clear(), 60000).unref();
const limited = (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1; hits.set(req.ip, n);
  if (n > 120) return res.status(429).json({ error: 'Too many voice requests, wait a minute.' });
  next();
};

app.get('/api/health', (req, res) => res.json({ ok: true, provider: PROVIDER, sunbird: !!SB_KEY, ai: !!AI_KEY }));

app.get('/api/voices', async (req, res) => {
  res.json({ provider: PROVIDER, voices: await getVoices() });
});


/* ---- AI script helper: turns an idea into a ToonTalk script ---- */
const SCRIPT_GUIDE = [
  'You write short scripts for ToonTalk Studio, an app that animates cartoon characters from a plain-text script. Reply with ONLY the script lines. No title, no explanations, no markdown, no code fences, no numbering.',
  '',
  'LINE FORMATS (one per line):',
  'Name: words they say',
  'Name (emotion): words        emotions: neutral, happy, angry, sad, shocked, scared, laugh, sleepy, love',
  'Name (angry, walk to Mama): words      movement while talking: walk/run to left|right|center|door|gate|tree|table|bench|<other character name>, or "run away from <name>"',
  'Name (interrupts): words     cuts off the previous speaker (use after someone else spoke)',
  'Kato & Nakato: Yes!   /   Everyone: Thank you!   several characters speak the same words together (answering a question as a group)',
  'Kato (sings): your own original lyrics   the character sings them on a made-up melody. Optional: [song: afrobeat 110] before it (styles: pop, afrobeat, gospel, lullaby, rock, opera) and Kato (rap): words for a rap with a beat. Always write ORIGINAL lyrics, never copy real songs.',
  'Name (beat): words           short comic pause first',
  '[scene: day]   places: day, sunset, night, home, classroom, market, village, street, compound, room, tree, hall',
  '[Name enters left]  [Name enters right]  [Name leaves left]  [Name leaves right]   (a character who enters first starts off stage)',
  '[Name walks to Mama]  [Name runs away from Mama]  [Name walks to the door]',
  '[Name waves] jumps dances points bows sits stands falls spins shrugs claps kicks cheers crouches nods salutes',
  '[Name gasps] [Name stares] [Name cries] [Name glares] [Name blushes] [Name smiles] [Name freezes] [Name yawns] [Name laughs]   silent reactions; "[also Name laughs]" reacts during the next line',
  '[pause 1s]  [beat]',
  '[sfx: pop]   sounds: pop, boing, slap, ding, whoosh, drum, fail, laugh, wow, crash',
  '[camera: zoom Name]  [camera: shake]  [camera: wide]  [camera: follow]',
  '[prop: table at center]  [prop: remove table]   props: ball, phone, book, bag, umbrella, rolex, cup, broom, mic, box, chair, table',
  '[Name holds ball]  [Name drops ball]  [Name throws ball to Mama] (caught)  [Name throws ball at Mama]  [Name gives phone to Mama]',
  '[title: Round 1]   a title card',
  '[Name is a cat]   gives a character a look, put it near the start. Looks: cat, dog, bunny, bear, panda, lion, monkey, elephant, frog, pig, owl, duck, fox, mouse, cow, robot, alien, ghost, monster, devil, angel, zombie, vampire, wizard, pirate, ninja, knight, astronaut, superhero, king, queen, clown, detective, chef, doctor, cowboy, caveman, mzee, granny, baby. Pick a look that fits each character (a goat story can use a cow or a pig); animals can talk.',
  'MODES (put the mode line first when used): [mode: classroom] with [teacher: Name]; [mode: story] with [storyteller: Name] and [picture: village] (or night, day, market, home, street, off) while the story is told; [mode: debate] with [moderator: Name], [proposition: A, B], [opposition: C, D]. In these modes the leader stands on one side and the others on the other side; pupils/children ask questions, the leader answers.',
  '',
  'RULES:',
  '- Character names are 1 to 15 characters, no colons or brackets. Spell each character name identically every time.',
  '- Start with one [scene: ...] line. Keep each spoken line under 150 characters, ideally one or two short sentences, so it is funny when read aloud.',
  '- Comedy needs timing: use reactions, [pause], [beat], interruptions, and one or two sound effects, but do not put a command between every line.',
  '- Every spoken line must have a character name and a colon. Never write stage directions in plain sentences; use the bracket commands only.',
  '- Use only the commands listed above. Do not invent commands.',
  '- End with a punchline or a gentle moral, not a cliffhanger, unless asked.'
].join('\n');

const aiHits = new Map();
setInterval(() => aiHits.clear(), 600000).unref();
const TASKS = {
  new: 'Write a brand new episode script for the idea below.',
  continue: 'Continue the existing script below with the next part of the story. Output ONLY the new lines that come after the existing script (do not repeat it). Keep the same characters and style.',
  funnier: 'Rewrite the existing script below to make it much funnier: sharper punchlines, better timing, more physical comedy and reactions. Keep the same characters and the same basic story. Output the full rewritten script.',
  polish: 'Fix and polish the existing script below: correct the command formats, remove anything the app cannot read, tighten the dialogue. Keep the story. Output the full script.',
  luganda: 'Translate the spoken dialogue of the existing script below into natural, everyday Luganda. Keep all bracket commands, character names and emotions exactly as they are in English. Output the full script.'
};
const MODES = { normal: 'a normal conversation between friends', classroom: 'classroom mode (a teacher on one side, pupils on the other asking questions)', story: 'storytelling mode (a storyteller on one side telling a story, children on the other side asking questions)', debate: 'debate mode (a moderator and two teams)' };
const LANGS = { en: 'English', lug: 'natural, everyday Luganda (Uganda). Write the spoken words in Luganda; keep every bracket command and the emotion words in English', mix: 'a natural Ugandan mix of English and Luganda, the way people really talk' };
const TONES = { funny: 'funny, with clear punchlines', silly: 'very silly and absurd', dramatic: 'dramatic with a funny twist', educational: 'educational for children, warm and clear, with a little humour', moral: 'a children\'s story with a clear moral at the end' };
const LENS = { short: 'about 8 to 10 lines', medium: 'about 14 to 18 lines', long: 'about 26 to 32 lines' };
const cleanTxt = (v, n) => String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, n);

app.post('/api/script', limited, async (req, res) => {
  if (!AI_KEY) return res.status(501).json({ error: 'The AI helper is not set up. Add ANTHROPIC_API_KEY to your .env file.' });
  const n = (aiHits.get(req.ip) || 0) + 1; aiHits.set(req.ip, n);
  if (n > AI_LIMIT) return res.status(429).json({ error: 'You have used the AI helper a lot in the last 10 minutes. Wait a little and try again.' });
  try {
    const b = req.body || {};
    const task = TASKS[b.task] ? b.task : 'new';
    const idea = cleanTxt(b.idea, 700).trim(), current = cleanTxt(b.current, 8000).trim();
    if (task === 'new' && !idea) return res.status(400).json({ error: 'Type your idea first.' });
    if (task !== 'new' && !current) return res.status(400).json({ error: 'Your script is empty, so there is nothing to work on.' });
    const names = (Array.isArray(b.names) ? b.names : []).map(x => cleanTxt(x, 20).replace(/[:\[\]()]/g, '').trim()).filter(Boolean).slice(0, 24);
    const count = clamp(Math.round(+b.count || 3), 2, 8);
    const mode = MODES[b.mode] ? b.mode : 'normal';
    const lang = LANGS[b.lang] ? b.lang : 'en', tone = TONES[b.tone] ? b.tone : 'funny', len = LENS[b.len] ? b.len : 'medium';
    const parts = [TASKS[task]];
    if (idea) parts.push('IDEA: ' + idea);
    parts.push('Style: ' + MODES[mode] + '. Tone: ' + TONES[tone] + '. Language of the spoken words: ' + LANGS[lang] + '.');
    if (task === 'new' || task === 'continue') parts.push('Length: ' + LENS[len] + '.');
    if (names.length) parts.push('Use exactly these characters (and no others): ' + names.join(', ') + '.');
    else if (task === 'new') parts.push('Use ' + count + ' characters with short, friendly Ugandan names (for example Kato, Nakato, Musa, Aisha, Mama, Jajja).');
    if (b.moves && Array.isArray(b.moves) && b.moves.length) parts.push('These custom moves also exist and may be used as [Name move] on their own line: ' + b.moves.slice(0, 20).map(x => cleanTxt(x, 20)).join(', ') + '.');
    if (current) parts.push('EXISTING SCRIPT:\n' + current);
    const r = await fetch(AI_BASE + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 2200, temperature: 1, system: SCRIPT_GUIDE, messages: [{ role: 'user', content: parts.join('\n\n') }] }),
      signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 200);
      console.error('AI helper failed:', r.status, txt);
      if (r.status === 401 || r.status === 403) return res.status(502).json({ error: 'The AI key was rejected. Check ANTHROPIC_API_KEY in your .env file.' });
      if (r.status === 429) return res.status(503).json({ error: 'The AI service is busy. Try again in a moment.' });
      return res.status(502).json({ error: 'The AI service returned an error (' + r.status + ').' });
    }
    const j = await r.json();
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (!text) return res.status(502).json({ error: 'The AI returned nothing. Try again.' });
    res.json({ script: text, model: AI_MODEL });
  } catch (e) {
    console.error('AI helper failed:', e.message);
    res.status(502).json({ error: 'Could not reach the AI service. Check your internet connection.' });
  }
});

const inflight = new Map();
app.post('/api/tts', limited, async (req, res) => {
  try {
    const { text, voice, rate = 1, pitch = 1 } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || text.length > 400) return res.status(400).json({ error: 'Text must be 1 to 400 characters.' });
    const v = (await getVoices()).find(x => x.id === voice);
    if (!v || !synth[v.prov]) return res.status(400).json({ error: 'Unknown voice or voice provider is off.' });
    const r = clamp(+rate || 1, 0.5, 2), p = clamp(+pitch || 1, 0.5, 2);
    const key = crypto.createHash('sha1').update([v.prov, v.id, text, v.prov === 'sunbird' ? '' : r.toFixed(2) + '|' + p.toFixed(2)].join('|')).digest('hex');
    const ext = isWav(v) ? 'wav' : 'mp3';
    const file = path.join(CACHE, key + '.' + ext);
    if (!fs.existsSync(file)) {
      if (!inflight.has(key)) {
        inflight.set(key, synth[v.prov](v, text, r, p).then(buf => { fs.writeFileSync(file, buf); }).finally(() => inflight.delete(key)));
      }
      await inflight.get(key);
    }
    res.type(ext === 'wav' ? 'audio/wav' : 'audio/mpeg').sendFile(file);
  } catch (e) {
    console.error('TTS failed:', e.message);
    res.status(502).json({ error: 'Voice generation failed.' });
  }
});

/* ---- MP4 export: turns the browser recording into a TikTok/WhatsApp-ready MP4 ---- */
let FFMPEG = process.env.FFMPEG_PATH || null;
try { FFMPEG = FFMPEG || require('ffmpeg-static'); } catch (e) { /* ffmpeg-static not installed */ }
const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
fs.readdirSync(TMP).forEach(f => { try { fs.unlinkSync(path.join(TMP, f)); } catch (e) {} }); // clear leftovers from earlier runs
let converting = 0;
function probeAudio(file) { // true if the recording contains an audio stream
  try {
    const r = require('child_process').spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 15000 });
    return /Stream #\S+.*Audio:/.test((r.stderr || '') + (r.stdout || ''));
  } catch (e) { return true; }
}

app.post('/api/export', limited, express.raw({ type: () => true, limit: '150mb' }), (req, res) => {
  if (!FFMPEG) return res.status(501).json({ error: 'ffmpeg is not installed on the server. Run: npm install' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No video received.' });
  if (converting >= 2) return res.status(503).json({ error: 'Server is busy, try again in a moment.' });
  converting++;
  const id = crypto.randomBytes(8).toString('hex');
  const inFile = path.join(TMP, id + '.in'), outFile = path.join(TMP, id + '.mp4');
  const cleanup = () => { [inFile, outFile].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} }); };
  fs.writeFileSync(inFile, req.body);
  const hasAudio = probeAudio(inFile);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inFile,
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest']), // recording had no audio track: keep a silent one so every app accepts the MP4
    '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', 'scale=1080:1920:flags=lanczos,fps=30,format=yuv420p',
    ...(hasAudio ? ['-af', 'aresample=async=1:first_pts=0'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', outFile];
  const ff = spawn(FFMPEG, args);
  let err = '', done = false;
  const finish = fn => { if (done) return; done = true; clearTimeout(timer); converting--; fn(); };
  const timer = setTimeout(() => { ff.kill('SIGKILL'); }, 180000);
  ff.stderr.on('data', d => { err += d; });
  ff.on('error', e => finish(() => { console.error('ffmpeg failed to start:', e.message); cleanup(); res.status(500).json({ error: 'Could not start ffmpeg.' }); }));
  ff.on('close', code => finish(() => {
    if (code !== 0 || !fs.existsSync(outFile)) {
      console.error('ffmpeg export failed:', err.slice(-400));
      cleanup();
      return res.status(500).json({ error: 'Video conversion failed.' });
    }
    res.type('video/mp4').sendFile(outFile, e => { if (e) console.error('send failed:', e.message); cleanup(); });
  }));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`ToonTalk running: http://localhost:${PORT}`);
  console.log(`Voice provider: ${PROVIDER}`);
  if (PROVIDER === 'edge') console.log('NOTE: "edge" is an unofficial service for local testing only. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION before you release the app.');
  if (PROVIDER === 'none') console.log('No voice provider set. Add SUNBIRD_API_KEY (Luganda) or AZURE_SPEECH_KEY and AZURE_SPEECH_REGION to .env');
  if (SB_KEY) console.log('Sunbird Luganda voices: on');
  console.log(AI_KEY ? 'AI script helper: on (' + AI_MODEL + ')' : 'AI script helper: basic offline mode (add ANTHROPIC_API_KEY for real writing)');
});
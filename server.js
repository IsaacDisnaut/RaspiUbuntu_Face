'use strict';
// Node.js 18+ required for native fetch

const express    = require('express');
const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { Server } = require('socket.io');
const selfsigned = require('selfsigned');
const Database   = require('better-sqlite3');

const IS_PROD = process.env.NODE_ENV === 'production';

// ── SQLite ──────────────────────────────────────────────────
// In production set DB_PATH env var to a persistent volume path, e.g. /data/videocall.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'videocall.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); // ensure /data (or any parent dir) exists
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER  PRIMARY KEY AUTOINCREMENT,
    name          TEXT     NOT NULL,
    login_time    DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
    usage_seconds INTEGER  NOT NULL DEFAULT 0,
    logout_time   DATETIME
  )
`);
const stmtStart  = db.prepare(`INSERT INTO sessions (name, login_time) VALUES (?, datetime('now','localtime'))`);
const stmtEnd    = db.prepare(`UPDATE sessions SET usage_seconds = ?, logout_time = datetime('now','localtime') WHERE id = ?`);
const stmtGetAll = db.prepare(`SELECT * FROM sessions ORDER BY login_time DESC LIMIT 200`);

// ── Express app ─────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);        // required behind Railway / Render / fly.io proxies
app.use(express.json({ limit: '10mb' }));
// ── /face route — serves main SPA; app.js detects pathname and auto-joins room FACE ──
app.get('/face', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use(express.static(path.join(__dirname, 'public')));

// ── API keys — supports "Provider: key" multi-line format ────
// Each line: "Groq: gsk_..." / "Openrouter: sk-or-..." / "Gemini: AIza..." / bare key also works.
// Production (Railway): set GROQ_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY env vars.
const KEYS = {};
const PROVIDER_MODEL_LISTS = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'apikey'), 'utf8');
  let currentProvider = null;
  let jsonBuf = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // Accumulate JSON model array
    if (jsonBuf !== null) {
      jsonBuf += '\n' + t;
      if (t.startsWith(']')) {
        try {
          const models = JSON.parse(jsonBuf);
          if (currentProvider && Array.isArray(models)) PROVIDER_MODEL_LISTS[currentProvider] = models;
        } catch {}
        jsonBuf = null;
      }
      continue;
    }
    if (t === '[') { jsonBuf = '['; continue; }
    // Parse "ProviderName: api-key" — provider name is the source of truth
    if (t.includes(':')) {
      const ci = t.indexOf(':');
      const providerRaw = t.slice(0, ci).trim();
      const key = t.slice(ci + 1).trim();
      if (providerRaw && !providerRaw.includes(' ') && key) {
        currentProvider = providerRaw.toLowerCase();
        KEYS[currentProvider] = key;
      }
    }
  }
} catch {}
// Env var fallbacks
if (!KEYS.groq       && process.env.GROQ_API_KEY)       KEYS.groq       = process.env.GROQ_API_KEY;
if (!KEYS.openrouter && process.env.OPENROUTER_API_KEY) KEYS.openrouter = process.env.OPENROUTER_API_KEY;
if (!KEYS.gemini     && process.env.GEMINI_API_KEY)     KEYS.gemini     = process.env.GEMINI_API_KEY;
if (!KEYS['9arm']    && (process.env['9ARM_KEY'] || process.env.NINEARM_KEY)) KEYS['9arm'] = process.env['9ARM_KEY'] || process.env.NINEARM_KEY;
// Legacy single API_KEY env var
const _leg = (process.env.API_KEY || '').trim();
if (_leg.startsWith('gsk_')   && !KEYS.groq)       KEYS.groq       = _leg;
if (_leg.startsWith('sk-or-') && !KEYS.openrouter) KEYS.openrouter = _leg;
if ((_leg.startsWith('AIza') || _leg.startsWith('AQ.')) && !KEYS.gemini) KEYS.gemini = _leg;

// Backward-compat aliases used by older code below
const API_KEY      = KEYS.groq || KEYS.openrouter || KEYS.gemini || KEYS['9arm'] || '';
const KEY_PROVIDER = KEYS.groq ? 'groq' : KEYS.openrouter ? 'openrouter' : KEYS.gemini ? 'gemini' : KEYS['9arm'] ? '9arm' : '';
const KEY_MODEL    = KEY_PROVIDER === 'groq'       ? 'llama-3.3-70b-versatile'
                   : KEY_PROVIDER === 'openrouter' ? 'qwen/qwen-2.5-72b-instruct'
                   : KEY_PROVIDER === '9arm'       ? 'qwen3.6-35b-a3b'
                   : 'gemini-2.0-flash';

if (Object.keys(KEYS).length) console.log(`API keys loaded: ${Object.keys(KEYS).join(', ')}`);
else console.warn('No API key — set env vars (Railway) or create ../apikey file (local).');

// ── Provider defaults (lets frontend know which provider/model is pre-configured) ──
app.get('/api/provider-defaults', (req, res) => {
  const baseUrls = {
    groq:       'https://api.groq.com/openai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    '9arm':     'https://gateway.9arm.co/v1',
  };
  res.json({
    provider:  KEY_PROVIDER || null,
    model:     KEY_MODEL,
    baseUrl:   baseUrls[KEY_PROVIDER] || null,
    modelLists: PROVIDER_MODEL_LISTS,
    keys:       Object.fromEntries(Object.entries(KEYS).map(([k]) => [k, true])),
  });
});

// ── Whisper STT ─────────────────────────────────────────────
app.post('/api/stt', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const key = KEYS.groq;
  if (!key) return res.status(503).json({ error: 'Groq API key not configured' });
  const mimeType = req.headers['x-mime-type'] || 'audio/webm';
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
  try {
    const formData = new FormData();
    formData.append('file', new File([req.body], `audio.${ext}`, { type: mimeType }));
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'th');
    formData.append('response_format', 'json');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: formData,
    });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json({ text: data.text || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI proxy ────────────────────────────────────────────────
app.post('/api/ai', async (req, res) => {
  const { provider, baseUrl, apiKey, model, messages, systemPrompt } = req.body;
  try {
    let text;
    if (provider === 'groq') {
      const key = KEYS.groq || apiKey;
      if (!key) return res.status(503).json({ error: 'Groq API key not configured — add apikey file or enter key in Settings' });
      const allMsgs = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ];
      const groqModel = (model && model.startsWith('llama')) ? model : 'llama-3.3-70b-versatile';
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: groqModel, messages: allMsgs }),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      text = (await r.json()).choices[0].message.content;
    } else if (provider === 'openrouter') {
      const key = KEYS.openrouter || apiKey;
      if (!key) return res.status(503).json({ error: 'OpenRouter API key not configured — add apikey file or enter key in Settings' });
      const allMsgs = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ];
      const orModel = model || 'qwen/qwen-2.5-72b-instruct';
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: orModel, messages: allMsgs }),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      text = (await r.json()).choices[0].message.content;
    } else if (provider === 'gemini') {
      const key = (API_KEY.startsWith('AIza') || API_KEY.startsWith('AQ.') ? API_KEY : null) || apiKey;
      if (!key) return res.status(503).json({ error: 'Gemini API key not configured — add apikey file or enter key in Settings' });
      const geminiModel = (model && model.startsWith('gemini-')) ? model : 'gemini-2.0-flash';
      // Convert OpenAI-style messages to Gemini format (role: 'user'|'model')
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const body = {
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      };
      if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      text = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt || 'You are a helpful assistant.',
          messages,
        }),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      text = (await r.json()).content[0].text;
    } else if (provider === '9arm') {
      const key = KEYS['9arm'] || apiKey;
      if (!key) return res.status(503).json({ error: '9Arm API key not configured — add apikey file or set 9ARM_KEY env var' });
      const allMsgs = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ];
      const r = await fetch('https://gateway.9arm.co/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: model || 'qwen3.6-35b-a3b', messages: allMsgs }),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      text = (await r.json()).choices[0].message.content;
    } else {
      const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
      const allMsgs = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ];
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: allMsgs }),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      text = (await r.json()).choices[0].message.content;
    }
    res.json({ content: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TURN / ICE config ───────────────────────────────────────
app.get('/api/ice-config', (req, res) => {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80',               username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  res.json({ iceServers: servers });
});

// ── Session API ─────────────────────────────────────────────
app.post('/api/session/start', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const r = stmtStart.run(name);
    res.json({ sessionId: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/session/end', (req, res) => {
  const { sessionId, usageSeconds } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    stmtEnd.run(Math.max(0, Math.round(usageSeconds || 0)), sessionId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// sendBeacon: body already parsed by global express.json()
app.post('/api/session/end-beacon', (req, res) => {
  try {
    const { sessionId, usageSeconds } = req.body || {};
    if (sessionId) stmtEnd.run(Math.max(0, Math.round(usageSeconds || 0)), sessionId);
  } catch {}
  res.sendStatus(204);
});

app.get('/api/sessions', (req, res) => {
  res.json(stmtGetAll.all());
});

// ── YOLO detection proxy (forwards JPEG frame to yolo_server.py on :5001) ──
app.post('/api/detect', express.raw({ type: 'image/jpeg', limit: '5mb' }), async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:5001/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': req.body.length },
      body: req.body,
    });
    res.json(await r.json());
  } catch {
    res.json([]);  // yolo_server.py not running — return empty detections
  }
});

// ── Socket.io signaling ─────────────────────────────────────
function attachSocketIO(server) {
  const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],   // polling fallback for restrictive proxies
  });

  io.on('connection', (socket) => {
    console.log('[+]', socket.id);

    socket.on('join-room', (roomId) => {
      socket.rooms.forEach((room) => {
        if (room !== socket.id) { socket.leave(room); socket.to(room).emit('peer-left', socket.id); }
      });
      socket.join(roomId);
      const members = io.sockets.adapter.rooms.get(roomId) || new Set();
      const others  = [...members].filter(id => id !== socket.id);
      socket.emit('room-joined', { roomId, peers: others });
      socket.to(roomId).emit('peer-joined', socket.id);
      console.log(`  room "${roomId}" (${members.size} peers)`);
    });

    socket.on('signal',       ({ to, signal }) => io.to(to).emit('signal', { from: socket.id, signal }));
    socket.on('chat-message', ({ roomId, message }) => socket.to(roomId).emit('chat-message', { from: socket.id, message }));
    // Relay peer-TTS state so both sides can sync auto-read
    socket.on('peer-tts',    ({ roomId, enabled }) => socket.to(roomId).emit('peer-tts', { enabled }));

    socket.on('disconnect', () => {
      socket.rooms.forEach((room) => {
        if (room !== socket.id) socket.to(room).emit('peer-left', socket.id);
      });
      console.log('[-]', socket.id);
    });
  });

  return io;
}

// ── Start ────────────────────────────────────────────────────
(async () => {
  if (IS_PROD) {
    // ── Production: plain HTTP, cloud platform provides HTTPS ─
    const PORT   = parseInt(process.env.PORT || '3000');
    const server = http.createServer(app);
    attachSocketIO(server);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`VideoCall running on port ${PORT}  (production)`);
    });

  } else {
    // ── Development: self-signed HTTPS ────────────────────────
    const PORT_HTTP  = parseInt(process.env.PORT_HTTP  || '3000');
    const PORT_HTTPS = parseInt(process.env.PORT_HTTPS || '3443');

    // HTTP → HTTPS redirect
    http.createServer((req, res) => {
      const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
      res.writeHead(301, { Location: `https://${host}:${PORT_HTTPS}${req.url}` });
      res.end();
    }).listen(PORT_HTTP, () => console.log(`HTTP  :${PORT_HTTP} → HTTPS :${PORT_HTTPS}`));

    // Generate / reuse self-signed cert
    const SSL_DIR   = path.join(__dirname, '.ssl');
    const CERT_FILE = path.join(SSL_DIR, 'cert.pem');
    const KEY_FILE  = path.join(SSL_DIR, 'key.pem');

    let creds;
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
      creds = { cert: fs.readFileSync(CERT_FILE, 'utf8'), key: fs.readFileSync(KEY_FILE, 'utf8') };
    } else {
      console.log('Generating self-signed SSL cert (one-time)…');
      fs.mkdirSync(SSL_DIR, { recursive: true });
      const pems = await selfsigned.generate(
        [{ name: 'commonName', value: 'localhost' }],
        { days: 730, keySize: 2048 }
      );
      fs.writeFileSync(CERT_FILE, pems.cert);
      fs.writeFileSync(KEY_FILE,  pems.private);
      creds = { cert: pems.cert, key: pems.private };
    }

    const httpsServer = https.createServer({ key: creds.key, cert: creds.cert }, app);
    attachSocketIO(httpsServer);

    httpsServer.listen(PORT_HTTPS, '0.0.0.0', () => {
      const ips = Object.values(os.networkInterfaces())
        .flat()
        .filter(i => i.family === 'IPv4' && !i.internal)
        .map(i => i.address);

      console.log('\n  VideoCall is ready!\n');
      console.log(`  Local   → https://localhost:${PORT_HTTPS}`);
      ips.forEach(ip => console.log(`  Network → https://${ip}:${PORT_HTTPS}`));
      console.log('\n  First visit: click "Advanced" → "Proceed" to accept the self-signed cert.\n');
    });
  }
})();

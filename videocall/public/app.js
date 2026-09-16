'use strict';

// ── Mobile / platform detection ──────────────────
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS 13+
const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent);

// iOS blocks speechSynthesis.speak() unless it was triggered inside a user-gesture handler.
// We unlock it on the first meaningful button tap by speaking a silent utterance.
let ttsUnlocked = false;
function unlockTTS() {
  if (ttsUnlocked || !window.speechSynthesis) return;
  ttsUnlocked = true;
  const u = new SpeechSynthesisUtterance('');
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

// ════════════════════════════════════════════════
//  SESSION (login + usage tracking)
// ════════════════════════════════════════════════
let sessionId        = null;
let sessionStartTime = null;
let sessionTimerTick = null;
let currentUserName  = 'You';

function usageSeconds() {
  return sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0;
}

async function doLogin(name) {
  const res  = await fetch('/api/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Server error');
  sessionId        = data.sessionId;
  sessionStartTime = Date.now();
  currentUserName  = name;
  startSessionTimer();
}

async function endSession() {
  if (!sessionId) return;
  clearInterval(sessionTimerTick);
  try {
    await fetch('/api/session/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, usageSeconds: usageSeconds() }),
    });
  } catch {}
}

function startSessionTimer() {
  const chip      = $('session-chip');
  const timerEl   = $('session-timer');
  const nameEl    = $('session-name');
  nameEl.textContent = currentUserName;
  chip.style.display = 'flex';

  function tick() {
    const s = usageSeconds();
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${sec}`;
  }
  tick();
  sessionTimerTick = setInterval(tick, 1000);
}

// Flush session to DB — idempotent UPDATE so firing multiple times is safe
function flushSession() {
  if (!sessionId) return;
  const payload = JSON.stringify({ sessionId, usageSeconds: usageSeconds() });
  navigator.sendBeacon('/api/session/end-beacon', new Blob([payload], { type: 'application/json' }));
}

// Three events cover all major tab-close paths:
// beforeunload — desktop close/refresh
// pagehide     — more reliable on mobile and Chrome bfcache
// visibilitychange → hidden — catches backgrounding before a kill
window.addEventListener('beforeunload', flushSession);
window.addEventListener('pagehide', flushSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSession();
});

// ════════════════════════════════════════════════
//  LOGIN SCREEN
// ════════════════════════════════════════════════
function initLoginScreen() {
  const screen  = $('login-screen');

  // /face skips the login form and auto-joins as "FACE"
  if (IS_FACE) {
    screen.style.display = 'none';
    doLogin('FACE').then(initApp).catch(() => initApp());
    return;
  }

  const form    = $('login-form');
  const input   = $('name-input');
  const errorEl = $('login-error');
  const btnText = $('login-btn-text');
  const btn     = $('login-btn');

  input.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();

    // Validate
    errorEl.textContent = '';
    input.classList.remove('error');
    if (!name) {
      // #login-error is role="alert" — the screen reader announces it itself.
      errorEl.textContent = 'กรุณากรอกชื่อของคุณ';
      input.classList.add('error');
      input.focus();
      return;
    }

    // Show loading state
    btn.disabled = true;
    btnText.textContent = 'กำลังเริ่ม…';

    try {
      await doLogin(name);
      announceAccessibility('ล็อกอินแล้ว');
      // Animate out login screen
      screen.classList.add('exit');
      screen.addEventListener('transitionend', () => {
        screen.style.display = 'none';
        // Boot the main app now that we have a session
        initApp();
      }, { once: true });
    } catch (err) {
      // role="alert" on the error span — announced by the screen reader.
      errorEl.textContent = err.message || 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่';
      btn.disabled = false;
      btnText.textContent = 'เริ่มใช้งาน';
    }
  });
}

// ════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════
const IS_FACE = window.location.pathname === '/face';
if (IS_FACE) document.body.classList.add('face-mode');

const state = {
  mode: 'ai',
  micOn: true,
  camOn: true,
  speakerOn: true,   // master audio-out switch: remote call audio + all TTS
  speechOn: false,
  localStream: null,
  aiTyping: false,
};

const aiHistory = [];
const peers = {};        // peerId → { pc, dc }
let socket = null;
let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // fallback
let recognition = null;
let interimMsgEl = null;
let currentRoomId = null;

// ════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════
const DEFAULT_SETTINGS = {
  theme: 'light',          // 'light' (default) | 'dark' — applied via data-theme on <html>
  showAiMode: false,      // "Talk with AI" nav tab is hidden by default; enable from Settings
  showDetectButton: false, // YOLO "ตรวจจับ" toggle is a debug feature, hidden by default; enable from Settings
  showTimingLog: false,    // per-message STT/AI timing breakdown is a debug feature, hidden by default
  dpadSpeed: '1',          // D-pad head/mouth step multiplier: '0.5' slow, '1' normal, '1.5' fast
  remoteRotation: '0',     // rotate incoming remote video display: '0' | '90' | '180' | '270'
  provider: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  model: 'llama-3.3-70b-versatile',
  systemPrompt: 'You are a male Thai robot. You mainly speak Thai as your native language. You can move your face left-right, move both eyes, and open/close your mouth. In EVERY response include emotion JSON blocks to animate your face, placed anywhere in your message, using EXACTLY this format: {"Head":45,"Mouth":30,"Analog":{"x":0,"y":0}}\nRanges: Head 0-90 (0=look left, 45=center, 90=look right), Mouth 30-100 (30=closed, 100=open/smile), Analog x -1 to 1 (eye pan), y -1 to 1 (eye tilt). Include as many frames as needed to make the animation feel natural (e.g. approach → peak → settle).',
  sttMode: 'browser',
  ttsEnabled: true,
  ttsRate: 1.0,
  turnUrl: '',
  turnUser: '',
  turnPass: '',
  // Local Mosquitto through the server's /ws/mqtt proxy (server.js → 127.0.0.1:9001).
  // Same origin as the page, so it works on http://localhost AND behind the
  // Cloudflare tunnel without a second hostname — and ws/wss follows the page
  // protocol, since an https page cannot open a plain ws:// socket.
  // A public broker (test.mosquitto.org) added 100-500 ms of jitter that made
  // motion stutter; local TCP is near-zero latency.
  mqttUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/mqtt`,
  mqttTopic: 'robot/control',
};

function loadSettings() {
  try {
    const s = localStorage.getItem('vc_settings');
    const saved = s ? JSON.parse(s) : {};
    // Migrate: prompts saved before the wire-format canonicalization still
    // instruct old Head ranges (20-100, 0-80, 0-180) — swap in the new
    // 0-90/center-45 default. Matched on the range text, not "Head":<n>,
    // because "Head":45 is also the NEW default's example frame.
    if (saved.systemPrompt && /Head 20-100|Head 0-80|Head 0-180/.test(saved.systemPrompt)) delete saved.systemPrompt;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,   // systemPrompt persists — the Settings form lets the user edit it
      mqttUrl: DEFAULT_SETTINGS.mqttUrl,   // never persist: always derive from the current origin (the Cloudflare URL changes every run)
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function persistSettings(s) { localStorage.setItem('vc_settings', JSON.stringify(s)); }
let settings = loadSettings();

// The inline <head> script already set data-theme before first paint;
// this keeps it in sync whenever settings are loaded or saved.
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
}
applyTheme();

// API keys from server's apikey file (groq/openrouter) — used to auto-fill Settings key field
let SERVER_KEYS = {};

// Fallback model lists — overwritten by server response if apikey file has arrays
let PROVIDER_MODELS = {
  groq:       ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768'],
  openrouter: ['qwen/qwen-2.5-72b-instruct', 'meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat', 'deepseek/deepseek-r1'],
  '9arm':     ['qwen3.6-35b-a3b'],
};

// ════════════════════════════════════════════════
//  DOM
// ════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);
const localVideo       = $('local-video');
const remoteVideo      = $('remote-video');
const aiAvatar         = $('ai-avatar');
const aiSpeaking       = $('ai-speaking');
const remoteName       = $('remote-name');
const camPlaceholder   = $('cam-placeholder');
const chatMessages     = $('chat-messages');
const chatInput        = $('chat-input');
const sendBtn          = $('send-btn');
const micBtn           = $('mic-btn');
const speakerBtn       = $('speaker-btn');
const videoBtn         = $('video-btn');
const speechBtn        = $('speech-btn');
const endBtn           = $('end-btn');
const roomBar          = $('room-bar');
const roomCodeDisplay  = $('room-code-display');
const roomStatus       = $('room-status');
const joinInput        = $('join-input');
const joinBtn          = $('join-btn');
const copyCodeBtn      = $('copy-code-btn');
const speechIndicator  = $('speech-indicator');
const settingsOverlay  = $('settings-overlay');
const detectBtn        = $('detect-btn');
const faceWaitingStatus = $('face-waiting-status');

// Only meaningful on the /face kiosk screen — lets the customer know whether
// an operator is connected yet, instead of a silently idle robot head.
function setFaceWaitingVisible(show) {
  if (!IS_FACE || !faceWaitingStatus) return;
  faceWaitingStatus.classList.toggle('visible', show);
}
const detectCanvas     = $('detect-canvas');

let detectOn      = false;
let detectLoopId  = null;  // setTimeout handle

// ────────────────────────────────────────────────
//  YOLO OBJECT DETECTION (via yolo_server.py)
// ────────────────────────────────────────────────
function startDetect() {
  if (detectOn) return;
  detectOn = true;
  detectBtn.classList.remove('off');
  detectBtn.setAttribute('aria-pressed', 'true');
  detectCanvas.style.display = '';
  runDetectionLoop();
}

function stopDetect() {
  detectOn = false;
  detectBtn.classList.add('off');
  detectBtn.setAttribute('aria-pressed', 'false');
  clearTimeout(detectLoopId);
  detectCanvas.style.display = 'none';
  if (detectCanvas.width) {
    detectCanvas.getContext('2d').clearRect(0, 0, detectCanvas.width, detectCanvas.height);
  }
}

function toggleDetect() {
  if (detectOn) {
    stopDetect();
  } else {
    startDetect();
  }
}

async function runDetectionLoop() {
  if (!detectOn) return;

  const vw = localVideo.videoWidth  || localVideo.clientWidth;
  const vh = localVideo.videoHeight || localVideo.clientHeight;
  if (vw > 0 && vh > 0) {
    detectCanvas.width  = vw;
    detectCanvas.height = vh;

    const tmp = document.createElement('canvas');
    tmp.width = vw; tmp.height = vh;
    tmp.getContext('2d').drawImage(localVideo, 0, 0, vw, vh);

    try {
      const blob = await new Promise(r => tmp.toBlob(r, 'image/jpeg', 0.7));
      const res  = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
      const boxes = await res.json();

      const ctx = detectCanvas.getContext('2d');
      ctx.clearRect(0, 0, vw, vh);
      ctx.font      = 'bold 13px sans-serif';
      ctx.lineWidth = 2;

      for (const { x1, y1, x2, y2, label, conf } of boxes) {
        // confidence filtering happens server-side (yolo_server.py CONF_THRESHOLD)
        const hue = Math.abs(label.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;
        const color = `hsl(${hue},90%,55%)`;
        ctx.strokeStyle = color;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

        const tag = `${label} ${(conf * 100).toFixed(0)}%`;
        const tw  = ctx.measureText(tag).width;
        ctx.fillStyle = color;
        ctx.fillRect(x1, y1 - 18, tw + 8, 18);
        ctx.fillStyle = '#000';
        ctx.fillText(tag, x1 + 4, y1 - 4);
      }
    } catch {}
  }

  detectLoopId = setTimeout(runDetectionLoop, 400);
}

// ════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════
// Load provider/model defaults from server (uses apikey file) only on first visit (no saved settings)
async function fetchProviderDefaults() {
  try {
    const res = await fetch('/api/provider-defaults');
    const d = await res.json();
    if (d.modelLists) Object.assign(PROVIDER_MODELS, d.modelLists);
    if (d.keys)       Object.assign(SERVER_KEYS, d.keys);
    const hasSaved = !!localStorage.getItem('vc_settings');
    if (hasSaved) return;
    if (!d.provider) return;
    settings.provider = d.provider;
    settings.model    = d.model    || settings.model;
    settings.baseUrl  = d.baseUrl  || settings.baseUrl;
    persistSettings(settings);
  } catch {}
}

// Called after successful login
async function initApp() {
  await fetchProviderDefaults();
  populateSettingsForm();
  bindEventListeners();
  initSocket();
  initSpeechRecognition();
  await Promise.all([fetchIceConfig(), startLocalMedia()]);

  if (IS_FACE) {
    document.body.classList.add('face-mode');
    setFaceWaitingVisible(true); // shown until an operator's media actually connects
    joinRoom('FACE');    // must be before applyMode so currentRoomId is set
    applyMode('robot');
    // The kiosk must BOTH stream mic audio to the operator AND transcribe.
    // On Android, Web Speech API can't share the mic with WebRTC — Whisper
    // records via its own second getUserMedia stream, which can. Runtime
    // override only (not persisted): desktop keeps the configured mode since
    // Web Speech coexists with the open mic there.
    if (IS_MOBILE) settings.sttMode = 'whisper';
    toggleSpeech();      // kiosk display has no one to click the Speech button
  } else {
    applyAiModeVisibility();
    applyMode(settings.showAiMode ? 'ai' : 'person');
    showSystemMsg(`ยินดีต้อนรับ, ${currentUserName}!`);
    if (settings.mqttUrl) connectMQTT(); // connect early so emotion publishes work in AI mode
    initKeyboardControls();
  }
}

// ════════════════════════════════════════════════
//  ICE / TURN CONFIG
// ════════════════════════════════════════════════
async function fetchIceConfig() {
  try {
    const res = await fetch('/api/ice-config');
    const data = await res.json();
    iceConfig = buildIceConfig(data.iceServers);
    console.log('ICE config loaded:', iceConfig.iceServers.length, 'servers');
  } catch (e) {
    console.warn('Could not fetch ICE config, using fallback STUN only.');
  }
}

function buildIceConfig(baseServers = []) {
  const servers = [...baseServers];
  // Append user's custom TURN server if set
  if (settings.turnUrl) {
    servers.push({
      urls: settings.turnUrl,
      username: settings.turnUser || '',
      credential: settings.turnPass || '',
    });
  }
  return { iceServers: servers };
}

// ════════════════════════════════════════════════
//  LOCAL MEDIA
// ════════════════════════════════════════════════
async function startLocalMedia() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = state.localStream;
  } catch (e) {
    console.warn('Media error:', e);
    camPlaceholder.classList.add('visible');
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      showSystemMsg('ไม่ได้รับอนุญาตให้ใช้กล้อง/ไมค์ — แตะไอคอนรูปแม่กุญแจในแถบที่อยู่เบราว์เซอร์เพื่ออนุญาต แล้วโหลดหน้าใหม่');
    } else if (e.name === 'NotFoundError') {
      showSystemMsg('ไม่พบกล้อง/ไมค์ — ยังใช้แชทได้ตามปกติ');
    } else {
      showSystemMsg('ใช้กล้อง/ไมค์ไม่ได้ — ยังใช้แชทได้ตามปกติ');
    }
  }
}

function toggleMic() {
  if (!state.localStream) return;
  state.micOn = !state.micOn;
  state.localStream.getAudioTracks().forEach(t => (t.enabled = state.micOn));
  micBtn.classList.toggle('off', !state.micOn);
  micBtn.title = state.micOn ? 'ปิดไมค์' : 'เปิดไมค์';
  // aria-pressed convention (all toggle buttons): pressed=true = feature ON.
  // No announcement needed — the screen reader speaks the state change itself.
  micBtn.setAttribute('aria-pressed', String(state.micOn));
}

// Speaker mute — separate from the mic: silences everything the page plays
// (remote call audio + every TTS path). Screen-reader speech is unaffected,
// so the aria-pressed change is always audible to a blind user.
function toggleSpeaker() {
  state.speakerOn = !state.speakerOn;
  remoteVideo.muted = !state.speakerOn;
  if (!state.speakerOn) stopSpeaking();
  speakerBtn.classList.toggle('off', !state.speakerOn);
  speakerBtn.title = state.speakerOn ? 'ปิดลำโพง' : 'เปิดลำโพง';
  speakerBtn.setAttribute('aria-pressed', String(state.speakerOn));
}

function toggleCam() {
  if (!state.localStream) return;
  state.camOn = !state.camOn;
  state.localStream.getVideoTracks().forEach(t => (t.enabled = state.camOn));
  localVideo.classList.toggle('hidden', !state.camOn);
  camPlaceholder.classList.toggle('visible', !state.camOn);
  videoBtn.classList.toggle('off', !state.camOn);
  videoBtn.title = state.camOn ? 'ปิดกล้อง' : 'เปิดกล้อง';
  videoBtn.setAttribute('aria-pressed', String(state.camOn));
}

// ════════════════════════════════════════════════
//  MODE
// ════════════════════════════════════════════════
// "Talk with AI" tab stays in the DOM (not deleted) but is hidden from the
// nav unless re-enabled via Settings, so the operator UI defaults to the
// robot/customer workflow this project is actually for.
function applyAiModeVisibility() {
  const aiBtn = document.querySelector('.mode-btn[data-mode="ai"]');
  if (aiBtn) aiBtn.style.display = settings.showAiMode ? '' : 'none';
}

// ── Remote video rotation ────────────────────────
// Rotates the incoming remote video display (Settings → หมุนภาพวิดีโอที่ได้รับ),
// for when the camera on the other side is mounted sideways or upside down.
// 90/270: the element's box is swapped (width ↔ container height) so the
// rotated video still fills the wrap; re-applied on resize and mode change.
function applyRemoteRotation() {
  const deg = parseInt(settings.remoteRotation, 10) || 0;
  const sideways = deg === 90 || deg === 270;
  // Rotated video must never be cropped (cover would cut the edges that end up
  // at the top/bottom of the screen) — letterbox with contain instead.
  remoteVideo.style.objectFit = deg ? 'contain' : '';
  if (!sideways) {
    remoteVideo.style.width  = '';
    remoteVideo.style.height = '';
    remoteVideo.style.transform = deg ? `rotate(${deg}deg)` : '';
    return;
  }
  const wrap = $('remote-wrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return; // wrap hidden (not in person mode) — applyMode re-applies later
  remoteVideo.style.width  = h + 'px';
  remoteVideo.style.height = w + 'px';
  remoteVideo.style.transform = `rotate(${deg}deg)`;
}

// YOLO "ตรวจจับ" is a debug/demo feature, not part of the customer-service
// workflow — hidden from the main controls bar by default (re-enable in Settings).
function applyDetectButtonVisibility() {
  if (!detectBtn) return;
  const show = !!settings.showDetectButton;
  if (state.mode !== 'ai') detectBtn.style.display = show ? '' : 'none';
  if (!show && detectOn) stopDetect();
}

function applyMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
    // Screen readers can't see the .active highlight — mirror it (same
    // pressed=ON convention as the control-bar toggles).
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });

  const robotPanel = $('robot-panel');
  const remoteWrap = $('remote-wrap');
  const localWrap  = $('local-wrap');

  const controlsRow = document.querySelector('.robot-controls-row');

  if (mode === 'robot') {
    // Internal-only mode used by the /face kiosk display (no nav button).
    // body.face-mode CSS forces this panel full-screen and hides everything else.
    robotPanel.style.display = 'flex';
    if (controlsRow) controlsRow.style.display = 'none';
    remoteWrap.style.display = 'none';
    localWrap.style.display  = 'none';
    roomBar.style.display    = currentRoomId ? 'block' : 'none';
    applyDetectButtonVisibility();
    stopDetect();
    if (recognition) recognition.lang = 'th-TH';
    initRobotPanel();
  } else if (mode === 'ai') {
    robotPanel.style.display   = 'flex';
    if (controlsRow) controlsRow.style.display = 'none';
    remoteWrap.style.display   = 'none';
    localWrap.style.cssText    = '';   // reset any detect-mode overrides
    localWrap.style.display    = '';   // show camera PiP
    detectCanvas.style.display = '';   // show detection overlay
    detectBtn.style.display    = 'none';
    initRobotPanel();
    startDetect();
  } else {
    // Person mode: video call + manual robot controls (joystick/D-pad) in one tab
    robotPanel.style.display = 'none';
    if (controlsRow) controlsRow.style.display = '';
    remoteWrap.style.display = '';
    localWrap.style.display  = '';
    applyDetectButtonVisibility();
    stopDetect();
    initRobotPanel();
  }

  if (mode === 'ai') {
    roomBar.style.display = 'none';
    aiAvatar.style.display = 'none';
    remoteVideo.classList.remove('active');
    remoteName.textContent = 'ผู้ช่วย AI';
    if (recognition) recognition.lang = 'th-TH';
  } else if (mode === 'person') {
    roomBar.style.display = 'block';
    if (!currentRoomId) joinRoom('FACE');
    else aiAvatar.style.display = 'none';
    if (recognition) recognition.lang = 'th-TH';

    // Auto-enable peer TTS so the other side hears our typed messages by default
    if (!myTTSEnabled) {
      myTTSEnabled = true;
      updatePeerTTSStatus();
      if (currentRoomId && socket) socket.emit('peer-tts', { roomId: currentRoomId, enabled: true });
      // announce:false — the mode announcement below covers this moment; the
      // 🔊-button detail is visual guidance, not something to read aloud.
      showSystemMsg('เปิดเสียงข้อความให้คู่สนทนาอัตโนมัติแล้ว — กดปุ่ม 🔊 ในหัวแชทเพื่อปิด', { announce: false });
    }
    announceAccessibility('โหมดคุยกับคน พร้อมแล้ว');
  }

  applyRemoteRotation(); // wrap size depends on which panels are visible

  if (state.speechOn && recognition) {
    try { recognition.stop(); } catch {}
  }
}

// ════════════════════════════════════════════════
//  ROBOT CONTROL PANEL
// ════════════════════════════════════════════════
const robotState = {
  analogX:   0,   // -1..1  eye left/right
  analogY:   0,   // -1..1  eye up/down
  headAngle: 0,   // degrees, -35..35
  mouthOpen: 0,   // 0..1
  padDir:    null,
};

let mqttClient          = null;
let robotPanelReady     = false;
let dpadInterval        = null;
const dpadKeyHandlers   = {}; // dir -> { press, release } — shared by buttons and Arrow-key handler

// ── Three.js joint driver ────────────────────────
function updateRobotModel() {
  const rv = window.robotViewer;
  if (!rv) return;
  // D-pad left/right → head rotation (degrees → radians, URDF limits to ±0.785)
  rv.setJoint('i01.head.rothead_link_joint', robotState.headAngle * Math.PI / 180);
  // D-pad up/down → jaw open (0..1 → 0..0.175 rad ≈ 10°)
  rv.setJoint('i01.head.jaw_link_joint', robotState.mouthOpen * 0.17453);
  // Analog X → eye pan (both eyes, limit ±0.349 rad)
  rv.setJoint('i01.head.eyeLeft.001_link_joint',  robotState.analogX * 0.349);
  rv.setJoint('i01.head.eyeRight.001_link_joint', robotState.analogX * 0.349);
  rv.setJoint('i01.head.eyeLeft_link_joint',  -robotState.analogY * 0.349);
  rv.setJoint('i01.head.eyeRight_link_joint', -robotState.analogY * 0.349);
}

// Keep old name as alias so any remaining callers don't break
var updateFaceAnimation = updateRobotModel;

// ── Canonical robot wire format ──────────────────
// One encoding shared by every path (live control, AI emotions, MQTT, data
// channel) and BOTH sides of the call — decode must never depend on the
// receiver's UI mode, because the sender may be in a different mode (operator
// in Person mode → /face kiosk in robot mode). Matches the physical servos:
// head 0-90 (center 45), jaw 30-100 (30 = closed).
const WIRE_HEAD_BASE = 45, WIRE_HEAD_MIN = 0,  WIRE_HEAD_MAX = 90;
const WIRE_MOUTH_MIN = 30, WIRE_MOUTH_MAX = 100;
const clampNum = (v, min, max) => Math.min(max, Math.max(min, v));

// Shared parser used by both MQTT and WebRTC data channel
function applyRobotPayload(str) {
  try {
    const data = JSON.parse(str);
    if (data.Head === undefined && data.Mouth === undefined && data.Analog === undefined) return false;
    if (data.Head  !== undefined) robotState.headAngle = clampNum(data.Head, WIRE_HEAD_MIN, WIRE_HEAD_MAX) - WIRE_HEAD_BASE;
    if (data.Mouth !== undefined) robotState.mouthOpen = clampNum((data.Mouth - WIRE_MOUTH_MIN) / (WIRE_MOUTH_MAX - WIRE_MOUTH_MIN), 0, 1);
    if (data.Analog !== undefined) {
      robotState.analogX = clampNum(data.Analog.x ?? robotState.analogX, -1, 1);
      robotState.analogY = clampNum(data.Analog.y ?? robotState.analogY, -1, 1);
    }
    updateRobotModel();
    return true;
  } catch { return false; }
}

// Play an array of emotion frames sequentially on the robot face.
// Accepts a JSON string that is either an array [...] or a single object {...}.
let emotionSeqTimer = null;
function playEmotionSequence(str) {
  try {
    const parsed = JSON.parse(str);
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    if (emotionSeqTimer) { clearTimeout(emotionSeqTimer); emotionSeqTimer = null; }
    let i = 0;
    function step() {
      if (i >= frames.length) return;
      applyRobotPayload(JSON.stringify(frames[i++]));
      emotionSeqTimer = setTimeout(step, 800);
    }
    step();
  } catch {}
}

// ── MQTT ─────────────────────────────────────────
// A blind operator can't see the status dot — without a voice cue the D-pad
// keeps announcing head positions with false confidence while the broker is
// down. Announce transitions only (never each 5 s reconnect retry): connected,
// lost-after-connected, and the very first failure.
let mqttSpokenState = null; // null = never connected yet, then 'on' | 'off'
function announceMqttChange(connected) {
  if (connected) {
    if (mqttSpokenState !== 'on') announceAccessibility('ต่อหุ่นแล้ว');
    mqttSpokenState = 'on';
  } else {
    if (mqttSpokenState === 'on') announceAccessibility('หุ่นหลุด');
    else if (mqttSpokenState === null) announceAccessibility('ต่อหุ่นไม่ได้');
    mqttSpokenState = 'off';
  }
}

function connectMQTT() {
  const url   = settings.mqttUrl || '';
  const topic = settings.mqttTopic || 'robot/control';
  const dot   = $('mqtt-dot');
  const txt   = $('mqtt-status-text');

  if (!url) { txt.textContent = 'ยังไม่ได้ตั้งค่า Broker URL ในการตั้งค่า'; dot.className = 'mqtt-dot'; return; }
  if (!window.mqtt) { txt.textContent = 'mqtt.js ยังไม่ถูกโหลด'; return; }

  if (mqttClient) {
    try { mqttClient.end(true); } catch {}
    mqttClient = null;
  }

  txt.textContent = 'กำลังเชื่อมต่อ…';
  dot.className = 'mqtt-dot';

  try {
    mqttClient = window.mqtt.connect(url, {
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 8000,
      clean: true,
    });
    mqttClient.on('connect', () => {
      // Generic label only — never show the broker host/URL on the operator UI
      txt.textContent = 'เชื่อมต่อแล้ว';
      dot.className = 'mqtt-dot connected';
      announceMqttChange(true);
      mqttClient.subscribe(topic);          // robot/control — joystick / d-pad
      mqttClient.subscribe('robot/emotion'); // AI emotion sequences
    });
    mqttClient.on('message', (t, payload) => {
      const str = payload.toString();
      // Live single frames also arrive via the data channel (fresher, full
      // rate). When a DC is open, skip the throttled/stale MQTT copy so the
      // 3D face doesn't jitter between old and new positions — and the
      // operator side ignores its own broker loopback. AI emotion
      // sequences (JSON arrays) still play from MQTT as before.
      const isSequence = str.trim().startsWith('[');
      if (!isSequence && isRecentSelfPub(str)) return; // our own broker loopback
      const hasOpenDC = Object.values(peers).some(p => p.dc && p.dc.readyState === 'open');
      if (!isSequence && hasOpenDC) return;
      if (isSequence) playEmotionSequence(str);
      else applyRobotPayload(str);
    });
    mqttClient.on('error', (e) => {
      console.warn('MQTT error:', e.message); // details in console only — no host/URL on screen
      txt.textContent = 'เชื่อมต่อไม่สำเร็จ';
      dot.className = 'mqtt-dot error';
      announceMqttChange(false);
    });
    mqttClient.on('close', () => {
      if (txt.textContent !== 'กำลังเชื่อมต่อ…') {
        txt.textContent = 'ตัดการเชื่อมต่อแล้ว';
        dot.className = 'mqtt-dot';
      }
      announceMqttChange(false);
    });
  } catch (e) {
    txt.textContent = 'Failed: ' + e.message;
    dot.className = 'mqtt-dot error';
  }
}

// Live control fires at pointer-move rate (60+ Hz on drag). The data channel
// and local 3D preview handle that fine, but the MQTT → deep.py → Arduino
// path cannot: flooding the broker builds a backlog of stale frames and the
// physical robot lags behind, replaying old positions (= jerky motion).
// Throttle MQTT publishes to ~15 Hz with a trailing edge so the newest state
// (including the final release/reset frame) always gets through.
const MQTT_PUBLISH_GAP_MS = 66;
let mqttLastPubAt  = 0;
let mqttPubTimer   = null;
let mqttPendingMsg = null;

// Live control frames go to the topic configured in Settings (default
// robot/control); AI emotion sequences keep the fixed robot/emotion topic.
// deep.py subscribes to both.
function liveControlTopic() { return settings.mqttTopic || 'robot/control'; }

// We subscribe to the same topic we publish live control on, so the broker
// echoes our own frames back ~66-1000 ms stale. When no data channel is open
// (the DC check in the message handler doesn't apply) that echo used to fight
// the fresh local state mid-drag — remember what we sent recently and drop
// byte-identical loopbacks. Only this client publishes single control frames,
// so an exact match within the window is always our own echo.
const SELF_ECHO_WINDOW_MS = 1000;
let recentSelfPubs = [];
function rememberSelfPub(msg) {
  const now = Date.now();
  recentSelfPubs = recentSelfPubs.filter(p => now - p.at < SELF_ECHO_WINDOW_MS);
  recentSelfPubs.push({ msg, at: now });
}
function isRecentSelfPub(str) {
  const now = Date.now();
  return recentSelfPubs.some(p => p.msg === str && now - p.at < SELF_ECHO_WINDOW_MS);
}

function publishRobotStateMQTT(msg) {
  if (!mqttClient || !mqttClient.connected) return;
  const now = Date.now();
  if (!mqttPubTimer && now - mqttLastPubAt >= MQTT_PUBLISH_GAP_MS) {
    mqttLastPubAt = now;
    rememberSelfPub(msg);
    mqttClient.publish(liveControlTopic(), msg);
    return;
  }
  mqttPendingMsg = msg;
  if (!mqttPubTimer) {
    mqttPubTimer = setTimeout(() => {
      mqttPubTimer = null;
      if (mqttClient && mqttClient.connected && mqttPendingMsg) {
        mqttLastPubAt = Date.now();
        rememberSelfPub(mqttPendingMsg);
        mqttClient.publish(liveControlTopic(), mqttPendingMsg);
        mqttPendingMsg = null;
      }
    }, Math.max(0, MQTT_PUBLISH_GAP_MS - (now - mqttLastPubAt)));
  }
}

function publishRobotState() {
  // Canonical wire encoding (head 0-90 center 45, mouth 30-100) — same base
  // in every mode so the receiving side can always decode with WIRE_* consts.
  const headDeg  = clampNum(Math.round(WIRE_HEAD_BASE + robotState.headAngle), WIRE_HEAD_MIN, WIRE_HEAD_MAX);
  const mouthDeg = clampNum(Math.round(WIRE_MOUTH_MIN + robotState.mouthOpen * (WIRE_MOUTH_MAX - WIRE_MOUTH_MIN)), WIRE_MOUTH_MIN, WIRE_MOUTH_MAX);
  const msg = JSON.stringify({
    Head:   headDeg,
    Mouth:  mouthDeg,
    Analog: {
      x: +robotState.analogX.toFixed(3),
      y: +robotState.analogY.toFixed(3),
    },
  });
  // Primary: WebRTC data channel (direct peer-to-peer, no broker latency)
  sendToPeer(msg);
  // Publish to the live-control topic so deep.py and /face both receive it (throttled)
  publishRobotStateMQTT(msg);
}

// ── Joystick ─────────────────────────────────────
// Shared by pointer drag and keyboard (WASD) — x/y each in -1..1
// ── Analog haptics ────────────────────────────────
// A blind operator can't see the thumb follow their finger, and eye-position
// speech is deliberately off. Vibration fills that gap without a single
// spoken word (Android only; silently no-ops elsewhere):
//   · short tick  — the value crossed a 25% step (finger IS being tracked)
//   · long buzz   — clamped at the rim (can't go further this way)
//   · double tick — back at dead centre (released / reset)
const HAPTIC_STEP = 0.25;
let hapticStepX = 0, hapticStepY = 0, hapticAtEdge = false, hapticAtCenter = true;
function joystickHaptics(x, y) {
  if (!navigator.vibrate) return;
  const atCenter = x === 0 && y === 0;
  const atEdge   = Math.hypot(x, y) >= 0.999;
  const sx = Math.round(x / HAPTIC_STEP);
  const sy = Math.round(y / HAPTIC_STEP);
  if (atCenter && !hapticAtCenter)                 navigator.vibrate([15, 60, 15]);
  else if (atEdge && !hapticAtEdge)                navigator.vibrate(40);
  else if (sx !== hapticStepX || sy !== hapticStepY) navigator.vibrate(10);
  hapticStepX = sx; hapticStepY = sy;
  hapticAtEdge = atEdge; hapticAtCenter = atCenter;
}

function setJoystick(x, y) {
  joystickHaptics(x, y);
  robotState.analogX = x;
  robotState.analogY = y;
  const base  = $('joystick-base');
  const thumb = $('joystick-thumb');
  if (base && thumb) {
    const maxR = base.getBoundingClientRect().width * 0.35;
    thumb.style.transform = `translate(${x * maxR}px,${-y * maxR}px)`;
    thumb.classList.toggle('active', x !== 0 || y !== 0);
  }
  // Drive the local 3D preview directly at input rate — same as the D-pad
  // path. Never rely on the broker echoing our own frame back: that echo is
  // throttled/stale (= stutter) and is now dropped as self-loopback anyway.
  updateRobotModel();
  publishRobotState();
}

function resetJoystick() {
  setJoystick(0, 0);
}

function initJoystick() {
  const base = $('joystick-base');
  let active = false;
  let moved  = false;          // gesture crossed the drag threshold at least once
  let startX = 0, startY = 0;

  // TalkBack's double-tap activation replays a synthetic press/release at the
  // CENTRE of the focused slider half — far from the base centre. Treating
  // that as a drag yanked the eyes sideways and snapped them back (a visible
  // twitch, published to the robot). So a press only becomes a drag after
  // real finger/mouse movement, and a no-move tap neither moves nor resets.
  const DRAG_START_PX = 8;

  function getCenter() {
    const r = base.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, maxR: r.width * 0.35 };
  }

  function start(clientX, clientY) {
    active = true;
    moved  = false;
    startX = clientX;
    startY = clientY;
  }

  function move(clientX, clientY) {
    if (!moved) {
      if (Math.hypot(clientX - startX, clientY - startY) < DRAG_START_PX) return;
      moved = true;
      announceAnalogEngaged(); // first analog change of this gesture
    }
    const c  = getCenter();
    let dx   = clientX - c.x;
    let dy   = clientY - c.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d > c.maxR) { dx = dx / d * c.maxR; dy = dy / d * c.maxR; }
    setJoystick(+(dx / c.maxR).toFixed(3), +(-dy / c.maxR).toFixed(3));
  }

  function release() {
    if (!active) return;
    active = false;
    if (moved) resetJoystick(); // a tap that never dragged must not twitch the eyes
  }

  base.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep mouse clicks from focusing the eye stick
    armAnalogAnnouncement();
    start(e.clientX, e.clientY);
  });
  base.addEventListener('touchstart', (e) => {
    e.preventDefault();
    armAnalogAnnouncement();
    start(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  document.addEventListener('mousemove',  (e) => { if (active) move(e.clientX, e.clientY); });
  document.addEventListener('touchmove',  (e) => { if (active) { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); } }, { passive: false });
  document.addEventListener('mouseup',   release);
  document.addEventListener('touchend',  release);
  // Android fires touchcancel (not touchend) when the system/TalkBack takes
  // the gesture back mid-drag. Without this the joystick stayed "active" with
  // the eyes frozen at the last position until the next gesture.
  document.addEventListener('touchcancel', release);
}

// ── Screen-reader eye controls ───────────────────
// Primary TalkBack path: single tap focuses the joystick overlay, then
// double-tap-AND-HOLD passes the real drag through. These sr-only buttons are
// the no-drag fallback — each steps the eyes EYE_TAP_STEP per activation,
// silently (the user asked for no eye-position speech). Unlike a drag
// release, a stepped position persists until reset (⦿ / eye-center / Space).
const EYE_TAP_STEP = 0.25;

// "ควบคุมได้แล้ว" — announced once per drag gesture, at the moment the analog
// first moves. Not repeated while the finger stays down; a new gesture arms it
// again. No focus checks: TalkBack's double-tap-and-hold drags whatever is
// under the FINGER regardless of where focus sits, so gating on the eye stick
// holding screen-reader focus made the announcement fire only sometimes (the
// reported bug). Those checks existed to stop the app's own speechSynthesis
// from talking to sighted users — obsolete now that announcements are
// aria-live writes, which are silent unless a screen reader is running.
// Assertive because it lands mid-gesture, when a polite message may be
// delayed past the region's auto-clear and dropped.
let analogGestureAnnounced = true; // armed by each gesture start
function armAnalogAnnouncement() {
  analogGestureAnnounced = false;
}
function announceAnalogEngaged() {
  if (analogGestureAnnounced) return;
  analogGestureAnnounced = true;
  announceAccessibility('ควบคุมได้แล้ว', true);
}

// ONE slider covers the whole circle (the old left/right halves forced a
// blind user to aim at an invisible half — merged 2026-07-14). TalkBack's
// swipe-up/down (or volume keys) arrives as ArrowUp/ArrowDown keydown →
// eyes up/down one step. ArrowLeft/Right step the X axis (desktop keyboard
// while focused; TalkBack left/right stepping uses the sr-only ตาซ้าย/ตาขวา
// buttons instead). Home recentres both axes. Handled and stopped here so
// the global Arrow-key → D-pad and WASD handlers never see these events.
// The aria values stay static on purpose — the adjustments are silent,
// haptics signal movement instead.
function initEyeStick() {
  const el = $('eye-stick');
  if (!el) return;
  el.addEventListener('keydown', (e) => {
    let x = robotState.analogX;
    let y = robotState.analogY;
    if      (e.key === 'ArrowUp')    y = clampNum(+(y + EYE_TAP_STEP).toFixed(2), -1, 1);
    else if (e.key === 'ArrowDown')  y = clampNum(+(y - EYE_TAP_STEP).toFixed(2), -1, 1);
    else if (e.key === 'ArrowRight') x = clampNum(+(x + EYE_TAP_STEP).toFixed(2), -1, 1);
    else if (e.key === 'ArrowLeft')  x = clampNum(+(x - EYE_TAP_STEP).toFixed(2), -1, 1);
    else if (e.key === 'Home') { x = 0; y = 0; }
    else return;
    e.preventDefault();
    e.stopPropagation();
    setJoystick(x, y);
  });
}

function initEyeA11yButtons() {
  const steps = {
    'eye-left':  [-EYE_TAP_STEP, 0],
    'eye-right': [ EYE_TAP_STEP, 0],
    'eye-up':    [0,  EYE_TAP_STEP],
    'eye-down':  [0, -EYE_TAP_STEP],
  };
  Object.entries(steps).forEach(([id, [dx, dy]]) => {
    const btn = $(id);
    if (!btn) return;
    // Silent by design — TalkBack already reads the button label; the user
    // asked for no spoken eye-position feedback.
    btn.addEventListener('click', () => {
      const x = clampNum(+(robotState.analogX + dx).toFixed(2), -1, 1);
      const y = clampNum(+(robotState.analogY + dy).toFixed(2), -1, 1);
      setJoystick(x, y);
    });
  });
  const center = $('eye-center');
  if (center) center.addEventListener('click', resetJoystick);
  initEyeStick();
}

// ── D-pad ─────────────────────────────────────────
// Directions currently held (button and/or Arrow key) — supports several at once,
// e.g. Left+Up held together turns the head and opens the mouth in the same tick.
const activeDpadDirs = new Set();

function applyDPad() {
  const speed = parseFloat(settings.dpadSpeed) || 1;
  // Person mode drives the real robot: head servo range 0-90 (center 45) →
  // headAngle ±45. Other modes keep the original ±35 cap.
  const headLimit = state.mode === 'person' ? 45 : 35;
  if (activeDpadDirs.has('left'))  robotState.headAngle += 3 * speed;
  if (activeDpadDirs.has('right')) robotState.headAngle -= 3 * speed;
  robotState.headAngle = Math.max(-headLimit, Math.min(headLimit, robotState.headAngle));
  if (activeDpadDirs.has('up'))    robotState.mouthOpen = Math.max(robotState.mouthOpen - 0.10 * speed,  0);
  if (activeDpadDirs.has('down'))  robotState.mouthOpen = Math.min(robotState.mouthOpen + 0.10 * speed,  1);
}

// A screen-reader "double-tap" arrives as an instant press+release — with the
// hold-to-repeat design that moved only one 3°/0.10 tick per activation. Short
// taps are boosted to DPAD_TAP_TICKS ticks so each tap is one useful step, and
// the new position is spoken for blind users.
const DPAD_TAP_TICKS = 4;    // 12° head / 0.40 mouth per tap at normal speed
const DPAD_TAP_MS    = 300;  // press shorter than this counts as a tap

function applyDPadTap(dir, ticks) {
  const speed = parseFloat(settings.dpadSpeed) || 1;
  const headLimit = state.mode === 'person' ? 45 : 35;
  if (dir === 'left')  robotState.headAngle += 3 * speed * ticks;
  if (dir === 'right') robotState.headAngle -= 3 * speed * ticks;
  robotState.headAngle = Math.max(-headLimit, Math.min(headLimit, robotState.headAngle));
  if (dir === 'up')    robotState.mouthOpen = Math.max(robotState.mouthOpen - 0.10 * speed * ticks, 0);
  if (dir === 'down')  robotState.mouthOpen = Math.min(robotState.mouthOpen + 0.10 * speed * ticks, 1);
  updateRobotModel();
}

function announceDPadState(dir) {
  if (dir === 'left' || dir === 'right') {
    const a = Math.round(robotState.headAngle);
    announceAccessibility(a === 0 ? 'หัวตรง' : `หัว${a > 0 ? 'ซ้าย' : 'ขวา'} ${Math.abs(a)}`);
  } else {
    const m = Math.round(robotState.mouthOpen * 100);
    announceAccessibility(m === 0 ? 'ปากปิด' : `ปาก ${m}`);
  }
}

// Center button / Space key — reset head, mouth and eyes to neutral
function resetDPad() {
  activeDpadDirs.clear();
  if (dpadInterval) { clearInterval(dpadInterval); dpadInterval = null; }
  document.querySelectorAll('.dpad-btn.pressed').forEach((b) => b.classList.remove('pressed'));
  robotState.headAngle = 0;
  robotState.mouthOpen = 0;
  // Route the analog reset through setJoystick so the thumb visual and the
  // a11y sliders reset too; it also publishes the fully-zeroed state.
  setJoystick(0, 0);
}

function initDPad() {
  const centerBtn = $('dpad-center');
  if (centerBtn) {
    centerBtn.addEventListener('mousedown',  resetDPad);
    centerBtn.addEventListener('touchstart', (e) => { e.preventDefault(); resetDPad(); }, { passive: false });
    // Screen readers activate via click (touchstart may never fire) — resetDPad
    // is idempotent, so a duplicate call after mousedown is harmless.
    centerBtn.addEventListener('click', () => {
      resetDPad();
      announceAccessibility('รีเซ็ตแล้ว');
    });
  }

  ['up', 'down', 'left', 'right'].forEach((dir) => {
    const btn = $(`dpad-${dir}`);
    let pressAt = 0;       // when the current hold started
    let lastHandledAt = 0; // guards the click fallback against double-firing

    function press() {
      if (activeDpadDirs.has(dir)) return; // already held — ignore repeat presses
      activeDpadDirs.add(dir);
      pressAt = Date.now();
      btn.classList.add('pressed');
      applyDPad();
      publishRobotState();
      if (!dpadInterval) {
        dpadInterval = setInterval(() => { applyDPad(); publishRobotState(); }, 50);
      }
    }

    function release(skipTapBoost) {
      if (!activeDpadDirs.has(dir)) return;
      activeDpadDirs.delete(dir);
      btn.classList.remove('pressed');
      if (activeDpadDirs.size === 0 && dpadInterval) {
        clearInterval(dpadInterval);
        dpadInterval = null;
      }
      // Short tap (incl. TalkBack double-tap = instant press+release): the hold
      // loop only ran once, so top it up to a full step and speak the result.
      // Keyboard passes skipTapBoost — arrow-key taps keep the original 1-tick
      // feel and stay silent so speech feedback never interrupts ongoing TTS.
      lastHandledAt = Date.now();
      if (!skipTapBoost && lastHandledAt - pressAt < DPAD_TAP_MS) {
        applyDPadTap(dir, DPAD_TAP_TICKS - 1); // press already applied 1 tick
        announceDPadState(dir);
      }
      publishRobotState();
    }

    dpadKeyHandlers[dir] = { press, release }; // reused by Arrow-key keyboard handler

    btn.addEventListener('mousedown',   press);
    btn.addEventListener('touchstart',  (e) => { e.preventDefault(); press(); }, { passive: false });
    // Wrapped so the event object is never mistaken for the skipTapBoost flag
    btn.addEventListener('mouseup',     () => release());
    btn.addEventListener('touchend',    () => release());
    btn.addEventListener('mouseleave',  () => release());
    // Some assistive tech sends only a click with no touch/mouse events at all.
    // Skip it when press/release just handled this activation.
    btn.addEventListener('click', () => {
      if (Date.now() - lastHandledAt < 500) return;
      lastHandledAt = Date.now();
      applyDPadTap(dir, DPAD_TAP_TICKS);
      announceDPadState(dir);
      publishRobotState();
    });
  });
}

// ── Panel init (called once on first robot-mode entry) ──
function initRobotPanel() {
  if (!robotPanelReady) {
    robotPanelReady = true;
    initJoystick();
    initEyeA11yButtons();
    initDPad();

    const canvas  = document.getElementById('robot-canvas');
    const loading = document.getElementById('robot-loading');
    if (canvas && window.RobotViewer) {
      new window.RobotViewer(canvas).init().then(function (rv) {
        window.robotViewer = rv;
        if (loading) loading.style.display = 'none';
        updateRobotModel();
      }).catch(function (e) {
        console.error('RobotViewer init failed:', e);
        if (loading) loading.textContent = '3D model failed to load';
      });
    }
  }
  connectMQTT();
}

// ════════════════════════════════════════════════
//  KEYBOARD CONTROLS
//  Arrow keys → D-pad (head/mouth), WASD → joystick (eyes) — Person mode only.
//  Left Alt → toggle Speech (STT). Right Alt → toggle TTS output
//  (AI voice in AI mode, voicing-my-messages-to-peer in Person mode).
//  All shortcuts are disabled while typing in a text field or with a modal open.
// ════════════════════════════════════════════════
const ARROW_DIR    = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const EYE_KEY_DIR  = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
const pressedEyeKeys = new Set();

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function isModalOpen() {
  return !!(settingsOverlay?.classList.contains('open') || $('help-overlay')?.classList.contains('open'));
}

function updateEyesFromKeys() {
  const x = (pressedEyeKeys.has('right') ? 1 : 0) - (pressedEyeKeys.has('left') ? 1 : 0);
  const y = (pressedEyeKeys.has('up')    ? 1 : 0) - (pressedEyeKeys.has('down') ? 1 : 0);
  setJoystick(x, y);
}

// Quick AI-voice-response toggle (mirrors the Settings → "AI Voice Response" checkbox)
function toggleAITTS() {
  settings.ttsEnabled = !settings.ttsEnabled;
  persistSettings(settings);
  const cb = $('s-tts');
  if (cb) cb.checked = settings.ttsEnabled;
  if (!settings.ttsEnabled) stopSpeaking();
  showSystemMsg(settings.ttsEnabled ? 'เปิดเสียงตอบกลับ AI แล้ว' : 'ปิดเสียงตอบกลับ AI แล้ว');
}

function initKeyboardControls() {
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(document.activeElement) || isModalOpen()) return;

    if (e.code === 'AltLeft' || e.code === 'AltRight') {
      e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'AltLeft') toggleSpeech();
      else if (state.mode === 'person') togglePeerTTS();
      else toggleAITTS();
      return;
    }

    if (state.mode !== 'person') return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) resetDPad();
      return;
    }

    const dir = ARROW_DIR[e.key];
    if (dir) {
      e.preventDefault();
      if (!e.repeat) dpadKeyHandlers[dir]?.press();
      return;
    }

    const eyeDir = EYE_KEY_DIR[e.code];
    if (eyeDir && !pressedEyeKeys.has(eyeDir)) {
      e.preventDefault();
      pressedEyeKeys.add(eyeDir);
      updateEyesFromKeys();
    }
  });

  window.addEventListener('keyup', (e) => {
    const dir = ARROW_DIR[e.key];
    if (dir) { dpadKeyHandlers[dir]?.release(true); return; }

    const eyeDir = EYE_KEY_DIR[e.code];
    if (eyeDir && pressedEyeKeys.has(eyeDir)) {
      pressedEyeKeys.delete(eyeDir);
      updateEyesFromKeys();
    }
  });

  // Release any keyboard-held controls if the window loses focus mid-press
  window.addEventListener('blur', () => {
    Object.keys(dpadKeyHandlers).forEach(dir => dpadKeyHandlers[dir]?.release(true));
    if (pressedEyeKeys.size) { pressedEyeKeys.clear(); updateEyesFromKeys(); }
  });
}

// ════════════════════════════════════════════════
//  SPEECH RECOGNITION
// ════════════════════════════════════════════════
// Whisper STT is browser-independent: MediaRecorder + a server round-trip to
// Groq. It covers every browser the Web Speech API does not — Firefox on any
// OS, iOS Safari, and the Chromium build Ubuntu ships — provided the server
// has a Groq key, which /api/provider-defaults reports in SERVER_KEYS.
function whisperAvailable() {
  return typeof MediaRecorder !== 'undefined' && !!SERVER_KEYS.groq;
}

// Runtime-only switch to Whisper — never persisted, so the user's configured
// mode stays intact on browsers where Web Speech does work. Keeps STT running
// if it was already on, so a mid-session failure is recovered from rather than
// merely reported. Returns false when Whisper cannot cover for it either.
function fallbackToWhisper(reason, msgDelay = 0) {
  if (!whisperAvailable()) return false;   // checked first: "already whisper"
  if (settings.sttMode === 'whisper') return true;  // is no use if it can't run
  const wasOn = state.speechOn;
  if (wasOn) disableSpeech();
  settings.sttMode = 'whisper';
  // msgDelay lets the boot-time call land after the welcome message
  if (msgDelay) setTimeout(() => showSystemMsg(reason), msgDelay);
  else showSystemMsg(reason);
  if (wasOn) toggleSpeech();               // re-arm in Whisper mode
  return true;
}

function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    // No Web Speech API at all (Firefox on any OS, iOS Safari). Whisper takes
    // over silently — critically, this runs BEFORE initApp's /face autostart,
    // so the kiosk's toggleSpeech() lands in Whisper mode instead of hitting
    // enableSpeech()'s `if (!recognition) return` and transcribing nothing.
    if (fallbackToWhisper('เบราว์เซอร์นี้ไม่รองรับการรู้จำเสียงในตัว — สลับไปใช้ Whisper ให้อัตโนมัติแล้ว', 1200)) return;
    speechBtn.style.display = 'none';
    // Delay so it appears after the welcome message
    setTimeout(() => showSystemMsg(
      'เบราว์เซอร์นี้ไม่รองรับการรู้จำเสียงพูด และ Whisper ก็ใช้ไม่ได้ (ไม่ได้ตั้งค่า Groq key) กรุณาพิมพ์ข้อความแทน'
    ), 1200);
    return;
  }

  recognition = new SR();
  recognition.continuous      = true;
  recognition.interimResults  = true;
  recognition.maxAlternatives = 1;
  recognition.lang = 'th-TH';

  // Exponential backoff for restarts: backs off after each session-end with no
  // result, resets to base on success. Prevents rapid-loop on persistent errors.
  let restartDelay = IS_MOBILE ? 600 : 0;
  // Consecutive 'network' errors — a run of them means the browser's speech
  // backend is unusable, not that the link hiccuped (see onerror).
  let networkErrors = 0;

  recognition.onresult = async (e) => {
    restartDelay = IS_MOBILE ? 600 : 0; // reset backoff on any successful result
    networkErrors = 0;

    let interim = '';
    let finalChunk = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalChunk += t;
      else interim += t;
    }

    if (interim) {
      if (!interimMsgEl) {
        interimMsgEl = appendMessage(currentUserName, interim, 'you', true);
      } else {
        interimMsgEl.querySelector('.msg-bubble').textContent = interim;
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    }

    if (finalChunk) {
      if (interimMsgEl) { interimMsgEl.remove(); interimMsgEl = null; }
      const trimmed = finalChunk.trim();
      if (!trimmed) return;

      console.log('[STT] final chunk:', trimmed);

      if (state.mode === 'ai') {
        const speechWrap = appendMessage(currentUserName, trimmed, 'you');
        console.log('[STT] sending to AI:', trimmed);
        sendToAI(trimmed);
      } else if (state.mode === 'person' || state.mode === 'robot') {
        // 'robot' = /face kiosk: chat column is hidden (body.face-mode CSS)
        // but the message still needs to reach the peer's chat over the data channel.
        const speechWrap = appendMessage(currentUserName, trimmed, 'you');
        console.log('[STT] sending to peer:', trimmed);
        sendToPeer(trimmed);
      } else {
        const sep = chatInput.value.trim() ? ' ' : '';
        chatInput.value = chatInput.value.trim() + sep + trimmed;
        autoResizeInput();
      }
    }
  };

  recognition.onerror = (e) => {
    console.warn('[STT] error:', e.error);
    if (['not-allowed', 'service-not-allowed'].includes(e.error)) {
      showSystemMsg('ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน กรุณาอนุญาตในการตั้งค่าเบราว์เซอร์');
      disableSpeech();
    } else if (e.error === 'audio-capture') {
      showSystemMsg('ใช้ไมโครโฟนไม่ได้ — อาจถูกใช้งานโดยแอปอื่นอยู่');
      disableSpeech();
    } else if (e.error === 'network') {
      // Ubuntu's Chromium (snap/apt) ships without the Google API keys its
      // speech service needs, so EVERY session dies here while the UI keeps
      // showing "listening" — the failure mode that hides itself. Two strikes
      // tells a permanently broken build apart from a transient blip.
      if (++networkErrors >= 2 && fallbackToWhisper(
        'บริการรู้จำเสียงของเบราว์เซอร์นี้ใช้งานไม่ได้ — สลับไปใช้ Whisper ให้อัตโนมัติแล้ว'
      )) return;
      // Back off faster on network errors to avoid hammering the service
      restartDelay = Math.min(Math.max(restartDelay, 500) * 2, 8000);
      console.warn('[STT] network error — next restart in', restartDelay, 'ms');
      if (networkErrors === 1) showSystemMsg('การรู้จำเสียงมีปัญหาการเชื่อมต่อ — กำลังลองใหม่…');
    }
  };

  recognition.onend = () => {
    console.log('[STT] session ended — speechOn:', state.speechOn, 'restartDelay:', restartDelay);
    if (!state.speechOn) return;
    setTimeout(() => {
      if (!state.speechOn) return;
      try { recognition.start(); console.log('[STT] restarted'); } catch (err) { console.warn('[STT] restart failed:', err); }
    }, restartDelay);
    // Increase delay after each failed session; start from 300 ms minimum so multiplication works
    restartDelay = restartDelay < 300 ? 300 : Math.min(restartDelay * 1.5, 8000);
  };
}

// On Android Chrome, SpeechRecognition requests the microphone through a
// separate OS-level session from getUserMedia. Just muting the WebRTC audio
// track (`enabled = false`) does NOT release the hardware lock, so the
// recognizer still can't get audio — the track must actually be stopped.
// Every peer connection reserves its audio sender up front (see
// createPeerConnection), so replaceTrack() here never needs SDP renegotiation
// — safe even if a peer connects while the mic is already paused (e.g. /face
// auto-starts STT before any peer has joined).
function pauseLocalAudioForSTT() {
  if (!state.localStream) return;
  const audioTracks = state.localStream.getAudioTracks();
  if (!audioTracks.length) return;
  Object.values(peers).forEach((p) => {
    if (p.audioSender) p.audioSender.replaceTrack(null).catch(() => {});
  });
  audioTracks.forEach(t => { t.stop(); state.localStream.removeTrack(t); });
  console.log('[STT] mic released for speech recognition (mobile)');
}

async function resumeLocalAudioAfterSTT() {
  if (!state.micOn || !state.localStream) return; // respects mute button state
  try {
    const freshStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const newTrack = freshStream.getAudioTracks()[0];
    if (!newTrack) return;
    state.localStream.addTrack(newTrack);
    Object.values(peers).forEach((p) => {
      if (p.audioSender) p.audioSender.replaceTrack(newTrack).catch(() => {});
    });
    console.log('[STT] mic reacquired after speech recognition (mobile)');
  } catch (err) {
    console.warn('[STT] could not reacquire microphone after speech recognition:', err);
  }
}

function enableSpeech() {
  if (!recognition) return;
  recognition.lang = 'th-TH';
  state.speechOn = true;
  // On mobile the Web Speech API and getUserMedia sometimes compete for the
  // microphone. Release the local audio track while STT is active so speech
  // recognition gets exclusive mic access.
  // EXCEPT on the /face kiosk: the operator must always HEAR the customer —
  // live audio outranks STT text. Keep the mic streaming over WebRTC even if
  // that means SpeechRecognition can't grab the mic on Android (use Whisper
  // STT mode in Settings if the kiosk is Android and text is also needed).
  if (IS_MOBILE && !IS_FACE) pauseLocalAudioForSTT();
  try { recognition.start(); } catch {}
  speechBtn.classList.add('active-speech');
  speechBtn.setAttribute('aria-pressed', 'true');
  speechIndicator.style.display = 'flex';
  const hint = state.mode === 'robot'
    ? 'Speech ON (ภาษาไทย) — พูดได้เลย'
    : 'Speech ON (ภาษาไทย) — พูดได้เลย ส่งอัตโนมัติ';
  showSystemMsg(hint);
}

function disableSpeech() {
  state.speechOn = false;
  if (recognition) try { recognition.stop(); } catch {}
  if (interimMsgEl) { interimMsgEl.remove(); interimMsgEl = null; }
  speechBtn.classList.remove('active-speech');
  speechBtn.setAttribute('aria-pressed', 'false');
  speechIndicator.style.display = 'none';
  // Restore mic track when STT is off (respects the mute button state);
  // /face never paused it (see enableSpeech) so nothing to restore there
  if (IS_MOBILE && !IS_FACE) resumeLocalAudioAfterSTT();
}

// ── Whisper STT with silence detection ───────────────────────
let whisperRecorder    = null;
let whisperChunks      = [];
let whisperMimeType    = '';
let whisperAudioCtx    = null;
let whisperContinuous  = false;

const SILENCE_THRESHOLD = 0.015; // RMS level below which counts as silence
const SILENCE_DELAY_MS  = 1500;  // ms of silence before auto-stop
const MIN_RECORD_MS     = 500;   // don't auto-stop before this many ms

async function startWhisperRecording() {
  if (whisperRecorder) return; // already recording
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const tracks = stream.getAudioTracks();
    console.log('[Whisper] mic tracks:', tracks.map(t => `${t.label} enabled=${t.enabled} muted=${t.muted}`));

    const candidates = ['audio/webm;codecs=opus','audio/webm','audio/ogg','audio/mp4'];
    whisperMimeType = candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
    console.log('[Whisper] mime types:', candidates.map(t => `${t}:${MediaRecorder.isTypeSupported(t)}`));
    console.log('[Whisper] selected:', whisperMimeType || '(browser default)');

    whisperChunks = [];
    whisperRecorder = new MediaRecorder(stream, whisperMimeType ? { mimeType: whisperMimeType } : {});
    console.log('[Whisper] recorder mimeType:', whisperRecorder.mimeType);

    whisperRecorder.ondataavailable = e => {
      console.log('[Whisper] chunk:', e.data.size, 'bytes');
      if (e.data.size > 0) whisperChunks.push(e.data);
    };
    whisperRecorder.onerror = e => console.error('[Whisper] recorder error:', e.error);
    whisperRecorder.onstop = async () => {
      console.log('[Whisper] stopped — chunks:', whisperChunks.length, 'bytes:', whisperChunks.reduce((s, c) => s + c.size, 0));
      if (whisperAudioCtx) { whisperAudioCtx.close(); whisperAudioCtx = null; }
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(whisperChunks, { type: whisperMimeType || 'audio/webm' });
      whisperChunks = [];
      console.log('[Whisper] blob size:', blob.size, 'type:', blob.type);
      if (blob.size < 1000) {
        console.warn('[Whisper] blob too small — microphone may not have captured audio');
        showSystemMsg('ไม่มีเสียงถูกบันทึก — กรุณาตรวจสอบสิทธิ์การใช้ไมโครโฟน');
        return;
      }
      await transcribeWhisper(blob);
    };
    whisperRecorder.start(300);

    // ── Silence detection via Web Audio API ──────────────────
    whisperAudioCtx = new AudioContext();
    const analyser  = whisperAudioCtx.createAnalyser();
    analyser.fftSize = 1024;
    whisperAudioCtx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let silenceStart = null;
    const startedAt  = Date.now();

    const checkSilence = () => {
      if (!whisperRecorder || whisperRecorder.state === 'inactive') return;
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
      if (rms < SILENCE_THRESHOLD) {
        if (!silenceStart) silenceStart = Date.now();
        const elapsed = Date.now() - startedAt;
        const silent  = Date.now() - silenceStart;
        if (elapsed > MIN_RECORD_MS && silent > SILENCE_DELAY_MS) {
          console.log('[Whisper] silence detected after', elapsed, 'ms — auto-stopping');
          stopWhisperRecording();
          return;
        }
      } else {
        silenceStart = null;
      }
      requestAnimationFrame(checkSilence);
    };
    requestAnimationFrame(checkSilence);

    speechBtn.classList.add('active-speech');
    speechBtn.setAttribute('aria-pressed', 'true');
    speechIndicator.style.display = 'flex';
    console.log('[Whisper] recording started — will auto-stop on silence');
  } catch (err) {
    console.error('[Whisper] mic error:', err.name, err.message);
    showSystemMsg(`ไมโครโฟนมีปัญหา: ${err.message}`);
  }
}

function stopWhisperRecording() {
  console.log('[Whisper] stop, recorder state:', whisperRecorder?.state);
  if (whisperRecorder && whisperRecorder.state !== 'inactive') {
    whisperRecorder.stop();
  }
  whisperRecorder = null;
  // In continuous mode keep the button/indicator active (we'll restart after transcription)
  if (!whisperContinuous) {
    speechBtn.classList.remove('active-speech');
    speechBtn.setAttribute('aria-pressed', 'false');
    speechIndicator.style.display = 'none';
  }
}

// After TTS finishes speaking, restart Whisper recording (continuous mode)
function restartWhisperAfterTTS() {
  if (!whisperContinuous) return;
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    setTimeout(restartWhisperAfterTTS, 300);
  } else {
    setTimeout(() => { if (whisperContinuous) startWhisperRecording(); }, 400);
  }
}

async function transcribeWhisper(blob) {
  console.log('[Whisper] sending', blob.size, 'bytes, type:', blob.type);
  const indicator = document.createElement('div');
  indicator.className = 'system-msg stt-indicator';
  indicator.textContent = '✦ Transcribing…';
  chatMessages.appendChild(indicator);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  try {
    const sttStart = Date.now();
    const r = await fetch('/api/stt', {
      method: 'POST',
      headers: { 'Content-Type': blob.type, 'X-Mime-Type': blob.type },
      body: blob,
    });
    const responseText = await r.text();
    const sttMs = Date.now() - sttStart;
    console.log('[Whisper] server response', r.status, ':', responseText);
    indicator.remove();
    if (!r.ok) { console.error('[Whisper] server error', r.status, responseText); showSystemMsg(`ถอดความเสียงผิดพลาด: ${r.status}`); return; }
    const { text, error } = JSON.parse(responseText);
    if (error) { console.error('[Whisper] API error:', error); showSystemMsg(`ถอดความเสียงผิดพลาด: ${error}`); return; }
    const trimmed = (text || '').trim();
    if (!trimmed) { console.log('[Whisper] empty transcript'); return; }
    console.log('[Whisper] transcript:', trimmed);

    appendMessage(currentUserName, trimmed, 'you');
    showTimingLog([['STT', sttMs]]);
    // 'robot' = /face kiosk: chat column is hidden but still needs to send to the peer.
    if (state.mode === 'ai') sendToAI(trimmed);
    else sendToPeer(trimmed);
  } catch (err) {
    indicator.remove();
    console.error('[Whisper] error:', err);
  }
  // Continuous mode: wait for TTS to finish then listen again
  if (whisperContinuous) restartWhisperAfterTTS();
}

function toggleSpeech() {
  unlockTTS();
  if (settings.sttMode === 'whisper') {
    if (whisperContinuous) {
      // Turn continuous mode OFF
      whisperContinuous = false;
      stopWhisperRecording();
      speechBtn.classList.remove('active-speech');
      speechBtn.setAttribute('aria-pressed', 'false');
      speechIndicator.style.display = 'none';
      showSystemMsg('ปิดการรับฟังเสียงแล้ว');
    } else {
      // Turn continuous mode ON
      whisperContinuous = true;
      speechBtn.classList.add('active-speech');
      speechBtn.setAttribute('aria-pressed', 'true');
      speechIndicator.style.display = 'flex';
      showSystemMsg('เปิดการรับฟังเสียงแล้ว — จะหยุดบันทึกอัตโนมัติเมื่อเงียบ…');
      startWhisperRecording();
    }
  } else {
    state.speechOn ? disableSpeech() : enableSpeech();
  }
}

// ════════════════════════════════════════════════
//  TTS (AI → voice)
// ════════════════════════════════════════════════
function speak(text) {
  if (!state.speakerOn) return;
  if (!settings.ttsEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(stripJsonBlocks(text));
  utt.rate = settings.ttsRate || 1;
  const thaiVoice = getThaiVoice();
  if (thaiVoice) { utt.voice = thaiVoice; utt.lang = 'th-TH'; }
  utt.onstart = () => { aiAvatar.classList.add('speaking'); aiSpeaking.style.display = 'block'; };
  utt.onend = utt.onerror = () => { aiAvatar.classList.remove('speaking'); aiSpeaking.style.display = 'none'; };
  window.speechSynthesis.speak(utt);
}

function stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  aiAvatar.classList.remove('speaking');
  aiSpeaking.style.display = 'none';
}

// ════════════════════════════════════════════════
//  PEER TTS
//  Two independent flags — they do not mirror each other:
//  myTTSEnabled   = I want MY messages spoken aloud on my peer's device.
//                   Toggled by the button; emits a signal to the peer.
//  peerTTSEnabled = My peer requested that THEIR messages be spoken on MY device.
//                   Set only when the peer sends a 'peer-tts' socket event.
// ════════════════════════════════════════════════
let myTTSEnabled   = false;
let peerTTSEnabled = false;

// Prefer a male-sounding Thai voice (matches the robot's male persona in the
// default system prompt); falls back to whatever Thai voice is available.
function getThaiVoice() {
  const voices = (window.speechSynthesis?.getVoices() || []).filter(v => v.lang.startsWith('th'));
  if (!voices.length) return null;
  const maleKw = /male|man|niwat|narong|boy/i;
  return voices.find(v => maleKw.test(v.name + v.voiceURI)) || voices[0];
}

// Called when an incoming peer message arrives — speak it if the peer has
// enabled voicing for their messages (peerTTSEnabled), not our own toggle.
// When the TTS path is unavailable (peer-TTS off / speaker muted / no
// speechSynthesis), fall back to the screen-reader live region: since
// #chat-messages dropped aria-live, this is the only way a blind operator
// learns a typed message arrived at all. Silent for sighted users, and never
// doubles up with TTS — exactly one of the two paths runs.
function speakPeerMessage(text) {
  const clean = stripJsonBlocks(text);
  if (!clean) return;
  if (!state.speakerOn || !peerTTSEnabled || !window.speechSynthesis) {
    announceAccessibility(`ข้อความ: ${clean}`);
    return;
  }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(clean);
  const thai = getThaiVoice();
  if (thai) utt.voice = thai;
  utt.rate = 1.0;
  window.speechSynthesis.speak(utt);
}

// On-demand speaker button on each message bubble (this IS a user gesture → unlocks TTS on iOS)
function speakOnDemand(text) {
  if (!state.speakerOn) {
    // Explain the no-op: the master speaker switch gates all TTS, and a blind
    // user can't see the muted speaker button state from here.
    announceAccessibility('ลำโพงปิดอยู่ — เปิดลำโพงเพื่อฟังข้อความ');
    return;
  }
  if (!window.speechSynthesis) return;
  unlockTTS();
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(stripJsonBlocks(text));
  const thai = getThaiVoice();
  if (thai) utt.voice = thai;
  utt.rate = 1.0;
  window.speechSynthesis.speak(utt);
}

function updatePeerTTSStatus() {
  const btn = $('peer-tts-btn');
  const statusEl = $('peer-tts-status');
  if (btn) {
    btn.classList.toggle('active-speech', myTTSEnabled);
    btn.setAttribute('aria-pressed', String(myTTSEnabled));
    btn.title = myTTSEnabled
      ? 'เสียงถึงลูกค้าเปิดอยู่ — อีกฝ่ายได้ยินข้อความที่เราพิมพ์'
      : 'ส่งเสียงข้อความของฉันให้อีกฝ่าย';
  }
  if (statusEl) statusEl.textContent = myTTSEnabled ? 'เสียงถึงลูกค้า: เปิด' : 'เสียงถึงลูกค้า: ปิด';
}

function togglePeerTTS() {
  unlockTTS(); // button click = user gesture, satisfies iOS audio unlock
  myTTSEnabled = !myTTSEnabled;
  updatePeerTTSStatus();
  showSystemMsg(myTTSEnabled
    ? 'ข้อความของคุณจะถูกอ่านออกเสียงให้คู่สนทนาฟัง'
    : 'หยุดอ่านออกเสียงข้อความของคุณให้คู่สนทนาแล้ว');
  // Tell the peer to start/stop reading our messages
  if (currentRoomId && socket) {
    socket.emit('peer-tts', { roomId: currentRoomId, enabled: myTTSEnabled });
  }
}

// ════════════════════════════════════════════════
//  CHAT UI
// ════════════════════════════════════════════════
function clearWelcome() {
  const w = chatMessages.querySelector('.chat-welcome');
  if (w) w.remove();
}

function appendMessage(sender, text, side, interim = false) {
  clearWelcome();
  const wrap = document.createElement('div');
  wrap.className = `msg ${side}${interim ? ' interim' : ''}`;
  // Interim STT text mutates every few hundred ms — hide it from screen
  // readers so TalkBack doesn't read half-formed speech fragments non-stop.
  if (interim) wrap.setAttribute('aria-hidden', 'true');

  const senderEl = document.createElement('div');
  senderEl.className = 'msg-sender';
  senderEl.textContent = sender;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  wrap.appendChild(senderEl);
  wrap.appendChild(bubble);

  if (!interim) {
    const footer = document.createElement('div');
    footer.className = 'msg-footer';

    const t = document.createElement('span');
    t.className = 'msg-time';
    t.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    footer.appendChild(t);

    // Speaker button on every peer message (for deaf↔blind accessibility)
    if (side === 'peer') {
      const speakBtn = document.createElement('button');
      speakBtn.className = 'msg-speak-btn';
      speakBtn.title = 'Read aloud / อ่านออกเสียง';
      speakBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      </svg>`;
      speakBtn.addEventListener('click', () => speakOnDemand(text));
      footer.appendChild(speakBtn);
    }

    wrap.appendChild(footer);
  }

  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}

function showTypingIndicator() {
  const wrap = document.createElement('div');
  wrap.id = 'typing-indicator';
  wrap.className = 'msg ai';
  wrap.innerHTML = '<div class="typing-bubble"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}
function removeTypingIndicator() { const el = $('typing-indicator'); if (el) el.remove(); }

// Accessibility announcements go through the hidden #sr-status live region so
// the user's OWN assistive tech (TalkBack / Narrator / NVDA) does the talking.
// Never speak a11y feedback through speechSynthesis — it talks over the screen
// reader. speechSynthesis stays product-only: reading chat messages aloud and
// voicing the operator's messages to the customer.
// Not gated by the speaker button: screen-reader speech is the user's channel,
// independent of the page's audio output.
// assertive=true → #sr-status-assertive: speaks through whatever the screen
// reader is currently saying. Reserved for feedback that happens mid-gesture
// (e.g. "ควบคุมได้แล้ว"), where a polite message may be delayed and dropped.
const srSetTimers = {}, srClearTimers = {};
function announceAccessibility(text, assertive = false) {
  const id = assertive ? 'sr-status-assertive' : 'sr-status';
  const el = $(id);
  if (!el) return;
  // Cancel BOTH pending timers: a stale 30 ms setter from a rapid previous
  // call would otherwise briefly re-surface the old text after our clear.
  clearTimeout(srSetTimers[id]);
  clearTimeout(srClearTimers[id]);
  // Clear first so announcing the same text twice still mutates the region
  // (screen readers only speak on change).
  el.textContent = '';
  srSetTimers[id] = setTimeout(() => { el.textContent = text; }, 30);
  // Wipe later so swipe-explore doesn't stumble onto stale status text.
  srClearTimers[id] = setTimeout(() => { el.textContent = ''; }, 5000);
}

function showSystemMsg(text, { announce = true } = {}) {
  clearWelcome();
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  // System messages carry the app's only error reporting (camera/mic denied,
  // ICE failed, connect_error, STT/AI errors, call ended) — a blind operator
  // must hear them, not just see them. Every call site is a one-shot event,
  // so mirroring to the live region can't flood the screen reader.
  // Call sites that already speak their own (shorter) announcement pass
  // announce:false. (Debug timing logs go through showTimingLog — silent.)
  if (announce) announceAccessibility(text);
}

function showTimingLog(parts) {
  console.log('[Timing]', Object.fromEntries(parts.map(([l, ms]) => [l, `${(ms/1000).toFixed(2)}s`])));
  if (!settings.showTimingLog) return; // debug-only breakdown, hidden from the chat by default
  const el = document.createElement('div');
  el.className = 'system-msg timing-log';
  el.textContent = '⏱ ' + parts.map(([label, ms]) => `${label} ${(ms / 1000).toFixed(2)}s`).join(' · ');
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Mobile browsers (especially iOS) block TTS until a user gesture occurs.
// This shows a tappable banner that unlocks the audio context on tap.
function showTapToUnlockAudio() {
  if (ttsUnlocked) return;
  // Remove any existing banner
  document.querySelectorAll('.tap-unlock-btn').forEach(e => e.remove());
  const el = document.createElement('button');
  el.className = 'tap-unlock-btn';
  el.textContent = 'Tap to enable audio for auto-read';
  el.addEventListener('click', () => {
    unlockTTS();
    el.textContent = 'Audio enabled';
    el.disabled = true;
    setTimeout(() => el.remove(), 1500);
  }, { once: true });
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ════════════════════════════════════════════════
//  SEND
// ════════════════════════════════════════════════
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  autoResizeInput();

  const youWrap = appendMessage(currentUserName, text, 'you');

  if (state.mode === 'ai') {
    await sendToAI(text);
  } else {
    sendToPeer(text); // 'person' or 'robot' (/face)
  }
}

// ════════════════════════════════════════════════
//  EMOTION DETECTION → MQTT robot/emotion
// ════════════════════════════════════════════════
// Extracts all top-level {...} blocks from text (handles nested braces like Analog:{}).
function extractJsonBlocks(text) {
  const blocks = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth++ === 0) start = i; }
    else if (text[i] === '}') {
      if (--depth === 0 && start !== -1) { blocks.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return blocks;
}

// Remove all {...} blocks (including nested) and collapse extra whitespace.
function stripJsonBlocks(text) {
  let result = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { depth++; continue; }
    if (text[i] === '}') { depth--; continue; }
    if (depth === 0) result += text[i];
  }
  return result.replace(/\s+/g, ' ').trim();
}

function publishEmotion(text) {
  const emotions = [];
  for (const block of extractJsonBlocks(text)) {
    try {
      const d = JSON.parse(block);
      if (d.Head === undefined && d.Mouth === undefined && d.Analog === undefined) continue;
      emotions.push({
        Head:   clampNum(Math.round(d.Head  ?? WIRE_HEAD_BASE), WIRE_HEAD_MIN, WIRE_HEAD_MAX),
        Mouth:  clampNum(Math.round(d.Mouth ?? WIRE_MOUTH_MIN), WIRE_MOUTH_MIN, WIRE_MOUTH_MAX),
        Analog: {
          x: Math.min(1, Math.max(-1, +(d.Analog?.x ?? 0).toFixed(3))),
          y: Math.min(1, Math.max(-1, +(d.Analog?.y ?? 0).toFixed(3))),
        },
      });
    } catch {}
  }
  if (emotions.length && mqttClient && mqttClient.connected) {
    mqttClient.publish('robot/emotion', JSON.stringify(emotions));
  }
}

// ════════════════════════════════════════════════
//  AI API
// ════════════════════════════════════════════════
async function sendToAI(text) {
  if (state.aiTyping) return;
  state.aiTyping = true;
  aiHistory.push({ role: 'user', content: text });
  const typing = showTypingIndicator();

  try {
    const aiStart = Date.now();
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        systemPrompt: settings.systemPrompt,
        messages: aiHistory,
      }),
    });
    const data = await res.json();
    const aiMs = Date.now() - aiStart;
    typing.remove();

    if (data.error) {
      showSystemMsg(`AI ผิดพลาด: ${data.error}`);
      aiHistory.pop();
    } else {
      aiHistory.push({ role: 'assistant', content: data.content });
      const displayText = stripJsonBlocks(data.content);
      publishEmotion(data.content);
      const aiWrap = appendMessage('AI', displayText, 'ai');
      showTimingLog([['AI reply', aiMs]]);
      speak(displayText);
    }
  } catch (err) {
    typing.remove();
    showSystemMsg(`เครือข่ายผิดพลาด: ${err.message}`);
    aiHistory.pop();
  } finally {
    state.aiTyping = false;
  }
}

// ════════════════════════════════════════════════
//  SOCKET.IO SIGNALING
// ════════════════════════════════════════════════
function initSocket() {
  socket = io();   // connects to same origin (HTTPS)

  socket.on('room-joined', ({ roomId, peers: existingPeers }) => {
    currentRoomId = roomId;
    if (existingPeers.length) {
      setRoomStatus(`กำลังเชื่อมต่อกับคู่สนทนา…`, false);
      existingPeers.forEach((pid) => startCall(pid, true));
    } else {
      setRoomStatus('กำลังรอให้อีกฝ่ายเข้าร่วม…', false);
    }
  });

  socket.on('peer-joined', (peerId) => {
    showSystemMsg('คู่สนทนาเข้าร่วมแล้ว — กำลังเชื่อมต่อ…', { announce: false });
    announceAccessibility('อีกฝ่ายเข้ามาแล้ว'); // deliberately shorter than the visual msg
    startCall(peerId, false);
  });

  socket.on('signal', async ({ from, signal }) => {
    if (!peers[from]) createPeerConnection(from);
    const pc = peers[from].pc;

    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, signal: pc.localDescription });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
      } else if (signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal));
      }
    } catch (e) {
      console.warn('Signal handling error:', e);
    }
  });

  socket.on('peer-left', (peerId) => {
    cleanupPeer(peerId);
    peerTTSEnabled = false; // reset when peer leaves; new peer starts fresh
    setRoomStatus('คู่สนทนาตัดการเชื่อมต่อ — กำลังรอ…', false);
    showSystemMsg('คู่สนทนาออกจากห้องแล้ว', { announce: false });
    announceAccessibility('อีกฝ่ายออกแล้ว'); // deliberately shorter than the visual msg
    setFaceWaitingVisible(true);
  });

  socket.on('chat-message', ({ from, message }) => {
    console.log('[Chat] received via socket relay:', message);
    const wrap = appendMessage('คู่สนทนา', message, 'peer');
    speakPeerMessage(message);
  });

  // Peer requested that their messages be spoken on our device (or cancelled that request).
  // This sets peerTTSEnabled — it does NOT change our own toggle (myTTSEnabled).
  socket.on('peer-tts', ({ enabled }) => {
    peerTTSEnabled = enabled;
    showSystemMsg(enabled
      ? 'คู่สนทนาเปิดเสียงข้อความของตัวเองแล้ว — ข้อความของเขาจะถูกอ่านออกเสียงที่นี่'
      : 'คู่สนทนาปิดเสียงข้อความของตัวเองแล้ว');
    // On mobile, speechSynthesis is blocked until a user gesture. Prompt the user
    // to tap so audio works before the first message arrives.
    if (enabled && IS_MOBILE && !ttsUnlocked) showTapToUnlockAudio();
  });

  socket.on('connect_error', (e) => {
    showSystemMsg(`เชื่อมต่อผิดพลาด: ${e.message}`);
  });
}

// ════════════════════════════════════════════════
//  WEBRTC
// ════════════════════════════════════════════════
function createPeerConnection(peerId) {
  // Use the fetched ICE config (includes TURN servers for cross-network)
  const currentIceConfig = buildIceConfig(iceConfig.iceServers);
  const pc = new RTCPeerConnection(currentIceConfig);
  peers[peerId] = { pc, dc: null, audioSender: null };

  // Reserve the audio m-line up front (even with no track yet) so mobile STT
  // can later pause/resume the mic via replaceTrack() without needing SDP
  // renegotiation — this app never wires up onnegotiationneeded.
  const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  peers[peerId].audioSender = audioTransceiver.sender;
  const localAudioTrack = state.localStream ? state.localStream.getAudioTracks()[0] : null;
  if (localAudioTrack) audioTransceiver.sender.replaceTrack(localAudioTrack).catch(() => {});

  if (state.localStream) {
    state.localStream.getVideoTracks().forEach((t) => pc.addTrack(t, state.localStream));
  }

  // Remote stream display
  const remoteStream = new MediaStream();
  pc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    remoteVideo.srcObject = remoteStream;
    remoteVideo.classList.add('active');
    aiAvatar.style.display = 'none';
    remoteName.textContent = 'คู่สนทนา';
    setRoomStatus('เชื่อมต่อแล้ว ●', true);
    announceAccessibility('ต่อติดแล้ว คุยได้เลย');
    setFaceWaitingVisible(false);
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { to: peerId, signal: candidate });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('ICE state:', s);
    if (s === 'failed') {
      showSystemMsg('การเชื่อมต่อ WebRTC ล้มเหลว หากคู่สนทนาอยู่คนละเครือข่าย ให้ตรวจสอบว่า TURN server เชื่อมต่อได้');
      pc.restartIce();
    }
    if (s === 'disconnected') {
      setRoomStatus('การเชื่อมต่อขาดหาย…', false);
      setFaceWaitingVisible(true);
    }
  };

  // Data channel receives (for the non-initiator side)
  pc.ondatachannel = (e) => setupDataChannel(peerId, e.channel);

  return pc;
}

function setupDataChannel(peerId, dc) {
  peers[peerId].dc = dc;
  dc.onopen = () => console.log('Data channel open with', peerId);
  dc.onmessage = (e) => {
    if (applyRobotPayload(e.data)) {
      console.log('[Chat] data channel message treated as robot payload, not chat:', e.data);
      return;
    }
    console.log('[Chat] received via data channel:', e.data);
    const wrap = appendMessage('คู่สนทนา', e.data, 'peer');
    speakPeerMessage(e.data);
  };
  dc.onerror = (e) => console.warn('DC error:', e);
}

async function startCall(peerId, isInitiator) {
  const pc = createPeerConnection(peerId);
  if (isInitiator) {
    const dc = pc.createDataChannel('chat', { ordered: true });
    setupDataChannel(peerId, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, signal: pc.localDescription });
  }
}

function cleanupPeer(peerId) {
  if (!peers[peerId]) return;
  peers[peerId].pc.close();
  delete peers[peerId];
  remoteVideo.srcObject = null;
  remoteVideo.classList.remove('active');
  if (state.mode === 'person') {
    aiAvatar.style.display = 'none';
    remoteName.textContent = 'กำลังรอคู่สนทนา…';
  }
}

// Send via data channel (prefer) or socket relay (fallback, not both)
function sendToPeer(text) {
  let dcSent = false;
  Object.values(peers).forEach(({ dc }) => {
    if (dc && dc.readyState === 'open') { dc.send(text); dcSent = true; }
  });
  if (dcSent) {
    console.log('[Chat] sent via data channel:', text);
  }
  // Only fall back to socket relay when no data channel is open
  if (!dcSent && currentRoomId) {
    console.log('[Chat] sent via socket relay to room', currentRoomId + ':', text);
    socket.emit('chat-message', { roomId: currentRoomId, message: text });
  } else if (!dcSent) {
    console.warn('[Chat] could NOT send — no open data channel and no currentRoomId:', text);
  }
}

// ════════════════════════════════════════════════
//  ROOM
// ════════════════════════════════════════════════
function generateRoomCode() {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  roomCodeDisplay.textContent = code;
  currentRoomId = code;
  socket.emit('join-room', code);
  setRoomStatus('กำลังรอให้อีกฝ่ายเข้าร่วม…', false);
  aiAvatar.style.display = 'none';
  remoteName.textContent = 'กำลังรอคู่สนทนา…';
  announceAccessibility(`รหัสห้อง ${code.split('').join(' ')}`);
}

function joinRoom(code) {
  const c = code.trim().toUpperCase();
  if (!c) return;
  // Clean up any existing peers before joining new room
  Object.keys(peers).forEach(cleanupPeer);
  currentRoomId = c;
  roomCodeDisplay.textContent = c;
  joinInput.value = '';
  socket.emit('join-room', c);
  setRoomStatus(`กำลังเข้าร่วมห้อง ${c}…`, false);
  aiAvatar.style.display = 'none';
  remoteName.textContent = 'กำลังเชื่อมต่อ…';
}

function setRoomStatus(text, connected) {
  roomStatus.textContent = text;
  roomStatus.className = 'room-status' + (connected ? ' connected' : '');
}

function endCall() {
  stopSpeaking();
  Object.keys(peers).forEach(cleanupPeer);

  if (state.mode === 'ai') {
    remoteName.textContent = 'ผู้ช่วย AI';
    aiHistory.length = 0;
    showSystemMsg('เริ่มบทสนทนาใหม่แล้ว');
  } else {
    joinRoom('FACE');
    showSystemMsg('วางสายแล้ว กำลังกลับเข้าห้อง FACE…');
  }
}

// ════════════════════════════════════════════════
//  SETTINGS MODAL
// ════════════════════════════════════════════════
function populateSettingsForm() {
  $('s-theme').value = settings.theme === 'dark' ? 'dark' : 'light';
  $('s-show-ai-mode').checked = !!settings.showAiMode;
  $('s-show-detect-btn').checked = !!settings.showDetectButton;
  $('s-show-timing-log').checked = !!settings.showTimingLog;
  $('s-dpad-speed').value = settings.dpadSpeed || '1';
  $('s-remote-rotation').value = settings.remoteRotation || '0';
  $('s-provider').value  = settings.provider;
  $('s-baseurl').value   = settings.baseUrl;
  $('s-apikey').value    = settings.apiKey;
  $('s-model').value     = settings.model;
  $('s-system').value    = settings.systemPrompt;
  $('s-stt-mode').value      = settings.sttMode || 'whisper';
  $('s-tts').checked     = settings.ttsEnabled;
  $('s-rate').value      = settings.ttsRate;
  $('rate-val').textContent = settings.ttsRate;
  $('s-mqtt-url').value   = settings.mqttUrl   || '';
  $('s-mqtt-topic').value = settings.mqttTopic || 'robot/control';
  $('s-turn-url').value  = settings.turnUrl  || '';
  $('s-turn-user').value = settings.turnUser || '';
  $('s-turn-pass').value = settings.turnPass || '';
  toggleBaseUrlField(settings.provider);
}

function readSettingsForm() {
  return {
    theme:            $('s-theme').value,
    showAiMode:       $('s-show-ai-mode').checked,
    showDetectButton: $('s-show-detect-btn').checked,
    showTimingLog:    $('s-show-timing-log').checked,
    dpadSpeed:        $('s-dpad-speed').value,
    remoteRotation:   $('s-remote-rotation').value,
    provider:     $('s-provider').value,
    baseUrl:      $('s-baseurl').value || DEFAULT_SETTINGS.baseUrl,
    apiKey:       $('s-apikey').value,
    model:        ($('s-model-select').style.display !== 'none' ? $('s-model-select').value : $('s-model').value) || DEFAULT_SETTINGS.model,
    systemPrompt: $('s-system').value  || DEFAULT_SETTINGS.systemPrompt,
    sttMode:      $('s-stt-mode').value,
    ttsEnabled:   $('s-tts').checked,
    ttsRate:      parseFloat($('s-rate').value),
    mqttUrl:      $('s-mqtt-url').value.trim(),
    mqttTopic:    $('s-mqtt-topic').value.trim() || 'robot/control',
    turnUrl:      $('s-turn-url').value.trim(),
    turnUser:     $('s-turn-user').value.trim(),
    turnPass:     $('s-turn-pass').value.trim(),
  };
}

function toggleBaseUrlField(provider) {
  const hideUrl = provider === 'anthropic' || provider === 'gemini' || provider === 'groq' || provider === 'openrouter' || provider === '9arm';
  $('field-baseurl').style.display = hideUrl ? 'none' : 'flex';
  const keyField = $('s-apikey');
  const hasServerKey = !!SERVER_KEYS[provider];
  $('field-apikey').style.display = hasServerKey ? 'none' : '';
  if (!hasServerKey) {
    keyField.value = settings.apiKey || '';
    keyField.placeholder = 'sk-…';
    keyField.style.opacity = '';
    keyField.type = 'password';
    $('toggle-key-btn').textContent = 'แสดง';
  }

  const modelSelect = $('s-model-select');
  const modelInput  = $('s-model');
  const models = PROVIDER_MODELS[provider];
  if (models && models.length) {
    modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    const cur = modelInput.value;
    modelSelect.value = models.includes(cur) ? cur : models[0];
    modelInput.value  = modelSelect.value;
    modelSelect.style.display = '';
    modelInput.style.display  = 'none';
  } else {
    modelSelect.style.display = 'none';
    modelInput.style.display  = '';
    const cur = modelInput.value;
    if (provider === 'gemini'    && !cur.startsWith('gemini-'))  modelInput.value = 'gemini-2.0-flash';
    if (provider === 'anthropic' && !cur.startsWith('claude-'))  modelInput.value = 'claude-sonnet-4-6';
    if (provider === 'openai'    && (cur.startsWith('gemini-') || cur.startsWith('claude-') || cur.startsWith('llama') || cur.startsWith('qwen'))) modelInput.value = 'gpt-4o-mini';
  }
}

// ── Modal focus management (a11y) ──────────────────────────
// Remembers what had focus before a modal opened so it can be restored on
// close, and keeps Tab from leaking focus out of the open modal.
let modalReturnFocusEl = null;

function openModal(overlayEl, focusTargetId) {
  modalReturnFocusEl = document.activeElement;
  overlayEl.classList.add('open');
  requestAnimationFrame(() => $(focusTargetId)?.focus());
}

function closeModal(overlayEl) {
  overlayEl.classList.remove('open');
  if (modalReturnFocusEl && document.body.contains(modalReturnFocusEl)) modalReturnFocusEl.focus();
  modalReturnFocusEl = null;
}

function trapModalFocus(e) {
  const overlay = settingsOverlay.classList.contains('open') ? settingsOverlay
                : $('help-overlay').classList.contains('open') ? $('help-overlay')
                : null;
  if (!overlay) return;
  const focusables = Array.prototype.filter.call(
    overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    (el) => !el.disabled && el.offsetParent !== null
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last  = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openSettingsModal()  { populateSettingsForm(); openModal(settingsOverlay, 'settings-close-btn'); }
function closeSettingsModal() { closeModal(settingsOverlay); }

function openHelpModal()  { openModal($('help-overlay'), 'help-close-btn'); }
function closeHelpModal() { closeModal($('help-overlay')); }

// ════════════════════════════════════════════════
//  INPUT HELPERS
// ════════════════════════════════════════════════
function autoResizeInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

// ════════════════════════════════════════════════
//  EVENT LISTENERS
// ════════════════════════════════════════════════
function bindEventListeners() {
  document.querySelectorAll('.mode-btn').forEach(btn =>
    btn.addEventListener('click', () => applyMode(btn.dataset.mode))
  );

  micBtn.addEventListener('click', toggleMic);
  speakerBtn.addEventListener('click', toggleSpeaker);
  videoBtn.addEventListener('click', toggleCam);
  // 90°/270° rotation sizes the video from the wrap's dimensions — track resizes
  window.addEventListener('resize', applyRemoteRotation);
  speechBtn.addEventListener('click', toggleSpeech);
  detectBtn.addEventListener('click', toggleDetect);
  endBtn.addEventListener('click', () => {
    // Only confirm when there's an actual peer connected — in AI mode, or
    // person mode before anyone joined, End is non-destructive (just resets).
    const hasActiveCall = state.mode === 'person' && Object.keys(peers).length > 0;
    if (hasActiveCall && !confirm('ต้องการวางสายและตัดการเชื่อมต่อกับคู่สนทนาหรือไม่?')) return;
    endCall();
  });
  $('peer-tts-btn').addEventListener('click', togglePeerTTS);

  document.addEventListener('keydown', (e) => {
    if (!isModalOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (settingsOverlay.classList.contains('open')) closeSettingsModal();
      else closeHelpModal();
    } else if (e.key === 'Tab') {
      trapModalFocus(e);
    }
  });

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  chatInput.addEventListener('input', autoResizeInput);

  joinBtn.addEventListener('click', () => joinRoom(joinInput.value));
  joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(joinInput.value); });

  copyCodeBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(roomCodeDisplay.textContent).then(() => {
      copyCodeBtn.textContent = 'คัดลอกแล้ว!';
      announceAccessibility('คัดลอกรหัสแล้ว');
      setTimeout(() => (copyCodeBtn.textContent = 'คัดลอก'), 1500);
    }).catch(() => {
      // Clipboard can be blocked (permissions / non-secure context) — say so
      // instead of failing silently. showSystemMsg announces it too.
      showSystemMsg(`คัดลอกอัตโนมัติไม่สำเร็จ — รหัสห้องคือ ${roomCodeDisplay.textContent}`);
    });
  });

  $('help-btn').addEventListener('click', openHelpModal);
  $('help-close-btn').addEventListener('click', closeHelpModal);
  $('help-got-it-btn').addEventListener('click', closeHelpModal);
  $('help-overlay').addEventListener('click', (e) => { if (e.target === $('help-overlay')) closeHelpModal(); });

  $('settings-open-btn').addEventListener('click', openSettingsModal);
  $('settings-close-btn').addEventListener('click', closeSettingsModal);
  $('settings-cancel-btn').addEventListener('click', closeSettingsModal);
  settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettingsModal(); });

  $('settings-save-btn').addEventListener('click', () => {
    settings = readSettingsForm();
    persistSettings(settings);
    applyTheme();
    closeSettingsModal();
    showSystemMsg('บันทึกการตั้งค่าแล้ว');
    applyAiModeVisibility();
    if (!settings.showAiMode && state.mode === 'ai') applyMode('person');
    applyDetectButtonVisibility();
    applyRemoteRotation();
    // Re-connect MQTT if broker URL changed while in person mode (manual robot controls)
    if (state.mode === 'person') connectMQTT();
  });

  $('s-provider').addEventListener('change', (e) => toggleBaseUrlField(e.target.value));
  $('s-model-select').addEventListener('change', (e) => { $('s-model').value = e.target.value; });
  $('s-rate').addEventListener('input', (e) => {
    $('rate-val').textContent = parseFloat(e.target.value).toFixed(1);
  });

  $('toggle-key-btn').addEventListener('click', () => {
    const inp = $('s-apikey');
    const btn = $('toggle-key-btn');
    if (inp.type === 'password') { inp.type = 'text'; btn.textContent = 'ซ่อน'; }
    else { inp.type = 'password'; btn.textContent = 'แสดง'; }
  });
}

// ════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  initLoginScreen();   // show login first; it calls initApp() after success
});

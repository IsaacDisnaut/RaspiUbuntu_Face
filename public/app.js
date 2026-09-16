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
      errorEl.textContent = 'Please enter your name.';
      input.classList.add('error');
      input.focus();
      return;
    }

    // Show loading state
    btn.disabled = true;
    btnText.textContent = 'Starting…';

    try {
      await doLogin(name);
      // Animate out login screen
      screen.classList.add('exit');
      screen.addEventListener('transitionend', () => {
        screen.style.display = 'none';
        // Boot the main app now that we have a session
        initApp();
      }, { once: true });
    } catch (err) {
      errorEl.textContent = err.message || 'Could not connect. Try again.';
      btn.disabled = false;
      btnText.textContent = 'Get Started';
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
  provider: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  model: 'llama-3.3-70b-versatile',
  systemPrompt: 'You are a male Thai robot. You mainly speak Thai as your native language. You can move your face left-right, move both eyes, and open/close your mouth. In EVERY response include emotion JSON blocks to animate your face, placed anywhere in your message, using EXACTLY this format: {"Head":45,"Mouth":30,"Analog":{"x":0,"y":0}}\nRanges: Head 20-100 (20=look left,45=center, 100=look right), Mouth 30-100 (30=closed, 100=open/smile), Analog x -1 to 1 (eye pan), y -1 to 1 (eye tilt). Include as many frames as needed to make the animation feel natural (e.g. approach → peak → settle).',
  sttMode: 'whisper',
  ttsEnabled: true,
  ttsRate: 1.0,
  voiceGender: 'male',
  turnUrl: '',
  turnUser: '',
  turnPass: '',
  mqttUrl: 'wss://test.mosquitto.org:8081',
  mqttTopic: 'robot/control',
};

function loadSettings() {
  try {
    const s = localStorage.getItem('vc_settings');
    const saved = s ? JSON.parse(s) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      systemPrompt: DEFAULT_SETTINGS.systemPrompt,
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function persistSettings(s) { localStorage.setItem('vc_settings', JSON.stringify(s)); }
let settings = loadSettings();

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
const detectCanvas     = $('detect-canvas');
const aiCameraPanel    = $('ai-camera-panel');
const aiDetectCanvas   = $('ai-detect-canvas');

let detectOn      = false;
let detectLoopId  = null;  // setTimeout handle
let aiTab         = 'robot'; // 'robot' | 'camera'

// ────────────────────────────────────────────────
//  YOLO OBJECT DETECTION (via yolo_server.py)
// ────────────────────────────────────────────────

// Switch between Robot model and Camera+detect in AI mode
function switchAiTab(tab) {
  aiTab = tab;
  document.querySelectorAll('.ai-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  const robotPanel = $('robot-panel');

  if (tab === 'robot') {
    robotPanel.style.display      = 'flex';
    aiCameraPanel.style.display   = 'none';
  } else {
    robotPanel.style.display      = 'none';
    aiCameraPanel.style.display   = 'flex';
  }
}

// Toggle for person/robot modes (detect button)
function toggleDetect() {
  detectOn = !detectOn;
  detectBtn.classList.toggle('off', !detectOn);
  detectCanvas.style.display = detectOn ? '' : 'none';

  const localWrap  = $('local-wrap');
  const robotPanel = $('robot-panel');

  if (detectOn) {
    localWrap.style.cssText =
      'display:block; position:relative; width:100%; flex:1; border-radius:0; border:none;';
    if (robotPanel) robotPanel.style.display = 'none';
    runDetectionLoop();
  } else {
    clearTimeout(detectLoopId);
    detectCanvas.getContext('2d').clearRect(0, 0, detectCanvas.width, detectCanvas.height);
    localWrap.style.cssText = '';
    if (state.mode === 'ai' || state.mode === 'robot') {
      if (robotPanel) robotPanel.style.display = 'flex';
      localWrap.style.display = 'none';
    }
  }
}

async function runDetectionLoop() {
  if (!detectOn) return;

  const vw = localVideo.videoWidth  || localVideo.clientWidth;
  const vh = localVideo.videoHeight || localVideo.clientHeight;

  if (vw > 0 && vh > 0) {
    // Choose which canvas to draw on
    const inAiCamera = (state.mode === 'ai' && aiTab === 'camera');
    const target = inAiCamera ? aiDetectCanvas : detectCanvas;

    target.width  = vw;
    target.height = vh;

    // Capture un-mirrored frame for YOLO
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

      const ctx = target.getContext('2d');
      ctx.clearRect(0, 0, vw, vh);

      // In AI camera tab: draw the video frame first (canvas replaces the video element)
      if (inAiCamera) ctx.drawImage(localVideo, 0, 0, vw, vh);

      ctx.font      = 'bold 13px sans-serif';
      ctx.lineWidth = 2;

      for (const { x1, y1, x2, y2, label, conf } of boxes) {
        const hue   = Math.abs(label.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;
        const color = `hsl(${hue},90%,55%)`;
        ctx.strokeStyle = color;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

        const tag = `${label} ${(conf * 100).toFixed(0)}%  (${Math.round((x1+x2)/2)},${Math.round((y1+y2)/2)})`;
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
    joinRoom('FACE');    // must be before applyMode so currentRoomId is set
    applyMode('robot');
  } else {
    applyMode('ai');
    showSystemMsg(`Welcome, ${currentUserName}!`);
    if (settings.mqttUrl) connectMQTT(); // connect early so emotion publishes work in AI mode
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
      showSystemMsg('Camera/mic permission denied — tap the lock icon in your browser address bar and allow access, then reload.');
    } else if (e.name === 'NotFoundError') {
      showSystemMsg('No camera/mic found — chat still works.');
    } else {
      showSystemMsg('Camera/mic not available — chat still works.');
    }
  }
}

function toggleMic() {
  if (!state.localStream) return;
  state.micOn = !state.micOn;
  state.localStream.getAudioTracks().forEach(t => (t.enabled = state.micOn));
  micBtn.classList.toggle('off', !state.micOn);
  micBtn.title = state.micOn ? 'Mute microphone' : 'Unmute microphone';
}

function toggleCam() {
  if (!state.localStream) return;
  state.camOn = !state.camOn;
  state.localStream.getVideoTracks().forEach(t => (t.enabled = state.camOn));
  localVideo.classList.toggle('hidden', !state.camOn);
  camPlaceholder.classList.toggle('visible', !state.camOn);
  videoBtn.classList.toggle('off', !state.camOn);
  videoBtn.title = state.camOn ? 'Disable camera' : 'Enable camera';
}

// ════════════════════════════════════════════════
//  MODE
// ════════════════════════════════════════════════
function applyMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );

  const robotPanel = $('robot-panel');
  const remoteWrap = $('remote-wrap');
  const localWrap  = $('local-wrap');

  const controlsRow = document.querySelector('.robot-controls-row');

  const aiTabs = $('ai-tabs');

  if (mode === 'robot') {
    aiTabs.style.display     = 'none';
    detectBtn.style.display  = '';
    robotPanel.style.display = 'flex';
    if (controlsRow) controlsRow.style.display = '';
    remoteWrap.style.display = 'none';
    localWrap.style.cssText  = '';
    localWrap.style.display  = 'none';
    roomBar.style.display = currentRoomId ? 'block' : 'none';
    if (recognition) recognition.lang = 'th-TH';
    // stop AI-mode detect loop if switching away
    if (detectOn) { detectOn = false; clearTimeout(detectLoopId); }
    initRobotPanel();
  } else if (mode === 'ai') {
    aiTabs.style.display     = 'flex';
    detectBtn.style.display  = 'none';
    if (controlsRow) controlsRow.style.display = 'none';
    remoteWrap.style.display = 'none';
    localWrap.style.display  = 'none';   // local-wrap stays as PiP only for person mode
    roomBar.style.display    = 'none';
    if (!detectOn) { detectOn = true; runDetectionLoop(); }
    switchAiTab('robot');
    initRobotPanel();
  } else {
    aiTabs.style.display     = 'none';
    detectBtn.style.display  = '';
    robotPanel.style.display = 'none';
    if (controlsRow) controlsRow.style.display = '';
    remoteWrap.style.display = '';
    localWrap.style.cssText  = '';
    localWrap.style.display  = '';
    // stop AI-mode detect loop if switching away
    if (detectOn && aiTab !== null) {
      detectOn = false;
      clearTimeout(detectLoopId);
      detectCanvas.style.display = 'none';
      detectBtn.classList.remove('off');
    }
  }

  if (mode === 'ai') {
    aiAvatar.style.display = 'none';
    remoteVideo.classList.remove('active');
    remoteName.textContent = 'AI Assistant';
    if (recognition) recognition.lang = 'th-TH';
  } else if (mode === 'person') {
    roomBar.style.display = 'block';
    if (!currentRoomId) joinRoom('FACE');
    else aiAvatar.style.display = 'none';
    if (recognition) recognition.lang = 'th-TH';
  }

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

// ── Three.js joint driver ────────────────────────
function updateRobotModel() {
  const rv = window.robotViewer;
  if (!rv) return;
  // D-pad left/right → head rotation (degrees → radians, limit ±0.524)
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

// Shared parser used by both MQTT and WebRTC data channel
function applyRobotPayload(str) {
  try {
    const data = JSON.parse(str);
    if (data.Head === undefined && data.Mouth === undefined && data.Analog === undefined) return false;
    if (data.Head   !== undefined) robotState.headAngle = data.Head - 65;
    if (data.Mouth  !== undefined) robotState.mouthOpen = (data.Mouth - 20) / 130;
    if (data.Analog !== undefined) {
      robotState.analogX = data.Analog.x ?? robotState.analogX;
      robotState.analogY = data.Analog.y ?? robotState.analogY;
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
function connectMQTT() {
  const url   = settings.mqttUrl || '';
  const topic = settings.mqttTopic || 'robot/control';
  const dot   = $('mqtt-dot');
  const txt   = $('mqtt-status-text');

  if (!url) { txt.textContent = 'Set broker URL in Settings'; dot.className = 'mqtt-dot'; return; }
  if (!window.mqtt) { txt.textContent = 'mqtt.js not loaded'; return; }

  if (mqttClient) {
    try { mqttClient.end(true); } catch {}
    mqttClient = null;
  }

  txt.textContent = 'Connecting…';
  dot.className = 'mqtt-dot';

  try {
    mqttClient = window.mqtt.connect(url, {
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 8000,
      clean: true,
    });
    mqttClient.on('connect', () => {
      txt.textContent = url.replace('ws://', '').replace('wss://', '').split('/')[0];
      dot.className = 'mqtt-dot connected';
      mqttClient.subscribe(topic);          // robot/control — joystick / d-pad
      mqttClient.subscribe('robot/emotion'); // AI emotion sequences
    });
    mqttClient.on('message', (t, payload) => {
      if (t === 'robot/emotion') playEmotionSequence(payload.toString());
      else applyRobotPayload(payload.toString());
    });
    mqttClient.on('error', (e) => {
      txt.textContent = e.message || 'Error';
      dot.className = 'mqtt-dot error';
    });
    mqttClient.on('close', () => {
      if (txt.textContent !== 'Connecting…') {
        txt.textContent = 'Disconnected';
        dot.className = 'mqtt-dot';
      }
    });
  } catch (e) {
    txt.textContent = 'Failed: ' + e.message;
    dot.className = 'mqtt-dot error';
  }
}

function publishRobotState() {
  const headDeg  = Math.round(65 + robotState.headAngle);
  const mouthDeg = Math.round(20 + robotState.mouthOpen * 130);
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
  // Publish to robot/emotion so deep.py and /face both receive it
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish('robot/emotion', msg);
  }
}

// ── Joystick ─────────────────────────────────────
function initJoystick() {
  const base  = $('joystick-base');
  const thumb = $('joystick-thumb');
  let active = false;

  function getCenter() {
    const r = base.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, maxR: r.width * 0.35 };
  }

  function move(clientX, clientY) {
    const c  = getCenter();
    let dx   = clientX - c.x;
    let dy   = clientY - c.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d > c.maxR) { dx = dx / d * c.maxR; dy = dy / d * c.maxR; }
    thumb.style.transform     = `translate(${dx}px,${dy}px)`;
    thumb.classList.add('active');
    robotState.analogX = +(dx / c.maxR).toFixed(3);
    robotState.analogY = +(-dy / c.maxR).toFixed(3);
    publishRobotState();
  }

  function release() {
    if (!active) return;
    active = false;
    thumb.style.transform = 'translate(0,0)';
    thumb.classList.remove('active');
    robotState.analogX = 0;
    robotState.analogY = 0;
    publishRobotState();
  }

  base.addEventListener('mousedown',  (e) => { active = true; move(e.clientX, e.clientY); });
  base.addEventListener('touchstart', (e) => { e.preventDefault(); active = true; move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  document.addEventListener('mousemove',  (e) => { if (active) move(e.clientX, e.clientY); });
  document.addEventListener('touchmove',  (e) => { if (active) { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); } }, { passive: false });
  document.addEventListener('mouseup',   release);
  document.addEventListener('touchend',  release);
}

// ── D-pad ─────────────────────────────────────────
function applyDPad() {
  switch (robotState.padDir) {
    case 'left':  robotState.headAngle = Math.min(robotState.headAngle + 3,  35); break;
    case 'right': robotState.headAngle = Math.max(robotState.headAngle - 3, -35); break;
    case 'up':    robotState.mouthOpen = Math.max(robotState.mouthOpen - 0.10,  0); break;
    case 'down':  robotState.mouthOpen = Math.min(robotState.mouthOpen + 0.10,  1); break;
  }
}

function initDPad() {
  const centerBtn = $('dpad-center');
  if (centerBtn) {
    function resetAll() {
      robotState.headAngle = 0;
      robotState.mouthOpen = 0;
      robotState.analogX   = 0;
      robotState.analogY   = 0;
      publishRobotState();
    }
    centerBtn.addEventListener('mousedown',  resetAll);
    centerBtn.addEventListener('touchstart', (e) => { e.preventDefault(); resetAll(); }, { passive: false });
  }

  ['up', 'down', 'left', 'right'].forEach((dir) => {
    const btn = $(`dpad-${dir}`);

    function press() {
      robotState.padDir = dir;
      btn.classList.add('pressed');
      applyDPad();
      publishRobotState();
      if (dpadInterval) clearInterval(dpadInterval);
      dpadInterval = setInterval(() => { applyDPad(); publishRobotState(); }, 50);
    }

    function release() {
      if (robotState.padDir !== dir) return;
      clearInterval(dpadInterval);
      dpadInterval = null;
      robotState.padDir = null;
      btn.classList.remove('pressed');
      publishRobotState();
    }

    btn.addEventListener('mousedown',   press);
    btn.addEventListener('touchstart',  (e) => { e.preventDefault(); press(); }, { passive: false });
    btn.addEventListener('mouseup',     release);
    btn.addEventListener('touchend',    release);
    btn.addEventListener('mouseleave',  release);
  });
}

// ── Panel init (called once on first robot-mode entry) ──
function initRobotPanel() {
  if (!robotPanelReady) {
    robotPanelReady = true;
    initJoystick();
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
//  SPEECH RECOGNITION
// ════════════════════════════════════════════════
function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    speechBtn.style.display = 'none';
    if (IS_IOS) {
      // Delay so it appears after the welcome message
      setTimeout(() => showSystemMsg(
        'Speech recognition is not available on iOS Safari. Please type your messages.'
      ), 1200);
    }
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

  recognition.onresult = async (e) => {
    restartDelay = IS_MOBILE ? 600 : 0; // reset backoff on any successful result

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

      if (state.mode === 'person' || state.mode === 'ai') {
        const speechWrap = appendMessage(currentUserName, trimmed, 'you');

        console.log('[STT] sending to AI:', trimmed);

        if (state.mode === 'person') sendToPeer(trimmed);
        else sendToAI(trimmed);
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
      showSystemMsg('Microphone access denied. Allow microphone in browser settings.');
      disableSpeech();
    } else if (e.error === 'audio-capture') {
      showSystemMsg('Cannot access microphone — it may be in use by another app.');
      disableSpeech();
    } else if (e.error === 'network') {
      // Back off faster on network errors to avoid hammering the service
      restartDelay = Math.min(Math.max(restartDelay, 500) * 2, 8000);
      console.warn('[STT] network error — next restart in', restartDelay, 'ms');
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

function enableSpeech() {
  if (!recognition) return;
  recognition.lang = 'th-TH';
  state.speechOn = true;
  // On mobile the Web Speech API and getUserMedia sometimes compete for the
  // microphone. Pause the local audio track while STT is active so speech
  // recognition gets exclusive mic access.
  if (IS_MOBILE && state.localStream) {
    state.localStream.getAudioTracks().forEach(t => (t.enabled = false));
  }
  try { recognition.start(); } catch {}
  speechBtn.classList.add('active-speech');
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
  speechIndicator.style.display = 'none';
  // Restore mic track when STT is off (respects the mute button state)
  if (IS_MOBILE && state.localStream && state.micOn) {
    state.localStream.getAudioTracks().forEach(t => (t.enabled = true));
  }
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
        showSystemMsg('No audio captured — check microphone permissions.');
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
    speechIndicator.style.display = 'flex';
    console.log('[Whisper] recording started — will auto-stop on silence');
  } catch (err) {
    console.error('[Whisper] mic error:', err.name, err.message);
    showSystemMsg(`Microphone error: ${err.message}`);
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
    if (!r.ok) { console.error('[Whisper] server error', r.status, responseText); showSystemMsg(`Whisper error: ${r.status}`); return; }
    const { text, error } = JSON.parse(responseText);
    if (error) { console.error('[Whisper] API error:', error); showSystemMsg(`Whisper API error: ${error}`); return; }
    const trimmed = (text || '').trim();
    if (!trimmed) { console.log('[Whisper] empty transcript'); return; }
    console.log('[Whisper] transcript:', trimmed);

    appendMessage(currentUserName, trimmed, 'you');
    showTimingLog([['STT', sttMs]]);
    if (state.mode === 'person') sendToPeer(trimmed);
    else sendToAI(trimmed);
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
      speechIndicator.style.display = 'none';
      showSystemMsg('Speech OFF.');
    } else {
      // Turn continuous mode ON
      whisperContinuous = true;
      speechBtn.classList.add('active-speech');
      speechIndicator.style.display = 'flex';
      showSystemMsg('Speech ON — listening continuously, will stop on silence…');
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
  if (!settings.ttsEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(stripJsonBlocks(text));
  utt.rate = settings.ttsRate || 1;
  const thaiVoice = getThaiVoice(settings.voiceGender);
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

// Pick a Thai voice matching the requested gender (best-effort; falls back to any Thai voice)
function getThaiVoice(gender = 'male') {
  const voices = (window.speechSynthesis?.getVoices() || []).filter(v => v.lang.startsWith('th'));
  if (!voices.length) return null;
  const maleKw   = /male|man|niwat|narong|boy/i;
  const femaleKw = /female|woman|pattara|kanya|girl/i;
  const kw = gender === 'female' ? femaleKw : maleKw;
  return voices.find(v => kw.test(v.name + v.voiceURI)) || voices[0];
}

// Called when an incoming peer message arrives — speak it if the peer has
// enabled voicing for their messages (peerTTSEnabled), not our own toggle.
function speakPeerMessage(text) {
  if (!peerTTSEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(stripJsonBlocks(text));
  const thai = getThaiVoice(settings.voiceGender);
  if (thai) utt.voice = thai;
  utt.rate = 1.0;
  window.speechSynthesis.speak(utt);
}

// On-demand speaker button on each message bubble (this IS a user gesture → unlocks TTS on iOS)
function speakOnDemand(text) {
  if (!window.speechSynthesis) return;
  unlockTTS();
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(stripJsonBlocks(text));
  const thai = getThaiVoice(settings.voiceGender);
  if (thai) utt.voice = thai;
  utt.rate = 1.0;
  window.speechSynthesis.speak(utt);
}

function togglePeerTTS() {
  unlockTTS(); // button click = user gesture, satisfies iOS audio unlock
  myTTSEnabled = !myTTSEnabled;
  const btn = $('peer-tts-btn');
  btn.classList.toggle('active-speech', myTTSEnabled);
  btn.title = myTTSEnabled
    ? 'Voicing my messages ON — peer will hear what I type'
    : 'Voice my messages to peer';
  showSystemMsg(myTTSEnabled
    ? 'Your messages will be read aloud to your peer.'
    : 'Stopped voicing your messages to peer.');
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

function showSystemMsg(text) {
  clearWelcome();
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTimingLog(parts) {
  const el = document.createElement('div');
  el.className = 'system-msg timing-log';
  el.textContent = '⏱ ' + parts.map(([label, ms]) => `${label} ${(ms / 1000).toFixed(2)}s`).join(' · ');
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  console.log('[Timing]', Object.fromEntries(parts.map(([l, ms]) => [l, `${(ms/1000).toFixed(2)}s`])));
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

  if (state.mode === 'person') {
    sendToPeer(text);
  } else {
    await sendToAI(text);
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
        Head:   Math.min(150, Math.max(20,  Math.round(d.Head  ?? 65))),
        Mouth:  Math.min(100, Math.max(30,  Math.round(d.Mouth ?? 30))),
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
      showSystemMsg(`API error: ${data.error}`);
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
    showSystemMsg(`Network error: ${err.message}`);
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
      setRoomStatus(`Connecting to peer(s)…`, false);
      existingPeers.forEach((pid) => startCall(pid, true));
    } else {
      setRoomStatus('Waiting for someone to join…', false);
    }
  });

  socket.on('peer-joined', (peerId) => {
    showSystemMsg('Peer joined — establishing connection…');
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
    setRoomStatus('Peer disconnected — waiting…', false);
    showSystemMsg('Peer left the room.');
  });

  socket.on('chat-message', ({ from, message }) => {
    const wrap = appendMessage('Peer', message, 'peer');
    speakPeerMessage(message);
  });

  // Peer requested that their messages be spoken on our device (or cancelled that request).
  // This sets peerTTSEnabled — it does NOT change our own toggle (myTTSEnabled).
  socket.on('peer-tts', ({ enabled }) => {
    peerTTSEnabled = enabled;
    showSystemMsg(enabled
      ? "Peer enabled voice for their messages — they'll be read aloud here."
      : 'Peer stopped voicing their messages.');
    // On mobile, speechSynthesis is blocked until a user gesture. Prompt the user
    // to tap so audio works before the first message arrives.
    if (enabled && IS_MOBILE && !ttsUnlocked) showTapToUnlockAudio();
  });

  socket.on('connect_error', (e) => {
    showSystemMsg(`Connection error: ${e.message}`);
  });
}

// ════════════════════════════════════════════════
//  WEBRTC
// ════════════════════════════════════════════════
function createPeerConnection(peerId) {
  // Use the fetched ICE config (includes TURN servers for cross-network)
  const currentIceConfig = buildIceConfig(iceConfig.iceServers);
  const pc = new RTCPeerConnection(currentIceConfig);
  peers[peerId] = { pc, dc: null };

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  }

  // Remote stream display
  const remoteStream = new MediaStream();
  pc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    remoteVideo.srcObject = remoteStream;
    remoteVideo.classList.add('active');
    aiAvatar.style.display = 'none';
    remoteName.textContent = 'Peer';
    setRoomStatus('Connected ●', true);
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { to: peerId, signal: candidate });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('ICE state:', s);
    if (s === 'failed') {
      showSystemMsg('WebRTC connection failed. If peers are on different networks, check that TURN servers are reachable.');
      pc.restartIce();
    }
    if (s === 'disconnected') {
      setRoomStatus('Connection interrupted…', false);
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
    if (applyRobotPayload(e.data)) return;  // robot control — don't show as chat
    const wrap = appendMessage('Peer', e.data, 'peer');
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
    remoteName.textContent = 'Waiting for peer…';
  }
}

// Send via data channel (prefer) or socket relay (fallback, not both)
function sendToPeer(text) {
  let dcSent = false;
  Object.values(peers).forEach(({ dc }) => {
    if (dc && dc.readyState === 'open') { dc.send(text); dcSent = true; }
  });
  // Only fall back to socket relay when no data channel is open
  if (!dcSent && currentRoomId) {
    socket.emit('chat-message', { roomId: currentRoomId, message: text });
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
  setRoomStatus('Waiting for someone to join…', false);
  aiAvatar.style.display = 'none';
  remoteName.textContent = 'Waiting for peer…';
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
  setRoomStatus(`Joining room ${c}…`, false);
  aiAvatar.style.display = 'none';
  remoteName.textContent = 'Connecting…';
}

function setRoomStatus(text, connected) {
  roomStatus.textContent = text;
  roomStatus.className = 'room-status' + (connected ? ' connected' : '');
}

function endCall() {
  stopSpeaking();
  Object.keys(peers).forEach(cleanupPeer);

  if (state.mode === 'ai') {
    aiAvatar.style.display = 'flex';
    remoteName.textContent = 'AI Assistant';
    aiHistory.length = 0;
    showSystemMsg('Conversation reset.');
  } else {
    joinRoom('FACE');
    showSystemMsg('Call ended. Rejoining room FACE…');
  }
}

// ════════════════════════════════════════════════
//  SETTINGS MODAL
// ════════════════════════════════════════════════
function populateSettingsForm() {
  $('s-provider').value  = settings.provider;
  $('s-baseurl').value   = settings.baseUrl;
  $('s-apikey').value    = settings.apiKey;
  $('s-model').value     = settings.model;
  $('s-system').value    = settings.systemPrompt;
  $('s-stt-mode').value      = settings.sttMode || 'whisper';
  $('s-tts').checked     = settings.ttsEnabled;
  $('s-rate').value      = settings.ttsRate;
  $('rate-val').textContent = settings.ttsRate;
  $('s-voice-gender').value = settings.voiceGender || 'male';
  $('s-mqtt-url').value   = settings.mqttUrl   || '';
  $('s-mqtt-topic').value = settings.mqttTopic || 'robot/control';
  $('s-turn-url').value  = settings.turnUrl  || '';
  $('s-turn-user').value = settings.turnUser || '';
  $('s-turn-pass').value = settings.turnPass || '';
  toggleBaseUrlField(settings.provider);
}

function readSettingsForm() {
  return {
    provider:     $('s-provider').value,
    baseUrl:      $('s-baseurl').value || DEFAULT_SETTINGS.baseUrl,
    apiKey:       $('s-apikey').value,
    model:        ($('s-model-select').style.display !== 'none' ? $('s-model-select').value : $('s-model').value) || DEFAULT_SETTINGS.model,
    systemPrompt: $('s-system').value  || DEFAULT_SETTINGS.systemPrompt,
    sttMode:      $('s-stt-mode').value,
    ttsEnabled:   $('s-tts').checked,
    ttsRate:      parseFloat($('s-rate').value),
    voiceGender:  $('s-voice-gender').value,
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
    $('toggle-key-btn').textContent = 'Show';
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

function openSettingsModal()  { populateSettingsForm(); settingsOverlay.classList.add('open'); }
function closeSettingsModal() { settingsOverlay.classList.remove('open'); }

function openHelpModal()  { $('help-overlay').classList.add('open'); }
function closeHelpModal() { $('help-overlay').classList.remove('open'); }

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
  videoBtn.addEventListener('click', toggleCam);
  speechBtn.addEventListener('click', toggleSpeech);
  detectBtn.addEventListener('click', toggleDetect);
  endBtn.addEventListener('click', endCall);

  document.querySelectorAll('.ai-tab').forEach(btn =>
    btn.addEventListener('click', () => switchAiTab(btn.dataset.tab))
  );
  $('peer-tts-btn').addEventListener('click', togglePeerTTS);

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  chatInput.addEventListener('input', autoResizeInput);

  joinBtn.addEventListener('click', () => joinRoom(joinInput.value));
  joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(joinInput.value); });

  copyCodeBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(roomCodeDisplay.textContent).then(() => {
      copyCodeBtn.textContent = 'Copied!';
      setTimeout(() => (copyCodeBtn.textContent = 'Copy'), 1500);
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
    closeSettingsModal();
    showSystemMsg('Settings saved.');
    // Re-connect MQTT if broker URL changed while in robot mode
    if (state.mode === 'robot') connectMQTT();
  });

  $('s-provider').addEventListener('change', (e) => toggleBaseUrlField(e.target.value));
  $('s-model-select').addEventListener('change', (e) => { $('s-model').value = e.target.value; });
  $('s-rate').addEventListener('input', (e) => {
    $('rate-val').textContent = parseFloat(e.target.value).toFixed(1);
  });

  $('toggle-key-btn').addEventListener('click', () => {
    const inp = $('s-apikey');
    const btn = $('toggle-key-btn');
    if (inp.type === 'password') { inp.type = 'text'; btn.textContent = 'Hide'; }
    else { inp.type = 'password'; btn.textContent = 'Show'; }
  });
}

// ════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════
// Also save session when the call is manually ended
const _origEndCall = endCall;
// endCall is defined above — wrap it to also flush session time
// (we don't overwrite endCall to avoid circular ref; handled via beforeunload too)

window.addEventListener('DOMContentLoaded', () => {
  initLoginScreen();   // show login first; it calls initApp() after success
});

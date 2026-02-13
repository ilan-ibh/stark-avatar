import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import {
  createCore, createRings, createContainment,
  updateCore, updateRings, updateContainment,
} from './orb.js';
import {
  createParticles, createLeadParticles,
  updateParticles, updateLeadParticles,
} from './particles.js';
import { StateManager } from './states.js';
import { AudioManager } from './audio.js';
import { SoundManager } from './sound.js';

// ─── Scene ─────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 5.0);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  alpha: false,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// ─── Post-Processing (Bloom) ───────────────────────────────

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.6,   // strength (UnrealBloom is much more aggressive than pmndrs Bloom)
  0.35,  // radius
  0.3,   // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ─── Scene Objects ─────────────────────────────────────────

const core = createCore();
scene.add(core.group);

const rings = createRings();
for (const ring of rings) scene.add(ring.group);

const containment = createContainment();
scene.add(containment.group);

const particles = createParticles();
scene.add(particles.points);

const leadParticles = createLeadParticles();
scene.add(leadParticles.points);

// ─── State & Audio ─────────────────────────────────────────

const stateManager = new StateManager();
const audioManager = new AudioManager();
const soundManager = new SoundManager();

// ─── Debounced Mode Handling ──────────────────────────────

let pendingMode = null;
let modeDebounceTimer = null;
const MODE_DEBOUNCE_MS = 400;

let userSpokeDuringTurn = false;
let silenceStartTime = 0;
let thinkingTriggered = false;
let committedMode = null;

function commitMode(mode) {
  if (mode === committedMode) return;
  const prev = committedMode;
  committedMode = mode;
  thinkingTriggered = false;

  if (mode === 'speaking') {
    userSpokeDuringTurn = false;
    silenceStartTime = 0;
    stateManager.setState('speaking');
  } else if (mode === 'listening') {
    userSpokeDuringTurn = false;
    silenceStartTime = 0;
    stateManager.setState('listening');
    // Agent just stopped speaking → fade caption after 2s
    if (prev === 'speaking') fadeCaptionAfterSpeaking();
  }
}

audioManager.onModeChange = (mode) => {
  // Speaking always commits immediately — no lag on voice start
  if (mode === 'speaking') {
    clearTimeout(modeDebounceTimer);
    pendingMode = null;
    commitMode('speaking');
    return;
  }

  // Ignore 'listening' if thinking-gap is active — stay in thinking until speaking arrives
  if (mode === 'listening' && thinkingTriggered) {
    return;
  }

  // Debounce speaking→listening to absorb brief speech pauses
  if (mode === 'listening' && committedMode === 'speaking') {
    pendingMode = 'listening';
    clearTimeout(modeDebounceTimer);
    modeDebounceTimer = setTimeout(() => {
      if (pendingMode === 'listening') {
        commitMode('listening');
        pendingMode = null;
      }
    }, MODE_DEBOUNCE_MS);
    return;
  }

  commitMode(mode);
};

// ─── Connection Status ────────────────────────────────────

let intentionalDisconnect = false;

audioManager.onStatusChange = (status) => {
  if (status === 'connected') {
    committedMode = 'listening';
    stateManager.setState('listening');
    updateConnectionUI(true);
  } else if (status === 'disconnected') {
    committedMode = null;
    pendingMode = null;
    clearTimeout(modeDebounceTimer);
    if (intentionalDisconnect) intentionalDisconnect = false;
    stateManager.setState('idle');
    updateConnectionUI(false);
    hideCaption();
  }
};

// ─── Live Captions ────────────────────────────────────────

const captionEl = document.getElementById('caption');
const captionLabelEl = document.getElementById('caption-label');
const captionTextEl = document.getElementById('caption-text');
let captionFadeTimer = null;
let lastCaptionSource = null; // 'user' or 'agent'

function showCaption(label, text, isUser) {
  if (captionLabelEl) captionLabelEl.textContent = label;
  if (captionTextEl) captionTextEl.textContent = text;
  if (captionEl) captionEl.className = isUser ? 'visible user' : 'visible';
  lastCaptionSource = isUser ? 'user' : 'agent';

  // User captions fade after 3s (they get replaced by agent response anyway)
  // Agent captions stay visible — cleared by fadeCaptionAfterSpeaking()
  clearTimeout(captionFadeTimer);
  if (isUser) {
    captionFadeTimer = setTimeout(() => {
      if (captionEl) captionEl.className = '';
    }, 3000);
  }
}

function fadeCaptionAfterSpeaking() {
  // Called when agent stops speaking — keep text visible for 2 more seconds
  if (lastCaptionSource !== 'agent') return;
  clearTimeout(captionFadeTimer);
  captionFadeTimer = setTimeout(() => {
    if (captionEl) captionEl.className = '';
  }, 2000);
}

function hideCaption() {
  clearTimeout(captionFadeTimer);
  if (captionEl) captionEl.className = '';
  if (captionTextEl) captionTextEl.textContent = '';
  if (captionLabelEl) captionLabelEl.textContent = '';
  lastCaptionSource = null;
}

audioManager.onMessage = (message) => {
  try {
    const source = message?.source || message?.type || '';
    const role = message?.role || '';
    const text = message?.message;
    if (!text || typeof text !== 'string') return;

    const isUser = source === 'user' || role === 'user' || source === 'user_transcript';
    showCaption(isUser ? 'YOU' : 'STARK', text, isUser);
  } catch {
    // Never let caption errors affect the conversation
  }
};

// ─── UI ────────────────────────────────────────────────────

const statusEl = document.getElementById('status');
const controlsEl = document.getElementById('controls');
let controlsVisible = true;
let controlsTimer = null;

function showControls() {
  controlsEl.classList.remove('hidden');
  controlsVisible = true;
  resetControlsTimer();
}

function resetControlsTimer() {
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => {
    controlsEl.classList.add('hidden');
    controlsVisible = false;
  }, 5000);
}

resetControlsTimer();

function updateStatusUI(sv) {
  if (audioManager.isConnecting) {
    statusEl.textContent = 'connecting';
  } else {
    statusEl.textContent = sv.label;
  }
  const [r, g, b] = sv.color;
  const rgb = `${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}`;
  statusEl.style.color = `rgba(${rgb}, 0.5)`;
  // Caption text inherits the state color
  if (captionLabelEl) captionLabelEl.style.color = `rgba(${rgb}, 0.4)`;
  if (captionTextEl) captionTextEl.style.color = `rgba(${rgb}, 0.7)`;
}

function updateConnectionUI(connected) {
  const hint = document.getElementById('connect-hint');
  if (hint) {
    hint.textContent = connected
      ? 'connected \u2014 press Space to disconnect'
      : 'press Space to connect';
  }
}

// ─── Camera Zoom ───────────────────────────────────────────

let targetZoom = 5.0;
const ZOOM_MIN = 2.5;
const ZOOM_MAX = 12.0;

// ─── Keyboard Controls ────────────────────────────────────

const stateNames = stateManager.getStateNames();

function isAgentActive() {
  return audioManager.isActive || audioManager.isConnecting;
}

window.addEventListener('keydown', (e) => {
  showControls();

  switch (e.key) {
    case '1':
    case '2':
    case '4':
    case '5': {
      if (isAgentActive()) break;
      const idx = Number(e.key) - 1;
      stateManager.setState(stateNames[idx]);
      audioManager.setSimulated(false);
      break;
    }
    case '3':
      if (isAgentActive()) break;
      soundManager.init();
      stateManager.setState(stateNames[2]);
      audioManager.setSimulated(true);
      break;

    case ' ':
      e.preventDefault();
      toggleAgent();
      break;

    case 'f':
    case 'F':
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
      break;

    case 'd':
    case 'D':
      toggleDemo();
      break;

    case 'm':
    case 'M':
      soundManager.toggleMute();
      break;

    case 'Escape':
      if (controlsVisible) {
        controlsEl.classList.add('hidden');
        controlsVisible = false;
      } else {
        showControls();
      }
      break;
  }
});

async function toggleAgent() {
  // Init sound on first interaction (browser autoplay policy)
  soundManager.init();

  if (audioManager.isActive) {
    intentionalDisconnect = true;
    await audioManager.stopConversation();
    stateManager.setState('idle');
  } else if (!audioManager.isConnecting) {
    stateManager.setState('thinking');
    try {
      await audioManager.startConversation();
    } catch (err) {
      console.error('[stark] connection failed:', err);
      stateManager.setState('alert');
      setTimeout(() => stateManager.setState('idle'), 2000);
    }
  }
}

window.addEventListener('mousemove', () => showControls());

window.addEventListener('wheel', (e) => {
  targetZoom += e.deltaY * 0.005;
  targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetZoom));
}, { passive: true });

// ─── Resize ────────────────────────────────────────────────

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

// ─── Animation Loop ────────────────────────────────────────

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;

  stateManager.update(dt);
  audioManager.update(dt);

  const sv = stateManager.current;
  const audioBands = {
    level: audioManager.level,
    bass: audioManager.bass,
    mid: audioManager.mid,
    treble: audioManager.treble,
  };

  // Thinking-gap detection
  if (committedMode === 'listening' && !thinkingTriggered) {
    if (audioManager.level > 0.08) {
      userSpokeDuringTurn = true;
      silenceStartTime = 0;
    } else if (userSpokeDuringTurn && silenceStartTime === 0) {
      silenceStartTime = performance.now();
    } else if (userSpokeDuringTurn && silenceStartTime > 0 && performance.now() - silenceStartTime > 1500) {
      thinkingTriggered = true;
      stateManager.setState('thinking');
    }
  }

  // Update visual components
  updateCore(core, sv, elapsed, audioBands);
  updateRings(rings, sv, elapsed, dt, audioBands);
  updateContainment(containment, sv, elapsed, dt, stateManager);
  updateParticles(particles, sv, elapsed, dt);
  updateLeadParticles(leadParticles, sv, elapsed, dt);

  // Bloom
  bloomPass.strength = sv.bloomStrength + stateManager.flashIntensity * 2.0;

  // Micro-zoom pulse during thinking — subtle intensity
  const thinkingZoomOffset = sv.label === 'thinking'
    ? Math.sin(elapsed * 4) * 0.12
    : 0;

  // Subtle camera orbital drift — full orbit ~100 minutes
  const driftAngle = elapsed * 0.001;
  const lf = 1 - Math.exp(-dt * 5);
  camera.position.z = THREE.MathUtils.lerp(camera.position.z, targetZoom + thinkingZoomOffset, lf);
  camera.position.x = Math.sin(driftAngle) * 0.25;
  camera.position.y = Math.cos(driftAngle * 0.7) * 0.12;
  camera.lookAt(0, 0, 0);

  updateStatusUI(sv);
  soundManager.update(sv.label, audioBands);
  composer.render();
}

animate();

// ─── Demo Mode ─────────────────────────────────────────────

let demoMode = false;
let demoIndex = 0;
let demoInterval = null;

function toggleDemo() {
  if (isAgentActive()) return;

  if (demoMode) {
    clearInterval(demoInterval);
    demoMode = false;
    stateManager.setState('idle');
    audioManager.setSimulated(false);
  } else {
    demoMode = true;
    demoIndex = 0;
    demoInterval = setInterval(() => {
      demoIndex = (demoIndex + 1) % stateNames.length;
      const name = stateNames[demoIndex];
      stateManager.setState(name);
      audioManager.setSimulated(name === 'speaking');
    }, 4000);
  }
}

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { createOrb, createCore, createAtmosphere, updateOrb } from './orb.js';
import { createParticles, createDust, updateParticles, updateDust } from './particles.js';
import { StateManager } from './states.js';
import { AudioManager } from './audio.js';

// ─── Scene ─────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 5.0);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

// ─── Post-Processing ───────────────────────────────────────

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.8,   // strength (driven by state)
  0.45,  // radius
  0.3,   // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ─── Orb + Core + Atmosphere ───────────────────────────────

const { mesh: orbMesh, uniforms: orbUniforms } = createOrb();
const { mesh: coreMesh, uniforms: coreUniforms } = createCore();
const { mesh: atmosMesh, uniforms: atmosUniforms } = createAtmosphere();

scene.add(coreMesh);
scene.add(orbMesh);
scene.add(atmosMesh);

// ─── Particles + Dust ──────────────────────────────────────

const { points: particlePoints, material: particleMaterial } = createParticles();
const { points: dustPoints, material: dustMaterial } = createDust();

scene.add(dustPoints);
scene.add(particlePoints);

// ─── State & Audio ─────────────────────────────────────────

const stateManager = new StateManager();
const audioManager = new AudioManager();

// ─── Debounced Mode Handling ──────────────────────────────
// ElevenLabs fires onModeChange rapidly during natural speech pauses.
// We debounce: only commit a state change if the mode is stable for 400ms.
// This absorbs flickering between speaking/listening during conversation.

let pendingMode = null;
let modeDebounceTimer = null;
const MODE_DEBOUNCE_MS = 400;

// Thinking-gap: after the user speaks and goes silent, show "thinking"
// while the LLM processes. Track whether the user actually spoke.
let userSpokeDuringTurn = false;
let silenceStartTime = 0;
let thinkingTriggered = false;

// The committed visual state (what the orb is actually showing)
let committedMode = null;

function commitMode(mode) {
  if (mode === committedMode) return;
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
  }
}

audioManager.onModeChange = (mode) => {
  // If switching TO speaking, commit immediately (no lag on voice start)
  if (mode === 'speaking') {
    clearTimeout(modeDebounceTimer);
    pendingMode = null;
    commitMode('speaking');
    return;
  }

  // For listening, debounce — wait 400ms to confirm it's not a brief pause
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

  // Default: commit directly (e.g. first mode change after connect)
  commitMode(mode);
};

// ─── Connection Status ────────────────────────────────────
// No auto-reconnect — ElevenLabs can't resume sessions, so reconnecting
// starts a brand new conversation with first_message. Better to go idle
// and let the user press Space when ready.
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

    if (intentionalDisconnect) {
      intentionalDisconnect = false;
    }
    // Always return to idle — user presses Space to start a new session
    stateManager.setState('idle');
    updateConnectionUI(false);
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
  // Always show the orb's actual visual state — it's the source of truth
  if (audioManager.isConnecting) {
    statusEl.textContent = 'connecting';
  } else {
    statusEl.textContent = sv.label;
  }
  const [r, g, b] = sv.color;
  statusEl.style.color = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.5)`;
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
const ZOOM_MIN = 2.8;
const ZOOM_MAX = 10.0;

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
  if (audioManager.isActive) {
    intentionalDisconnect = true;
    await audioManager.stopConversation();
    stateManager.setState('idle');
  } else if (!audioManager.isConnecting) {
    stateManager.setState('thinking');
    try {
      await audioManager.startConversation();
    } catch {
      stateManager.setState('alert');
      setTimeout(() => stateManager.setState('idle'), 2000);
    }
  }
}

window.addEventListener('mousemove', () => showControls());

window.addEventListener('wheel', (e) => {
  targetZoom += e.deltaY * 0.004;
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
  const pr = Math.min(window.devicePixelRatio, 2);
  particleMaterial.uniforms.uPixelRatio.value = pr;
  dustMaterial.uniforms.uPixelRatio.value = pr;
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

  // ── Thinking-gap detection ──
  // Only triggers when: user spoke during this listening turn → then went
  // fully silent for 1.5s. This means the user finished their sentence and
  // the LLM is processing. Does NOT trigger during speech pauses.
  if (committedMode === 'listening' && !thinkingTriggered) {
    if (audioManager.level > 0.08) {
      // User is speaking — mark it and reset silence timer
      userSpokeDuringTurn = true;
      silenceStartTime = 0;
    } else if (userSpokeDuringTurn && silenceStartTime === 0) {
      // User just went silent — start the silence timer
      silenceStartTime = performance.now();
    } else if (
      userSpokeDuringTurn &&
      silenceStartTime > 0 &&
      performance.now() - silenceStartTime > 1500
    ) {
      // Sustained silence after speech — LLM is processing
      thinkingTriggered = true;
      stateManager.setState('thinking');
    }
  }

  updateOrb(orbUniforms, coreUniforms, atmosUniforms, sv, elapsed, audioBands);

  orbMesh.rotation.y += sv.rotationSpeed * dt;
  coreMesh.rotation.y -= sv.rotationSpeed * 0.5 * dt;
  atmosMesh.rotation.y += sv.rotationSpeed * 0.2 * dt;

  updateParticles(particleMaterial, sv, elapsed, audioBands.level);
  updateDust(dustMaterial, sv, elapsed);

  bloomPass.strength = sv.bloomStrength + stateManager.flashIntensity * 2.0;
  camera.position.z += (targetZoom - camera.position.z) * 0.04;

  updateStatusUI(sv);
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

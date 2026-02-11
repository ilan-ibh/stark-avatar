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
  0.8,   // strength — pulled back so surface detail reads
  0.45,  // radius
  0.3    // threshold — higher so only real hotspots bloom
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

// Bridge ElevenLabs agent mode changes → orb state machine
audioManager.onModeChange = (mode) => {
  if (mode === 'speaking') {
    stateManager.setState('speaking');
  } else if (mode === 'listening') {
    stateManager.setState('listening');
  }
};

audioManager.onStatusChange = (status) => {
  if (status === 'connected') {
    stateManager.setState('listening');
    updateConnectionUI(true);
  } else if (status === 'disconnected') {
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
  const label = sv.label;
  // Show connection state in label when agent is active
  if (audioManager.isActive && audioManager.agentMode) {
    statusEl.textContent = audioManager.agentMode;
  } else if (audioManager.isConnecting) {
    statusEl.textContent = 'connecting';
  } else {
    statusEl.textContent = label;
  }
  const [r, g, b] = sv.color;
  statusEl.style.color = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.5)`;
}

function updateConnectionUI(connected) {
  const connectHint = document.getElementById('connect-hint');
  if (connectHint) {
    connectHint.textContent = connected ? 'connected — press Space to disconnect' : 'press Space to connect';
  }
}

// ─── Camera Zoom ───────────────────────────────────────────

let targetZoom = 5.0;
const ZOOM_MIN = 2.8;
const ZOOM_MAX = 10.0;

// ─── Keyboard Controls ────────────────────────────────────

const stateNames = stateManager.getStateNames();

function stopSimAudioIfNeeded() {
  if (audioManager._simulated) {
    audioManager._simulated = false;
  }
}

// Track if agent is active to prevent manual state overrides during conversation
function isAgentActive() {
  return audioManager.isActive || audioManager.isConnecting;
}

window.addEventListener('keydown', (e) => {
  showControls();

  switch (e.key) {
    // Manual state controls (only when agent is NOT connected)
    case '1':
      if (!isAgentActive()) { stateManager.setState(stateNames[0]); stopSimAudioIfNeeded(); }
      break;
    case '2':
      if (!isAgentActive()) { stateManager.setState(stateNames[1]); stopSimAudioIfNeeded(); }
      break;
    case '3':
      if (!isAgentActive()) {
        stateManager.setState(stateNames[2]);
        audioManager._simulated = true;
      }
      break;
    case '4':
      if (!isAgentActive()) { stateManager.setState(stateNames[3]); stopSimAudioIfNeeded(); }
      break;
    case '5':
      if (!isAgentActive()) { stateManager.setState(stateNames[4]); stopSimAudioIfNeeded(); }
      break;

    // Space = toggle ElevenLabs agent conversation
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
    // Disconnect
    await audioManager.stopConversation();
    stateManager.setState('idle');
  } else if (!audioManager.isConnecting) {
    // Connect — show thinking while establishing connection
    stateManager.setState('thinking');
    try {
      await audioManager.startConversation();
      // onConnect callback will switch to 'listening'
    } catch (err) {
      console.error('[STARK] Agent connection failed:', err);
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
  if (isAgentActive()) return; // don't demo while agent is connected

  if (demoMode) {
    clearInterval(demoInterval);
    demoMode = false;
    stateManager.setState('idle');
    stopSimAudioIfNeeded();
    console.log('[STARK] Demo OFF');
  } else {
    demoMode = true;
    demoIndex = 0;
    demoInterval = setInterval(() => {
      demoIndex = (demoIndex + 1) % stateNames.length;
      const name = stateNames[demoIndex];
      stateManager.setState(name);
      if (name === 'speaking') {
        audioManager._simulated = true;
      } else {
        stopSimAudioIfNeeded();
      }
    }, 4000);
    console.log('[STARK] Demo ON');
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') toggleDemo();
});

console.log(
  '%c[STARK] Avatar initialized. Space = connect agent, 1-5 = manual states, D = demo, F = fullscreen.',
  'color: #2680ff; font-weight: bold'
);

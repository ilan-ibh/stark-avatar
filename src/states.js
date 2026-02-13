/**
 * State machine for the Stark avatar.
 * Manages state definitions, transitions, and smooth lerping between states.
 *
 * Visual design: JARVIS-style holographic construct.
 * Color palette and parameters from the Aegis Presence design.
 */

const STATE_CONFIGS = {
  idle: {
    color: [100 / 255, 180 / 255, 255 / 255],       // Ice blue
    coreColor: [40 / 255, 80 / 255, 140 / 255],
    intensity: 1.0,
    rotationSpeed: 0.15,
    ringSpeed: 0.3,
    particleSpeed: 0.5,
    displacement: 0,
    scale: 1.0,
    containmentPulse: 0,
    innerGlow: 0.6,
    bloomStrength: 0.5,
    label: 'idle',
  },
  thinking: {
    color: [180 / 255, 160 / 255, 80 / 255],         // Warm gold
    coreColor: [100 / 255, 90 / 255, 30 / 255],
    intensity: 1.4,
    rotationSpeed: 0.35,
    ringSpeed: 0.8,
    particleSpeed: 1.2,
    displacement: 0,
    scale: 0.93,
    containmentPulse: 0.15,
    innerGlow: 0.55,
    bloomStrength: 0.45,
    label: 'thinking',
  },
  speaking: {
    color: [160 / 255, 200 / 255, 255 / 255],        // Bright white-blue
    coreColor: [80 / 255, 110 / 255, 160 / 255],
    intensity: 1.6,
    rotationSpeed: 0.2,
    ringSpeed: 0.5,
    particleSpeed: 0.8,
    displacement: 0.07,
    scale: 1.05,
    containmentPulse: 0.35,
    innerGlow: 0.55,
    bloomStrength: 0.45,
    label: 'speaking',
  },
  listening: {
    color: [50 / 255, 230 / 255, 180 / 255],         // Cyan-green
    coreColor: [20 / 255, 100 / 255, 80 / 255],
    intensity: 1.3,
    rotationSpeed: 0.08,
    ringSpeed: 0.18,
    particleSpeed: 0.35,
    displacement: 0.05,
    scale: 1.0,
    containmentPulse: 0.08,
    innerGlow: 0.65,
    bloomStrength: 0.5,
    label: 'listening',
  },
  alert: {
    color: [255 / 255, 60 / 255, 20 / 255],          // Hot orange-red
    coreColor: [140 / 255, 25 / 255, 5 / 255],
    intensity: 2.2,
    rotationSpeed: 0.6,
    ringSpeed: 1.8,
    particleSpeed: 2.5,
    displacement: 0.3,
    scale: 1.12,
    containmentPulse: 0.7,
    innerGlow: 0.9,
    bloomStrength: 0.75,
    label: 'alert',
  },
};

const LERP_KEYS = [
  'color', 'coreColor',
  'intensity', 'rotationSpeed', 'ringSpeed', 'particleSpeed',
  'displacement', 'scale', 'containmentPulse', 'innerGlow', 'bloomStrength',
];

export class StateManager {
  constructor() {
    this.currentState = 'idle';
    this.targetState = 'idle';
    this.transitionProgress = 1.0;
    this.transitionSpeed = 1.5;
    this.current = this._cloneConfig(STATE_CONFIGS.idle);
    this.flashIntensity = 0.0;
    // Track state changes for scan sweep
    this.justChanged = false;
    this.scanDirection = 1;
  }

  setState(stateName) {
    if (!STATE_CONFIGS[stateName]) return;
    if (stateName === this.targetState && this.transitionProgress >= 1.0) return;

    this.currentState = this.targetState;
    this.targetState = stateName;
    this.transitionProgress = 0.0;
    this._fromSnapshot = this._cloneConfig(this.current);
    this.justChanged = true;
    this.scanDirection *= -1;

    if (stateName === 'alert') this.flashIntensity = 1.0;
  }

  update(dt) {
    if (this.transitionProgress < 1.0) {
      this.transitionProgress = Math.min(1.0, this.transitionProgress + dt * this.transitionSpeed);
      const t = this._easeInOutCubic(this.transitionProgress);
      const from = this._fromSnapshot || STATE_CONFIGS[this.currentState];
      const to = STATE_CONFIGS[this.targetState];

      for (const key of LERP_KEYS) {
        if (Array.isArray(to[key])) {
          for (let i = 0; i < to[key].length; i++) {
            this.current[key][i] = from[key][i] + (to[key][i] - from[key][i]) * t;
          }
        } else {
          this.current[key] = from[key] + (to[key] - from[key]) * t;
        }
      }
      this.current.label = to.label;
    }

    if (this.flashIntensity > 0) {
      this.flashIntensity = Math.max(0, this.flashIntensity - dt * 3.0);
    }
  }

  getStateNames() {
    return Object.keys(STATE_CONFIGS);
  }

  _easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  _cloneConfig(config) {
    const clone = {};
    for (const key of LERP_KEYS) {
      clone[key] = Array.isArray(config[key]) ? [...config[key]] : config[key];
    }
    clone.label = config.label;
    return clone;
  }
}

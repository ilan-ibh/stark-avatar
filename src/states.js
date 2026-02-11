/**
 * State machine for the Stark avatar.
 * Manages state definitions, transitions, and smooth lerping between states.
 */

// State color definitions [r, g, b] normalized to 0-1
const STATE_CONFIGS = {
  idle: {
    color: [38 / 255, 128 / 255, 255 / 255],
    coreColor: [12 / 255, 40 / 255, 120 / 255],
    noiseSpeed: 0.35,
    noiseAmplitude: 0.055,
    breathScale: 0.018,
    bloomStrength: 0.7,
    pulseStrength: 0.008,
    particleSpeed: 0.5,
    particleSpread: 0.85,
    rotationSpeed: 0.15,
    label: 'idle',
  },
  thinking: {
    color: [102 / 255, 51 / 255, 255 / 255],
    coreColor: [35 / 255, 10 / 255, 120 / 255],
    noiseSpeed: 0.5,
    noiseAmplitude: 0.09,
    breathScale: 0.028,
    bloomStrength: 0.9,
    pulseStrength: 0.018,
    particleSpeed: 0.9,
    particleSpread: 0.65,
    rotationSpeed: 0.28,
    label: 'thinking',
  },
  speaking: {
    color: [0 / 255, 230 / 255, 153 / 255],
    coreColor: [0 / 255, 70 / 255, 50 / 255],
    noiseSpeed: 0.3,
    noiseAmplitude: 0.1,
    breathScale: 0.02,
    bloomStrength: 1.0,
    pulseStrength: 0.008,
    particleSpeed: 1.0,
    particleSpread: 1.2,
    rotationSpeed: 0.18,
    label: 'speaking',
  },
  listening: {
    color: [0 / 255, 200 / 255, 220 / 255],
    coreColor: [0 / 255, 55 / 255, 75 / 255],
    noiseSpeed: 0.22,
    noiseAmplitude: 0.035,
    breathScale: 0.015,
    bloomStrength: 0.7,
    pulseStrength: 0.005,
    particleSpeed: 0.4,
    particleSpread: 0.9,
    rotationSpeed: 0.12,
    label: 'listening',
  },
  alert: {
    color: [255 / 255, 77 / 255, 26 / 255],
    coreColor: [120 / 255, 20 / 255, 3 / 255],
    noiseSpeed: 0.75,
    noiseAmplitude: 0.13,
    breathScale: 0.035,
    bloomStrength: 1.3,
    pulseStrength: 0.045,
    particleSpeed: 1.6,
    particleSpread: 1.5,
    rotationSpeed: 0.38,
    label: 'alert',
  },
};

// Numeric keys that we lerp between states
const LERP_KEYS = [
  'color',
  'coreColor',
  'noiseSpeed',
  'noiseAmplitude',
  'breathScale',
  'bloomStrength',
  'pulseStrength',
  'particleSpeed',
  'particleSpread',
  'rotationSpeed',
];

export class StateManager {
  constructor() {
    this.currentState = 'idle';
    this.targetState = 'idle';
    this.transitionProgress = 1.0; // 1.0 = fully at target
    this.transitionSpeed = 1.5; // ~0.67s full transition

    // Current interpolated values
    this.current = this._cloneConfig(STATE_CONFIGS.idle);

    // Flash effect
    this.flashIntensity = 0.0;
  }

  /**
   * Transition to a new state.
   */
  setState(stateName) {
    if (!STATE_CONFIGS[stateName]) return;
    if (stateName === this.targetState && this.transitionProgress >= 1.0) return;

    this.currentState = this.targetState;
    this.targetState = stateName;
    this.transitionProgress = 0.0;

    // Snapshot current interpolated values as the "from" state
    this._fromSnapshot = this._cloneConfig(this.current);

    // Trigger flash on alert
    if (stateName === 'alert') {
      this.flashIntensity = 1.0;
    }
  }

  /**
   * Update the interpolation. Call every frame with delta time in seconds.
   */
  update(dt) {
    // Advance transition
    if (this.transitionProgress < 1.0) {
      this.transitionProgress = Math.min(1.0, this.transitionProgress + dt * this.transitionSpeed);

      // Smooth ease (cubic ease-in-out)
      const t = this._easeInOutCubic(this.transitionProgress);
      const from = this._fromSnapshot || STATE_CONFIGS[this.currentState];
      const to = STATE_CONFIGS[this.targetState];

      for (const key of LERP_KEYS) {
        if (Array.isArray(to[key])) {
          // Lerp array (color)
          for (let i = 0; i < to[key].length; i++) {
            this.current[key][i] = from[key][i] + (to[key][i] - from[key][i]) * t;
          }
        } else {
          // Lerp scalar
          this.current[key] = from[key] + (to[key] - from[key]) * t;
        }
      }

      this.current.label = to.label;
    }

    // Decay flash
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
      if (Array.isArray(config[key])) {
        clone[key] = [...config[key]];
      } else {
        clone[key] = config[key];
      }
    }
    clone.label = config.label;
    return clone;
  }
}

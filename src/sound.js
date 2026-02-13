/**
 * Sound design for Stark Avatar.
 * Uses Web Audio API oscillators — no audio files needed.
 *
 * - Idle hum: very low sine wave, barely audible
 * - State transition chime: brief crystalline tone with harmonics
 * - Speaking bass pulse: sub-bass oscillator following audioBands.bass
 *
 * Initializes on first user interaction (browser autoplay policy).
 */

// State → chime pitch mapping (Hz)
const STATE_PITCHES = {
  idle: 440,
  thinking: 520,
  speaking: 660,
  listening: 580,
  alert: 350,
};

export class SoundManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.initialized = false;

    // Idle hum
    this._humOsc = null;
    this._humGain = null;
    this._humTarget = 0;

    // Speaking bass pulse
    this._bassOsc = null;
    this._bassGain = null;

    // State tracking
    this._currentState = 'idle';
    this._muted = false;
  }

  /** Call on first user interaction (Space press). */
  init() {
    if (this.initialized) return;

    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1.0;
      this.masterGain.connect(this.ctx.destination);

      // ── Idle hum: 60Hz sine, very quiet ──
      this._humOsc = this.ctx.createOscillator();
      this._humOsc.type = 'sine';
      this._humOsc.frequency.value = 60;
      this._humGain = this.ctx.createGain();
      this._humGain.gain.value = 0;
      this._humOsc.connect(this._humGain);
      this._humGain.connect(this.masterGain);
      this._humOsc.start();

      // ── Speaking bass pulse: 40Hz sine, gain follows audio ──
      this._bassOsc = this.ctx.createOscillator();
      this._bassOsc.type = 'sine';
      this._bassOsc.frequency.value = 40;
      this._bassGain = this.ctx.createGain();
      this._bassGain.gain.value = 0;
      this._bassOsc.connect(this._bassGain);
      this._bassGain.connect(this.masterGain);
      this._bassOsc.start();

      this.initialized = true;
    } catch {
      // Web Audio not available — fail silently
    }
  }

  /**
   * Call every frame with the current state label and audio bands.
   */
  update(stateLabel, audioBands) {
    if (!this.initialized || !this.ctx || this._muted) return;

    // Resume context if suspended (browser policy)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    // ── State change → play chime ──
    if (stateLabel !== this._currentState) {
      this._playChime(stateLabel);
      this._currentState = stateLabel;
    }

    // ── Idle hum: fade in during idle/listening, fade out otherwise ──
    const isQuiet = stateLabel === 'idle' || stateLabel === 'listening';
    this._humTarget = isQuiet ? 0.02 : 0.005;
    const humCurrent = this._humGain.gain.value;
    this._humGain.gain.value = humCurrent + (this._humTarget - humCurrent) * 0.03;

    // Slightly shift hum frequency with state for subtle variety
    const humFreqTarget = stateLabel === 'thinking' ? 70 : stateLabel === 'alert' ? 50 : 60;
    this._humOsc.frequency.value += (humFreqTarget - this._humOsc.frequency.value) * 0.02;

    // ── Speaking bass pulse: gain follows audioBands.bass ──
    const bassTarget = stateLabel === 'speaking'
      ? (audioBands?.bass || 0) * 0.06
      : 0;
    const bassCurrent = this._bassGain.gain.value;
    this._bassGain.gain.value = bassCurrent + (bassTarget - bassCurrent) * 0.15;
  }

  /** Play a brief crystalline chime on state transitions. */
  _playChime(state) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const pitch = STATE_PITCHES[state] || 440;

    // Two harmonics for crystalline quality
    for (const mult of [1.0, 1.5]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = pitch * mult;

      const gain = this.ctx.createGain();
      const volume = mult === 1.0 ? 0.04 : 0.015; // fundamental louder
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  }

  /** Toggle mute. */
  toggleMute() {
    this._muted = !this._muted;
    if (this.masterGain) {
      this.masterGain.gain.value = this._muted ? 0 : 1.0;
    }
    return this._muted;
  }
}

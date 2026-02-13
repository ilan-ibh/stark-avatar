import { Conversation } from '@elevenlabs/client';

/**
 * Bridges ElevenLabs Conversational AI with the orb visualization.
 *
 * - Manages agent conversation lifecycle (connect / disconnect)
 * - Extracts real-time FFT frequency bands from agent output + mic input
 * - Provides smoothed bass / mid / treble values for the shader each frame
 * - Offers a simulated-audio mode for offline demos
 */
export class AudioManager {
  constructor() {
    /** @type {Conversation | null} */
    this.conversation = null;
    this.isActive = false;
    this.isConnecting = false;

    // Smoothed audio levels (0–1)
    this.level = 0.0;
    this.bass = 0.0;
    this.mid = 0.0;
    this.treble = 0.0;

    // Current agent mode: 'speaking' | 'listening' | null
    this.agentMode = null;

    // Callbacks (set by consumer)
    this.onModeChange = null;
    this.onStatusChange = null;
    this.onMessage = null;
    this.onError = null;

    // ── Private ──
    this._rawLevel = 0.0;
    this._rawBass = 0.0;
    this._rawMid = 0.0;
    this._rawTreble = 0.0;
    this._simulated = false;
    this._simTime = 0;
  }

  // ─── Public API ──────────────────────────────────────────

  /** Start a conversation with the ElevenLabs agent. */
  async startConversation() {
    if (this.isActive || this.isConnecting) return;
    this.isConnecting = true;

    try {
      const resp = await fetch('/api/signed-url');
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Connection request failed (${resp.status}): ${body}`);
      }
      const { signed_url } = await resp.json();

      this.conversation = await Conversation.startSession({
        signedUrl: signed_url,
        connectionType: 'websocket',

        onConnect: () => {
          this.isActive = true;
          this.isConnecting = false;
          this._simulated = false;
          this.onStatusChange?.('connected');
        },

        onDisconnect: () => {
          this.isActive = false;
          this.agentMode = null;
          this.onStatusChange?.('disconnected');
        },

        onModeChange: (data) => {
          const mode = data?.mode || data;
          this.agentMode = mode;
          this.onModeChange?.(mode);
        },

        onMessage: (message) => {
          this.onMessage?.(message);
        },

        onError: (error) => {
          console.error('[stark] agent error:', error);
          this.onError?.(error);
        },
      });
    } catch (err) {
      this.isConnecting = false;
      throw err;
    }
  }

  /** End the current conversation. */
  async stopConversation() {
    if (this.conversation) {
      await this.conversation.endSession();
      this.conversation = null;
    }
    this.isActive = false;
    this.isConnecting = false;
    this.agentMode = null;
    this._simulated = false;
  }

  /**
   * Enable or disable simulated speech audio (for offline demos).
   * When enabled the orb reacts to synthetic syllable patterns.
   */
  setSimulated(enabled) {
    this._simulated = enabled;
    if (!enabled) this._simTime = 0;
  }

  /** Whether simulated audio is currently active. */
  get simulated() {
    return this._simulated;
  }

  // ─── Per-Frame Update ────────────────────────────────────

  /** Call once per animation frame with the delta time in seconds. */
  update(dt) {
    if (this._simulated) {
      this._updateSimulated(dt);
    } else if (this.isActive && this.conversation) {
      this._updateFromConversation();
    }

    // Decay when nothing is driving audio
    if (!this.isActive && !this._simulated) {
      const decay = 0.93;
      this._rawBass *= decay;
      this._rawMid *= decay;
      this._rawTreble *= decay;
      this._rawLevel *= decay;
    }

    // Smooth all channels (different rates per band for character)
    this.bass += (this._rawBass - this.bass) * 0.14;
    this.mid += (this._rawMid - this.mid) * 0.20;
    this.treble += (this._rawTreble - this.treble) * 0.28;
    this.level += (this._rawLevel - this.level) * 0.16;
  }

  // ─── Private Helpers ─────────────────────────────────────

  /** Synthetic speech-like audio for design validation. */
  _updateSimulated(dt) {
    this._simTime += dt;
    const t = this._simTime;

    const syllable = Math.max(0, Math.sin(t * 9.0)) * Math.max(0, Math.sin(t * 3.1));
    const breath = Math.max(0, Math.sin(t * 1.1)) * 0.5 + 0.5;
    const emphasis = Math.max(0, Math.sin(t * 0.7)) * 0.3 + 0.7;

    this._rawBass = clamp01(syllable * breath * emphasis * 0.85 + Math.sin(t * 2.0) * 0.1 + 0.08);
    this._rawMid = clamp01(syllable * breath * 0.7 + Math.abs(Math.sin(t * 7.3)) * 0.15);
    this._rawTreble = clamp01(syllable ** 2 * 0.5 + Math.abs(Math.sin(t * 13.7)) * 0.1 * syllable);
    this._rawLevel = this._rawBass * 0.5 + this._rawMid * 0.35 + this._rawTreble * 0.15;
  }

  /** Pull real FFT data from the ElevenLabs conversation. */
  _updateFromConversation() {
    try {
      const data =
        this.agentMode === 'speaking'
          ? this.conversation.getOutputByteFrequencyData()
          : this.agentMode === 'listening'
            ? this.conversation.getInputByteFrequencyData()
            : null;

      if (!data || data.length === 0) return;

      const bands = extractBands(data);

      if (this.agentMode === 'listening') {
        // Mic input drives the orb — scale up so user's voice is clearly visible
        this._rawBass = bands.bass * 0.85;
        this._rawMid = bands.mid * 0.8;
        this._rawTreble = bands.treble * 0.6;
        this._rawLevel = bands.level * 0.8;
      } else {
        this._rawBass = bands.bass;
        this._rawMid = bands.mid;
        this._rawTreble = bands.treble;
        this._rawLevel = bands.level;
      }
    } catch {
      // FFT methods may be unavailable during mode transitions
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Split a Uint8Array of FFT bin data into bass / mid / treble RMS values.
 */
function extractBands(data) {
  const len = data.length;
  const bassEnd = Math.floor(len * 0.08);
  const midEnd = Math.floor(len * 0.35);
  const trebleEnd = Math.floor(len * 0.7);

  let bassSum = 0;
  let midSum = 0;
  let trebleSum = 0;

  for (let i = 0; i < bassEnd; i++) { const v = data[i] / 255; bassSum += v * v; }
  for (let i = bassEnd; i < midEnd; i++) { const v = data[i] / 255; midSum += v * v; }
  for (let i = midEnd; i < trebleEnd; i++) { const v = data[i] / 255; trebleSum += v * v; }

  const bass = Math.sqrt(bassSum / Math.max(bassEnd, 1));
  const mid = Math.sqrt(midSum / Math.max(midEnd - bassEnd, 1));
  const treble = Math.sqrt(trebleSum / Math.max(trebleEnd - midEnd, 1));
  const level = bass * 0.5 + mid * 0.35 + treble * 0.15;

  return { bass, mid, treble, level };
}

import { Conversation } from '@elevenlabs/client';

/**
 * AudioManager — bridges ElevenLabs Conversational AI with the orb visualization.
 * 
 * Handles:
 * - Starting/stopping ElevenLabs agent conversations
 * - Extracting real-time FFT data from agent output audio + mic input audio
 * - Translating agent mode changes into orb state transitions
 * - Providing smoothed audio bands (bass/mid/treble) for the shader
 */
export class AudioManager {
  constructor() {
    /** @type {import('@elevenlabs/client').Conversation | null} */
    this.conversation = null;
    this.isActive = false;
    this.isConnecting = false;

    // Smoothed audio levels (0-1)
    this.level = 0.0;
    this.bass = 0.0;
    this.mid = 0.0;
    this.treble = 0.0;

    // Raw values before smoothing
    this._rawLevel = 0.0;
    this._rawBass = 0.0;
    this._rawMid = 0.0;
    this._rawTreble = 0.0;

    // Current agent mode: 'speaking' | 'listening' | null
    this.agentMode = null;

    // Callbacks set by main.js
    this.onModeChange = null;
    this.onStatusChange = null;
    this.onMessage = null;
    this.onError = null;

    // Fallback simulation
    this._simulated = false;
    this._simTime = 0;
  }

  /**
   * Start a conversation with the ElevenLabs agent.
   */
  async startConversation() {
    if (this.isActive || this.isConnecting) return;
    this.isConnecting = true;

    try {
      // Get signed URL from our serverless API
      const resp = await fetch('/api/signed-url');
      if (!resp.ok) throw new Error(`Signed URL failed: ${resp.status}`);
      const { signed_url } = await resp.json();

      this.conversation = await Conversation.startSession({
        signedUrl: signed_url,
        connectionType: 'websocket',

        onConnect: () => {
          console.log('[STARK] ElevenLabs agent connected');
          this.isActive = true;
          this.isConnecting = false;
          this._simulated = false;
          if (this.onStatusChange) this.onStatusChange('connected');
        },

        onDisconnect: () => {
          console.log('[STARK] ElevenLabs agent disconnected');
          this.isActive = false;
          this.agentMode = null;
          if (this.onStatusChange) this.onStatusChange('disconnected');
        },

        onModeChange: ({ mode }) => {
          // mode is 'speaking' or 'listening'
          this.agentMode = mode;
          console.log(`[STARK] Agent mode: ${mode}`);
          if (this.onModeChange) this.onModeChange(mode);
        },

        onMessage: (message) => {
          if (this.onMessage) this.onMessage(message);
        },

        onError: (error) => {
          console.error('[STARK] Agent error:', error);
          if (this.onError) this.onError(error);
        },
      });

    } catch (err) {
      console.error('[STARK] Failed to start conversation:', err);
      this.isConnecting = false;
      // Rethrow so caller can handle
      throw err;
    }
  }

  /**
   * End the current conversation.
   */
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
   * Extract frequency bands from a Uint8Array of FFT data.
   */
  _extractBands(data) {
    if (!data || data.length === 0) return { bass: 0, mid: 0, treble: 0, level: 0 };

    const len = data.length;
    let bassSum = 0, midSum = 0, trebleSum = 0;
    const bassEnd = Math.floor(len * 0.08);
    const midEnd = Math.floor(len * 0.35);
    const trebleEnd = Math.floor(len * 0.7);

    for (let i = 0; i < bassEnd; i++) {
      const v = data[i] / 255;
      bassSum += v * v;
    }
    for (let i = bassEnd; i < midEnd; i++) {
      const v = data[i] / 255;
      midSum += v * v;
    }
    for (let i = midEnd; i < trebleEnd; i++) {
      const v = data[i] / 255;
      trebleSum += v * v;
    }

    const bass = Math.sqrt(bassSum / Math.max(bassEnd, 1));
    const mid = Math.sqrt(midSum / Math.max(midEnd - bassEnd, 1));
    const treble = Math.sqrt(trebleSum / Math.max(trebleEnd - midEnd, 1));
    const level = bass * 0.5 + mid * 0.35 + treble * 0.15;

    return { bass, mid, treble, level };
  }

  /**
   * Update per frame. Extracts real-time audio data from the ElevenLabs conversation.
   */
  update(dt) {
    // Handle simulated audio (for offline/demo speaking state)
    if (this._simulated) {
      this._simTime += dt;
      const t = this._simTime;
      const syllable = Math.max(0, Math.sin(t * 9.0)) * Math.max(0, Math.sin(t * 3.1));
      const breath = Math.max(0, Math.sin(t * 1.1)) * 0.5 + 0.5;
      const emphasis = Math.max(0, Math.sin(t * 0.7)) * 0.3 + 0.7;

      this._rawBass = Math.max(0, Math.min(1, syllable * breath * emphasis * 0.85 + Math.sin(t * 2.0) * 0.1 + 0.08));
      this._rawMid = Math.max(0, Math.min(1, syllable * breath * 0.7 + Math.abs(Math.sin(t * 7.3)) * 0.15));
      this._rawTreble = Math.max(0, Math.min(1, Math.pow(syllable, 2.0) * 0.5 + Math.abs(Math.sin(t * 13.7)) * 0.1 * syllable));
      this._rawLevel = this._rawBass * 0.5 + this._rawMid * 0.35 + this._rawTreble * 0.15;
    }
    // Extract real audio data from ElevenLabs conversation
    else if (this.isActive && this.conversation) {
      try {
        if (this.agentMode === 'speaking') {
          // Use the agent's output audio FFT
          const outputData = this.conversation.getOutputByteFrequencyData();
          if (outputData && outputData.length > 0) {
            const bands = this._extractBands(outputData);
            this._rawBass = bands.bass;
            this._rawMid = bands.mid;
            this._rawTreble = bands.treble;
            this._rawLevel = bands.level;
          }
        } else if (this.agentMode === 'listening') {
          // Use the mic input audio FFT
          const inputData = this.conversation.getInputByteFrequencyData();
          if (inputData && inputData.length > 0) {
            const bands = this._extractBands(inputData);
            // Listening is subtler — scale down
            this._rawBass = bands.bass * 0.4;
            this._rawMid = bands.mid * 0.4;
            this._rawTreble = bands.treble * 0.3;
            this._rawLevel = bands.level * 0.4;
          }
        }
      } catch (e) {
        // getOutputByteFrequencyData may not be available in all modes
      }
    }

    // Decay when inactive
    if (!this.isActive && !this._simulated) {
      const decay = 0.93;
      this._rawBass *= decay;
      this._rawMid *= decay;
      this._rawTreble *= decay;
      this._rawLevel *= decay;
    }

    // Smooth all channels
    this.bass += (this._rawBass - this.bass) * 0.14;
    this.mid += (this._rawMid - this.mid) * 0.20;
    this.treble += (this._rawTreble - this.treble) * 0.28;
    this.level += (this._rawLevel - this.level) * 0.16;
  }
}

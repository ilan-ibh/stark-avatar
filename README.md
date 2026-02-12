# Stark Avatar

A fullscreen, always-on visual representation of an AI agent. An abstract audio-reactive orb that reflects the agent's current state in real-time — connected to [ElevenLabs](https://elevenlabs.io) Conversational AI for live voice interaction.

Not a chatbot UI. A presence.

![Three.js](https://img.shields.io/badge/Three.js-r172-black?logo=threedotjs)
![ElevenLabs](https://img.shields.io/badge/ElevenLabs-Conversational_AI-5D5FEF)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Vercel](https://img.shields.io/badge/Deployed_on-Vercel-000?logo=vercel)

---

## What It Looks Like

A high-poly icosahedron with organic noise displacement, fresnel edge glow, energy veins flowing across the surface, orbiting particles, and cinematic bloom — floating in pure black void. The surface ripples and pulses in sync with the AI agent's voice.

Press Space, start talking. The orb listens, thinks, and speaks back.

## Features

**The Orb**
- 64-subdivision icosahedron with 4-octave FBM noise displacement
- Custom GLSL vertex + fragment shaders
- Multi-layer fresnel (sharp rim, medium edge, broad gradient)
- Energy veins — noise-based bright lines flowing across the surface
- Spectral edge color shift for holographic quality
- Inner core glow mesh + atmospheric halo mesh

**Audio Reactivity**
- Real-time FFT analysis split into bass / mid / treble bands
- Bass drives large slow waves sweeping pole-to-pole
- Mid drives spiraling diagonal waves
- Treble drives fine rapid surface ripples
- Wave peaks glow brighter in the fragment shader

**5 Agent States**
| Key | State | Color | Behavior |
|-----|-------|-------|----------|
| `1` | Idle | Blue | Organic movement, gentle pulse, calm energy |
| `2` | Thinking | Purple | Faster noise, throb effect, tight particles |
| `3` | Speaking | Green | Audio-synced surface waves, expanded particles |
| `4` | Listening | Cyan | Subtle mic reactivity, receptive |
| `5` | Alert | Orange-red | Aggressive noise, flash on entry, scattered particles |

All transitions lerp smoothly with cubic ease-in-out over ~0.7s.

**Voice Integration**
- [ElevenLabs Conversational AI](https://elevenlabs.io/docs/eleven-agents/overview) SDK
- Press `Space` to connect — agent listens, responds with voice
- `onModeChange` drives orb state transitions automatically
- `getOutputByteFrequencyData()` feeds real-time FFT into the shader
- Serverless API route generates signed URLs (API key never touches the browser)

**Post-Processing**
- Unreal Bloom pass with state-driven strength
- ACES filmic tone mapping
- Two-layer particle system (orbital + atmospheric dust)

## Tech Stack

- **Three.js** (r172) — 3D rendering, post-processing
- **GLSL** — Custom vertex + fragment shaders
- **@elevenlabs/client** — Conversational AI SDK
- **Vite** — Build tool
- **Vercel** — Hosting + serverless API routes

## Project Structure

```
stark-avatar/
├── index.html              # Fullscreen canvas + status UI
├── api/
│   └── signed-url.js       # Vercel serverless — ElevenLabs signed URL
├── src/
│   ├── main.js             # Scene, camera, bloom, animation loop, controls
│   ├── orb.js              # Orb mesh + inner core + atmosphere halo
│   ├── particles.js        # Two-layer particle system
│   ├── states.js           # State machine with lerped transitions
│   ├── audio.js            # ElevenLabs SDK + FFT band extraction
│   └── shaders/
│       ├── orb.vert        # Vertex: FBM noise, audio waves, breathing
│       └── orb.frag        # Fragment: fresnel, veins, spectral shift
├── vercel.json
├── vite.config.js
└── package.json
```

## Setup

```bash
# Install
npm install

# Dev server
npm run dev

# Build
npm run build
```

### Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_AGENT_ID=your_agent_id
```

For production, set these in your Vercel project under Settings > Environment Variables.

## Controls

| Key | Action |
|-----|--------|
| `Space` | Connect / disconnect ElevenLabs agent |
| `1` - `5` | Manual state switch (disabled during agent conversation) |
| `D` | Demo mode — auto-cycle all states |
| `F` | Fullscreen |
| `Scroll` | Zoom in / out |
| `Esc` | Toggle control hints |

## Extending

The architecture is designed for plugging in different AI backends. The orb doesn't care what generates the text — it reacts to audio and mode changes from the ElevenLabs SDK. Swap the LLM behind ElevenLabs (via their [Custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm) feature) and the orb just works.

Planned:
- Custom LLM backend via ElevenLabs [Custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm) (use any model as the brain)
- Audio waveform ring around the orb during speech
- Agent response text floating near the orb
- Notification particle bursts
- Multiple visualization modes
- Screensaver mode for extended idle

## License

MIT

# Stark Avatar × OpenClaw Integration

Use Stark Avatar as a voice interface for [OpenClaw](https://github.com/nichochar/openclaw) — or any OpenAI-compatible agent.

## Architecture

```
┌─────────────┐       ┌──────────────────┐       ┌───────────────┐       ┌──────────────┐
│  Three.js   │ ←───→ │   ElevenLabs     │ ←───→ │  Voice Proxy  │ ←───→ │   OpenClaw   │
│  Orb (Web)  │ audio │ Conversational AI│  HTTP  │  (server.js)  │  HTTP  │   Gateway    │
└─────────────┘       └──────────────────┘       └───────────────┘       └──────────────┘
    Browser              ElevenLabs Cloud           Your Machine            Your Machine
```

1. **Orb** — The Three.js frontend. Captures mic audio, plays back speech, visualizes agent state.
2. **ElevenLabs** — Handles speech-to-text and text-to-speech. Sends transcribed text to a Custom LLM endpoint.
3. **Voice Proxy** (`proxy/server.js`) — Receives requests from ElevenLabs, forwards them to OpenClaw (or any backend). Handles debouncing, dedup, and keep-alive for long tool calls.
4. **OpenClaw Gateway** — Your agent. Processes the message, runs tools, returns a streaming response.

## Three Modes

| Mode | What You Need | Description |
|------|--------------|-------------|
| **Standalone** | Orb + ElevenLabs | Visual orb with voice — no proxy or OpenClaw needed. ElevenLabs handles the LLM. |
| **With OpenClaw** | Orb + ElevenLabs + Proxy + OpenClaw | Full stack. Your OpenClaw agent is the brain behind the voice. |
| **With any agent** | Orb + ElevenLabs + Proxy + any endpoint | Point the proxy at any OpenAI-compatible `/v1/chat/completions` endpoint. |

---

## Setup: OpenClaw Mode

### 1. Configure the Voice Agent in OpenClaw

Add a voice agent to your `openclaw.json`. This is a separate agent entry — it can have its own workspace, model, and system prompt optimized for voice interactions.

See [`openclaw.example.json`](./openclaw.example.json) for a minimal example.

Key points:
- The agent `id` must match `OPENCLAW_AGENT` (default: `voice`)
- The proxy sends requests with `model: "openclaw:<agent-id>"`
- Give the voice agent its own workspace if you want isolated context

### 2. Configure Proxy Environment

Copy the example env file and edit it:

```bash
cp openclaw/.env.example proxy/.env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8013` | Port the proxy listens on |
| `OPENCLAW_URL` | `http://127.0.0.1:18789/v1/chat/completions` | OpenClaw gateway endpoint |
| `OPENCLAW_TOKEN` | — | Your OpenClaw gateway auth token |
| `OPENCLAW_AGENT` | `voice` | Agent ID to route requests to |

### 3. Start the Proxy

```bash
cd proxy
npm install
node server.js
```

The proxy starts on port 8013 (or whatever `PORT` is set to).

Verify it's running:

```bash
curl http://127.0.0.1:8013/health
# {"ok":true,"uptime":...}
```

### 4. Expose the Proxy Publicly

ElevenLabs needs to reach your proxy over HTTPS. Options:

**Cloudflare Tunnel** (recommended — free, stable):
```bash
cloudflared tunnel --url http://127.0.0.1:8013
# Outputs: https://random-words.trycloudflare.com
```

**ngrok:**
```bash
ngrok http 8013
```

**Tailscale Funnel:**
```bash
tailscale funnel 8013
```

Note the HTTPS URL — you'll need it for the next step.

### 5. Configure ElevenLabs Custom LLM

In the [ElevenLabs dashboard](https://elevenlabs.io/app/conversational-ai):

1. Open your Conversational AI agent settings
2. Go to **LLM** → **Custom LLM**
3. Set the **Server URL** to your proxy's public URL:
   ```
   https://your-tunnel-url.trycloudflare.com/v1/chat/completions
   ```
4. Save and test

ElevenLabs will now send transcribed speech to your proxy, which forwards it to OpenClaw.

### 6. Start OpenClaw

Make sure the OpenClaw gateway is running:

```bash
openclaw gateway start
```

The proxy connects to it at the configured `OPENCLAW_URL`.

---

## Setup: Any OpenAI-Compatible Backend

The proxy works with any endpoint that accepts OpenAI-format `/v1/chat/completions` requests with streaming.

Set `OPENCLAW_URL` to your endpoint:

```bash
# OpenAI directly
OPENCLAW_URL=https://api.openai.com/v1/chat/completions
OPENCLAW_TOKEN=sk-...

# Ollama
OPENCLAW_URL=http://127.0.0.1:11434/v1/chat/completions

# Any OpenAI-compatible server
OPENCLAW_URL=https://your-server.com/v1/chat/completions
OPENCLAW_TOKEN=your-api-key
```

The `OPENCLAW_AGENT` variable sets the model name sent as `openclaw:<agent>`. If your backend ignores this field or you override it, this doesn't matter.

---

## Setup: Standalone Mode

The orb works without the proxy or OpenClaw at all. ElevenLabs provides its own built-in LLM. Just:

1. Deploy the orb frontend (Vercel, etc.)
2. Set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`
3. Don't configure a Custom LLM — ElevenLabs uses its default model

The orb renders and responds to voice with no external backend.

---

## Proxy Details

### Debouncing

ElevenLabs sometimes sends multiple rapid requests as speech is being transcribed. The proxy debounces with a 1.5s window, keeping the longest message (which is usually the most complete transcription).

### Dedup

If the same message arrives within 15s (ElevenLabs retry), the proxy replays the cached response instead of hitting the backend again.

### Keep-Alive

When OpenClaw runs tool calls that take more than 10s, the proxy sends filler phrases ("Still working on it...") to prevent ElevenLabs from timing out at its 15s cascade limit.

### Voice Hint

The proxy appends a hint to each user message asking the agent to keep responses concise (3–4 sentences). This is hardcoded in `server.js` — modify it there if needed.

---

## Troubleshooting

**Proxy returns "Sorry, having trouble connecting"**
- Check that OpenClaw gateway is running (`openclaw gateway status`)
- Verify `OPENCLAW_URL` is correct
- Check that the agent ID exists in your `openclaw.json`

**ElevenLabs times out**
- Make sure your tunnel is active and the URL is correct
- Check proxy logs: `tail -f /tmp/stark-proxy.log`
- The proxy's keep-alive should handle most timeout issues

**No audio response from the orb**
- Verify ElevenLabs agent is configured with a Custom LLM pointing at the proxy
- Check browser console for WebSocket errors
- Make sure `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` are set

---

## Files

| File | Description |
|------|-------------|
| `openclaw/README.md` | This guide |
| `openclaw/openclaw.example.json` | Example OpenClaw agent config |
| `openclaw/.env.example` | Proxy environment variables |
| `proxy/server.js` | The voice proxy (don't need to modify) |

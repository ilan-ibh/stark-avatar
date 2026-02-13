# Proxy Migration — Move Backend Into This Repo

## What's Happening
The voice proxy and chrome logger currently live on a separate machine (iMac running OpenClaw). We're moving them into this repo so everything is in one place and one agent can debug the full pipeline.

## Files to Add

Create a `proxy/` directory in the repo root with these files:

### 1. `proxy/server.js` — Voice Proxy (port 8013)

This is the bridge between ElevenLabs and the OpenClaw AI backend. ElevenLabs sends chat completion requests here, the proxy forwards them to OpenClaw, and streams the response back.

**Current version: v7** — includes:
- Silence filter (`"..."` messages → empty response)
- In-flight dedup (same message retried → drop duplicate; different message → abort old)
- Buffer phrase (random "Hmm...", "Let me think..." sent immediately before LLM processes)
- Voice hint appended to user messages
- Conversation logging (`GET /conversations`)
- Response caching for dedup

**Full source code below.**

### 2. `proxy/chrome-logger.js` — Browser Event Logger (port 8014)

Receives events from the StarkChrome Chrome extension and writes them to markdown files on disk. Also stores page content summaries in a separate content directory.

**Full source code below.**

### 3. `proxy/package.json`

```json
{
  "name": "stark-voice-proxy",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "proxy": "node server.js",
    "logger": "node chrome-logger.js",
    "start": "node server.js & node chrome-logger.js"
  },
  "dependencies": {
    "express": "^5.0.0"
  }
}
```

### 4. `proxy/start-all.sh` — Service Launcher

Starts both servers + the Cloudflare named tunnel. Note: this runs on the iMac, not on Vercel.

**Important:** We now use a **named Cloudflare tunnel** (not quick tunnels). The tunnel config is at `~/.cloudflared/config.yml` on the iMac:

```yaml
tunnel: d217e593-278f-48e8-83c0-5b0a245ac0c0
credentials-file: /Users/starkai/.cloudflared/d217e593-278f-48e8-83c0-5b0a245ac0c0.json

ingress:
  - hostname: gateway.ilandev.com
    service: http://127.0.0.1:18789
  - hostname: logger.ilandev.com
    service: http://127.0.0.1:8014
  - hostname: proxy.ilandev.com
    service: http://127.0.0.1:8013
  - service: http_status:404
```

**Permanent URLs:**
- `https://gateway.ilandev.com` → OpenClaw Gateway (port 18789)
- `https://proxy.ilandev.com` → Voice Proxy (port 8013)
- `https://logger.ilandev.com` → Chrome Logger (port 8014)

## Environment Variables

The proxy uses these (with defaults for the iMac):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8013` | Voice proxy port |
| `OPENCLAW_URL` | `http://127.0.0.1:18789/v1/chat/completions` | OpenClaw gateway endpoint |
| `OPENCLAW_TOKEN` | `25b8d60afe0d8fa0141d833affca1b023d45d9f45d174e86` | Gateway auth token |
| `OPENCLAW_AGENT` | `main` | Agent ID for routing |
| `CHROME_LOGGER_PORT` | `8014` | Chrome logger port |

## Architecture

```
                                    ┌─────────────────────┐
                                    │  Vercel (Frontend)   │
                                    │  - Three.js orb      │
                                    │  - ElevenLabs SDK     │
                                    │  - api/signed-url.js  │
                                    └──────────┬────────────┘
                                               │
                                    WebSocket (ElevenLabs)
                                               │
                                    ┌──────────▼────────────┐
                                    │  ElevenLabs Cloud      │
                                    │  - STT (speech→text)   │
                                    │  - TTS (text→speech)   │
                                    │  - Turn management     │
                                    └──────────┬────────────┘
                                               │
                                   POST /v1/chat/completions
                                               │
                              ┌────────────────▼─────────────────┐
                              │  proxy.ilandev.com (Cloudflare)   │
                              └────────────────┬─────────────────┘
                                               │
                              ┌────────────────▼─────────────────┐
                              │  Voice Proxy (localhost:8013)     │
                              │  proxy/server.js                  │
                              │                                   │
                              │  1. Filter silence ("...")         │
                              │  2. Dedup speculative retries      │
                              │  3. Send buffer phrase immediately  │
                              │  4. Forward to OpenClaw            │
                              │  5. Stream response back           │
                              └────────────────┬─────────────────┘
                                               │
                              ┌────────────────▼─────────────────┐
                              │  OpenClaw Gateway (localhost:18789)│
                              │  - AI agent (Claude Opus/Sonnet)  │
                              │  - 33 skills/tools                │
                              │  - Memory, context, personality   │
                              └──────────────────────────────────┘
```

## Known Issues & Current State

### Issue: Tool calls cause long dead air
When the user asks something requiring tools (email, calendar, trading), OpenClaw runs tool calls that take 10-25 seconds. ElevenLabs has a 15-second cascade timeout. The buffer phrase fills the first 3-5 seconds, but tool calls can exceed the timeout.

**Possible fixes (not yet implemented):**
1. Send periodic "working on it" chunks during long tool calls (keep-alive)
2. Create a dedicated voice agent without tools — delegates tool tasks to main agent async
3. Detect tool-heavy queries and warn: "I'll check that and send it to your Telegram"

### Issue: Speculative turn (can't disable)
ElevenLabs `speculative_turn: true` is locked to `turn_v2`. The proxy handles this with:
- Same message retried → drop duplicate
- Different message (partial → complete) → abort old request

### Issue: `"..."` silence messages
ElevenLabs VAD sends empty transcripts during silence. Proxy returns a single space chunk to avoid ElevenLabs interpreting it as LLM failure.

## ElevenLabs Agent Config

Agent ID: `agent_6801kh5ysqrdf79s95rxcagkf5vw`
API Key: `sk_deb6cbf010036b242b0c1e4d1b16f44c3641ac4ff2d87610`

Key settings:
- Custom LLM URL: `https://proxy.ilandev.com/v1/`
- Model ID: `openclaw:main`
- Voice: `eXpIbVcVbLo8ZJQDlDnl` (eleven_v3_conversational)
- Turn eagerness: `eager`
- Speculative turn: `true` (locked)
- Cascade timeout: `15s` (max allowed)
- Max duration: `3600s`
- Silence end call: `-1` (disabled)
- Max tokens: `500`
- Interruptions: **removed from client_events**
- Expressive mode: `true`
- Optimize streaming latency: `2`

## Deployment Notes

- The proxy does NOT run on Vercel. It runs on the iMac alongside OpenClaw.
- After making changes to proxy files, tell the OpenClaw agent (Stark) to pull the latest and restart the proxy.
- The Vercel frontend and the iMac proxy communicate only through ElevenLabs (the frontend never calls the proxy directly).
- The chrome-logger is independent of the voice pipeline — it serves StarkChrome browser events.

## Full Source

The actual source files are already in this repo at:
- `proxy/server.js` (310 lines) — Voice proxy v7
- `proxy/chrome-logger.js` (276 lines) — Chrome event logger v2
- `proxy/package.json` — Dependencies (just express)

Read them directly. They are the source of truth.

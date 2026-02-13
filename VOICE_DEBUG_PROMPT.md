# StarkFace Voice Agent — Debug & Fix Prompt

## The Problem
The voice agent cuts off mid-sentence and returns to idle. It also stutters — sometimes playing two responses simultaneously. This needs to be fixed for a smooth, uninterrupted voice conversation.

## Architecture Overview

```
User speaks → ElevenLabs (STT/VAD) → WebSocket → sends chat completion request
    → Cloudflare Tunnel (proxy.ilandev.com)
    → Voice Proxy (localhost:8013) — Express server, SSE streaming passthrough
    → OpenClaw Gateway (localhost:18789) — AI agent brain
    → OpenRouter → Claude (Sonnet/Opus)
    → Response streams back through the entire chain
    → ElevenLabs (TTS) → User hears speech
```

There are TWO codebases involved:
1. **Frontend** (this repo) — Three.js orb + ElevenLabs SDK client (`src/audio.js`, `src/main.js`)
2. **Backend proxy** (NOT in this repo) — Express server that bridges ElevenLabs → OpenClaw

## The Issues (with evidence from logs)

### Issue 1: Speculative Turn Causes Duplicate Requests
ElevenLabs has `speculative_turn: true` (can't be disabled via API — locked to turn_v2). This means:
- User says: "Tell me what you can do"
- ElevenLabs fires request 1 with partial: "Tell me what"
- 1 second later fires request 2 with full: "Tell me what you can do"
- Both hit the proxy, both get different responses, TTS tries to play both = **stuttering**

Evidence from proxy logs:
```
[proxy] user: All right, start. So basically tell me what can you do.
[proxy] done: 501 chars, first_chunk=3458ms, total=7135ms
[proxy] user: All right, start. So basically tell me what can you do, but in a way that you will explain to my mom
[proxy] done: 952 chars, first_chunk=3771ms, total=10810ms
```

Also:
```
[proxy] user: What's-
[proxy] user: What's the problem?
[proxy] done: 41 chars, first_chunk=8035ms, total=9031ms
[proxy] done: 686 chars, first_chunk=5768ms, total=9659ms
```

### Issue 2: Silence ("...") Messages Flood the LLM
When the user is silent, ElevenLabs VAD sends `"..."` as the user message. The proxy forwards this to the LLM, which responds with things like "Still here? What's up?" — this wastes a turn and can cause the agent to go idle.

Evidence:
```
[proxy] user: ...
[proxy] done: 55 chars, first_chunk=3166ms, total=3613ms
[proxy] user: ...
[proxy] done: 73 chars, first_chunk=4782ms, total=5308ms
```

### Issue 3: Long Responses Cause TTS Timeout → Idle
Responses over ~800 chars (~60 seconds of speech) seem to cause ElevenLabs to disconnect/go idle. The LLM doesn't know it's in a voice call and writes essay-length responses with markdown formatting.

Evidence:
```
[proxy] done: 1365 chars, first_chunk=3334ms, total=13079ms  ← went idle after this
[proxy] done: 1201 chars, first_chunk=4017ms, total=13047ms  ← went idle after this
```

### Issue 4: Interruption Events
`client_events` includes `"interruption"` — when the second speculative request's response starts arriving while the first is still being spoken, ElevenLabs interprets it as an interruption and cuts the audio.

## Current ElevenLabs Agent Config
```json
{
  "turn": {
    "turn_timeout": 2.0,
    "silence_end_call_timeout": -1.0,
    "soft_timeout_config": { "timeout_seconds": -1.0 },
    "turn_eagerness": "normal",
    "speculative_turn": true,     // ← CAN'T DISABLE VIA API
    "turn_model": "turn_v2"
  },
  "tts": {
    "model_id": "eleven_v3_conversational",
    "voice_id": "eXpIbVcVbLo8ZJQDlDnl",
    "expressive_mode": true,
    "optimize_streaming_latency": 2,
    "stability": 0.5,
    "speed": 1.0,
    "similarity_boost": 0.8
  },
  "conversation": {
    "max_duration_seconds": 3600,
    "client_events": ["audio", "interruption", "agent_response", "user_transcript", "agent_response_correction", "agent_tool_response"]
  },
  "custom_llm": {
    "url": "https://proxy.ilandev.com/v1/",
    "model_id": "openclaw:main",
    "cascade_timeout_seconds": 15.0
  }
}
```

## Backend Proxy Code (server.js — NOT in this repo, runs on localhost:8013)
```javascript
/**
 * Stark Voice Proxy v3
 * Pure streaming passthrough: ElevenLabs → OpenClaw Gateway
 */
import express from "express";
import { createServer } from "http";

const PORT = process.env.PORT || 8013;
const OPENCLAW_URL = process.env.OPENCLAW_URL || "http://127.0.0.1:18789/v1/chat/completions";
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || "25b8d60afe0d8fa0141d833affca1b023d45d9f45d174e86";
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || "main";

const DEDUP_WINDOW_MS = 15000;
const recentRequests = new Map();

function getRequestHash(messages) {
  const tail = (messages || []).slice(-3);
  return tail.map((m) => `${m.role}:${(m.content || "").slice(0, 200)}`).join("|");
}

function getDedupedResponse(hash) {
  const cached = recentRequests.get(hash);
  if (cached && Date.now() - cached.timestamp < DEDUP_WINDOW_MS) return cached.response;
  return null;
}

function cacheResponse(hash, response) {
  recentRequests.set(hash, { response, timestamp: Date.now() });
  for (const [k, v] of recentRequests) {
    if (Date.now() - v.timestamp > DEDUP_WINDOW_MS * 2) recentRequests.delete(k);
  }
}

const conversations = new Map();
function getSessionId(body) { return body.user || "default"; }
function logMessage(sessionId, role, content) {
  if (!conversations.has(sessionId)) conversations.set(sessionId, { messages: [], startedAt: new Date() });
  conversations.get(sessionId).messages.push({ role, content, timestamp: new Date().toISOString() });
}

function sseChunk(id, content) {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/conversations", (_req, res) => { /* returns conversation logs */ });
app.delete("/conversations", (_req, res) => { conversations.clear(); res.json({ ok: true }); });

app.post(["/v1/chat/completions", "/v1/chat/completions/chat/completions"], async (req, res) => {
  const body = req.body;
  const sessionId = getSessionId(body);
  const lastUserMsg = [...(body.messages || [])].reverse().find((m) => m.role === "user");
  
  if (lastUserMsg) {
    logMessage(sessionId, "user", lastUserMsg.content);
    console.log(`[proxy] user: ${lastUserMsg.content.slice(0, 100)}`);
  }

  delete body.elevenlabs_extra_body;
  body.model = `openclaw:${OPENCLAW_AGENT}`;
  body.stream = true;

  // Dedup check
  const reqHash = getRequestHash(body.messages);
  const cached = getDedupedResponse(reqHash);
  if (cached) { /* return cached response */ return; }

  // Stream from OpenClaw
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const upstreamRes = await fetch(OPENCLAW_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENCLAW_TOKEN}`,
      "x-openclaw-agent-id": OPENCLAW_AGENT,
    },
    body: JSON.stringify(body),
  });

  // Pure streaming passthrough — chunks piped verbatim
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  // ... reads chunks, writes to res ...
});

const server = createServer(app);
server.listen(PORT);
```

## What Needs to Happen

### On the proxy side (server.js):
1. **Filter silence messages** — If user content is `"..."` or empty or < 2 chars, return empty `[DONE]` immediately. Don't forward to LLM.
2. **Handle speculative turn duplicates** — When a new request arrives while a previous one is still in-flight, abort the previous request (it was a partial transcript) and process only the new one (complete transcript). Use AbortController on the fetch call.
3. **Optionally** — Inject a voice-mode hint so the LLM keeps responses concise. But be careful: previous attempts to inject system messages caused issues. If done, append to the user message itself, not as a separate system message.

### On the frontend side (src/audio.js):
4. **Handle disconnects gracefully** — When `onDisconnect` fires, check if it was intentional (user pressed Space) vs unexpected. If unexpected, consider auto-reconnecting.
5. **Investigate the ElevenLabs SDK** — The `Conversation.startSession()` options may have additional config for handling interruptions, speculative turns, or turn management that could help.
6. **Consider disabling interruptions client-side** — If the SDK allows overriding `client_events` or interrupt behavior during session start.

### On ElevenLabs config (via API):
7. **`speculative_turn: true`** cannot be disabled via API (locked to turn_v2). Any fix must be proxy-side or client-side.
8. **`cascade_timeout_seconds: 15`** — Max allowed is 15s. LLM responses must start within 15s or ElevenLabs drops the call. Current TTFT is 3-5s so this is OK for now.
9. **Consider removing `"interruption"` from `client_events`** — This might prevent the self-interruption when competing responses arrive.

## Key Constraints
- The proxy runs on a separate machine (iMac) and is NOT in this repo
- The proxy is accessed via Cloudflare tunnel at `https://proxy.ilandev.com`
- ElevenLabs agent ID: `agent_6801kh5ysqrdf79s95rxcagkf5vw`
- ElevenLabs API key: `sk_deb6cbf010036b242b0c1e4d1b16f44c3641ac4ff2d87610`
- Changes to the proxy need to be communicated back to the iMac operator (Stark/OpenClaw)
- The proxy's primary job is bridging ElevenLabs ↔ OpenClaw. Keep it simple.

## Success Criteria
- Voice conversation lasts 5+ minutes without going idle unexpectedly
- No stuttering or overlapping speech
- Silence doesn't trigger LLM responses
- Responses feel natural and conversational (not robotic, not essay-length)

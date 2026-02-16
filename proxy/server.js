/**
 * Stark Voice Proxy v12
 *
 * Bridges ElevenLabs Conversational AI ↔ OpenClaw Gateway.
 * Pure streaming passthrough — no buffer injection.
 *
 * Request lifecycle:
 *
 *   1. SILENCE FILTER     → "..." or empty → return [DONE] immediately
 *   2. ABORT IN-FLIGHT    → cancel any pending fetch for this session
 *   3. DEBOUNCE (1.5s)    → wait for speculative turn to settle;
 *                            keeps the LONGEST message (handles corrections)
 *   4. DEDUP CHECK        → if we recently answered this exact message, replay
 *   5. FETCH → OPENCLAW   → SSE stream with keep-alive for tool calls
 *   6. STREAM THROUGH     → pipe LLM chunks verbatim to ElevenLabs
 *   7. DONE               → cache response, clean up, close stream
 *
 * The orb shows "thinking" state during the LLM processing gap.
 * Keep-alive phrases prevent the 15s cascade timeout on long tool calls.
 */

import express from "express";
import { createServer } from "http";

// ─── Config ────────────────────────────────────────────────

const PORT = process.env.PORT || 8013;
const OPENCLAW_URL = process.env.OPENCLAW_URL || "http://127.0.0.1:18789/v1/chat/completions";
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || "25b8d60afe0d8fa0141d833affca1b023d45d9f45d174e86";
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || "main";

const VOICE_HINT = " [Voice call — keep response under 3-4 sentences. Start with the answer directly.]";
const DEBOUNCE_MS = 1500;
const KEEPALIVE_INTERVAL_MS = 10000;
const DEDUP_WINDOW_MS = 15000;
const MAX_CONVERSATIONS = 50;

// ─── Keep-Alive Phrases (tool calls only) ──────────────────
// Used when OpenClaw runs tool calls that take >10s.
// Prevents ElevenLabs from hitting the 15s cascade timeout.

const KEEPALIVE_PHRASES = [
  "Still working on it... ",
  "Bear with me... ",
  "Almost there... ",
  "Just a bit longer... ",
  "Hang tight... ",
];

// ─── State Maps ────────────────────────────────────────────

const inFlight = new Map();       // sessionId → { controller, userText }
const pendingRequests = new Map(); // sessionId → { timer, resolve, reject, textLength }
const recentRequests = new Map();  // hash → { response, timestamp }
const conversations = new Map();   // sessionId → { messages, startedAt }

// ─── Helpers ───────────────────────────────────────────────

function getSessionId(body) {
  return body.user || "default";
}

function getRequestHash(messages) {
  const tail = (messages || []).slice(-3);
  return tail.map((m) => `${m.role}:${(m.content || "").slice(0, 200)}`).join("|");
}

function getCachedResponse(hash) {
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

function logMessage(sessionId, role, content) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, { messages: [], startedAt: new Date() });
  }
  conversations.get(sessionId).messages.push({ role, content, timestamp: new Date().toISOString() });
  if (conversations.size > MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next().value;
    conversations.delete(oldest);
  }
}

function sseChunk(id, content) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
}

function sseDone(res) {
  try {
    res.write("data: [DONE]\n\n");
    res.end();
  } catch {}
}

// ─── Express App ───────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get("/conversations", (_req, res) => {
  const result = {};
  for (const [id, conv] of conversations) {
    result[id] = { startedAt: conv.startedAt, messageCount: conv.messages.length, messages: conv.messages };
  }
  res.json(result);
});

app.delete("/conversations", (_req, res) => {
  conversations.clear();
  res.json({ ok: true });
});

// ─── Main Endpoint ─────────────────────────────────────────

app.post(
  ["/v1/chat/completions", "/v1/chat/completions/chat/completions"],
  async (req, res) => {
    const body = req.body;
    const sessionId = getSessionId(body);
    const lastUserMsg = [...(body.messages || [])].reverse().find((m) => m.role === "user");
    const userText = (lastUserMsg?.content || "").trim();

    // ── 1. Silence filter ──
    if (!userText || userText === "..." || userText === "\u2026" || userText.length < 3) {
      sseHeaders(res);
      res.write(sseChunk(`chatcmpl-silence-${Date.now()}`, " "));
      sseDone(res);
      return;
    }

    logMessage(sessionId, "user", userText);
    console.log(`[proxy] user: ${userText.slice(0, 100)}`);

    // ── 2. Abort any in-flight fetch ──
    if (inFlight.has(sessionId)) {
      const existing = inFlight.get(sessionId);
      console.log(`[proxy] abort in-flight: "${existing.userText.slice(0, 40)}"`);
      try { existing.controller.abort(); } catch {}
      inFlight.delete(sessionId);
    }

    // ── 3. Debounce — keep the LONGEST message ──
    if (pendingRequests.has(sessionId)) {
      const pending = pendingRequests.get(sessionId);
      clearTimeout(pending.timer);

      if (userText.length <= pending.textLength) {
        console.log(`[proxy] debounce: drop shorter (${userText.length} <= ${pending.textLength})`);
        sseHeaders(res);
        res.write(sseChunk(`chatcmpl-superseded-${Date.now()}`, " "));
        sseDone(res);
        pending.timer = setTimeout(() => pending.resolve(), DEBOUNCE_MS);
        return;
      }

      console.log(`[proxy] debounce: replace with longer (${userText.length} > ${pending.textLength})`);
      pending.reject("superseded");
      pendingRequests.delete(sessionId);
    }

    let superseded = false;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, DEBOUNCE_MS);
        pendingRequests.set(sessionId, { timer, resolve, reject, textLength: userText.length });
      });
      pendingRequests.delete(sessionId);
    } catch {
      superseded = true;
      pendingRequests.delete(sessionId);
    }

    if (superseded) {
      sseHeaders(res);
      res.write(sseChunk(`chatcmpl-superseded-${Date.now()}`, " "));
      sseDone(res);
      return;
    }

    console.log(`[proxy] debounce: settled → "${userText.slice(0, 60)}"`);

    // ── Prepare request for OpenClaw ──
    delete body.elevenlabs_extra_body;
    body.model = `openclaw:${OPENCLAW_AGENT}`;
    body.stream = true;
    if (lastUserMsg) lastUserMsg.content = userText + VOICE_HINT;

    // ── 4. Dedup check ──
    const reqHash = getRequestHash(body.messages);
    const cached = getCachedResponse(reqHash);
    if (cached) {
      console.log(`[proxy] dedup hit`);
      sseHeaders(res);
      res.write(sseChunk(`chatcmpl-dedup-${Date.now()}`, cached));
      sseDone(res);
      return;
    }

    // ── 5. Stream from OpenClaw ──
    sseHeaders(res);
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const controller = new AbortController();
    inFlight.set(sessionId, { controller, userText });

    const start = Date.now();
    let llmContent = "";
    let firstChunkMs = 0;
    let lastChunkTime = Date.now();

    // Keep-alive: prevents 15s cascade timeout during long tool calls
    let keepAliveIdx = 0;
    const keepAliveTimer = setInterval(() => {
      if (Date.now() - lastChunkTime > KEEPALIVE_INTERVAL_MS - 1000) {
        const phrase = KEEPALIVE_PHRASES[keepAliveIdx % KEEPALIVE_PHRASES.length];
        keepAliveIdx++;
        try {
          res.write(sseChunk(`chatcmpl-ka-${Date.now()}`, phrase));
          if (typeof res.flush === "function") res.flush();
          lastChunkTime = Date.now();
          console.log(`[proxy] keep-alive: "${phrase.trim()}"`);
        } catch {}
      }
    }, KEEPALIVE_INTERVAL_MS);

    try {
      const upstreamRes = await fetch(OPENCLAW_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENCLAW_TOKEN}`,
          "x-openclaw-agent-id": OPENCLAW_AGENT,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!upstreamRes.ok) {
        clearInterval(keepAliveTimer);
        const errText = await upstreamRes.text();
        console.error(`[proxy] upstream error (${upstreamRes.status}):`, errText);
        res.write(sseChunk(`chatcmpl-err-${Date.now()}`, "Sorry, having trouble connecting. "));
        sseDone(res);
        if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);
        return;
      }

      // ── 6. Pipe LLM chunks verbatim ──
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let partial = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        partial += decoder.decode(value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload);
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              if (!firstChunkMs) firstChunkMs = Date.now() - start;
              llmContent += content;
              lastChunkTime = Date.now();
            }
            res.write(`data: ${payload}\n\n`);
          } catch {
            res.write(`${trimmed}\n\n`);
          }
        }
      }

      // ── 7. Done ──
      clearInterval(keepAliveTimer);
      cacheResponse(reqHash, llmContent);
      logMessage(sessionId, "assistant", llmContent);
      console.log(`[proxy] done: ${llmContent.length} chars, first_chunk=${firstChunkMs}ms, total=${Date.now() - start}ms`);
      sseDone(res);
      if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);

    } catch (err) {
      clearInterval(keepAliveTimer);
      if (err.name === "AbortError") {
        console.log("[proxy] aborted (superseded)");
      } else {
        console.error("[proxy] error:", err.message);
      }
      sseDone(res);
      if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);
    }
  }
);

// ─── Start ─────────────────────────────────────────────────

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`[stark-proxy] v12 — clean passthrough + debounce + keep-alive`);
  console.log(`[stark-proxy] → ${OPENCLAW_URL}`);
  console.log(`[stark-proxy] agent: ${OPENCLAW_AGENT} | port: ${PORT}`);
});

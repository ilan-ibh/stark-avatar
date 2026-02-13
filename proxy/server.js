/**
 * Stark Voice Proxy v9
 *
 * Bridges ElevenLabs Conversational AI ↔ OpenClaw Gateway.
 *
 * Features:
 *   - Silence filter: "..." and empty messages return [DONE] immediately
 *   - In-flight abort per session: new request aborts previous (handles speculative turn)
 *   - Voice hint: appended to user message to keep responses concise
 *   - Contextual buffer: immediate phrase based on what the user asked
 *   - Contextual keep-alive: periodic phrases during long tool calls
 *   - Trailing space on all phrases per ElevenLabs docs
 */

import express from "express";
import { createServer } from "http";

// --- Config ---
const PORT = process.env.PORT || 8013;
const OPENCLAW_URL =
  process.env.OPENCLAW_URL || "http://127.0.0.1:18789/v1/chat/completions";
const OPENCLAW_TOKEN =
  process.env.OPENCLAW_TOKEN ||
  "25b8d60afe0d8fa0141d833affca1b023d45d9f45d174e86";
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || "main";

const VOICE_HINT = " [Voice call — keep response under 3-4 sentences]";

// --- Contextual buffer phrases (trailing space per ElevenLabs docs) ---
// Each category has: [initial buffer, ...keep-alive phrases]
// The initial buffer plays immediately. Keep-alive phrases play every ~10s
// during long tool calls to keep the connection alive.

const PHRASE_CATEGORIES = {
  email: {
    keywords: ['email', 'inbox', 'mail', 'message', 'unread', 'send an email', 'reply'],
    initial: ["Let me check your inbox... ", "Pulling up your emails... ", "Let me look at your messages... "],
    keepAlive: ["Going through your emails... ", "Still reading through them... ", "Almost done checking... "],
  },
  calendar: {
    keywords: ['calendar', 'schedule', 'meeting', 'appointment', 'event', 'free time', 'busy', 'availability'],
    initial: ["Let me check your schedule... ", "Pulling up your calendar... ", "Looking at your agenda... "],
    keepAlive: ["Going through your events... ", "Checking the details... ", "One moment, still looking... "],
  },
  search: {
    keywords: ['search', 'look up', 'find', 'google', 'what is', 'who is', 'look for', 'research'],
    initial: ["Let me look that up... ", "Searching for that... ", "Let me find out... "],
    keepAlive: ["Still searching... ", "Going through the results... ", "Almost there... "],
  },
  code: {
    keywords: ['code', 'bug', 'error', 'deploy', 'build', 'commit', 'repo', 'pull request', 'github'],
    initial: ["Let me check on that... ", "Looking into it... ", "Let me pull that up... "],
    keepAlive: ["Still going through the code... ", "Digging into the details... ", "Almost got it... "],
  },
  data: {
    keywords: ['price', 'stock', 'market', 'trading', 'portfolio', 'crypto', 'bitcoin', 'balance'],
    initial: ["Let me check the numbers... ", "Pulling up the data... ", "Looking at the latest figures... "],
    keepAlive: ["Still crunching the numbers... ", "Going through the data... ", "Almost done... "],
  },
  file: {
    keywords: ['file', 'document', 'folder', 'download', 'upload', 'save', 'open', 'read'],
    initial: ["Let me grab that... ", "Looking for that file... ", "One sec, pulling it up... "],
    keepAlive: ["Still looking through files... ", "Almost found it... ", "One more moment... "],
  },
  memory: {
    keywords: ['remember', 'last time', 'did i', 'have i', 'history', 'before', 'earlier', 'yesterday'],
    initial: ["Let me think back... ", "Checking my memory... ", "Let me recall... "],
    keepAlive: ["Still going through our history... ", "Looking further back... ", "Almost there... "],
  },
  fallback: {
    initial: ["Let me think about that... ", "One sec... ", "Good question... ", "Alright, let me work on that... "],
    keepAlive: ["Still working on it... ", "Bear with me... ", "Almost there... "],
  },
};

function matchCategory(userText) {
  const lower = userText.toLowerCase();
  for (const [name, cat] of Object.entries(PHRASE_CATEGORIES)) {
    if (name === 'fallback') continue;
    if (cat.keywords.some((kw) => lower.includes(kw))) return cat;
  }
  return PHRASE_CATEGORIES.fallback;
}

let lastInitialIdx = -1;

// Track when we last sent a buffer per session — prevents double-buffer
// from speculative turn duplicates cutting each other
const lastBufferTime = new Map();
const BUFFER_COOLDOWN_MS = 4000;

function getContextualPhrases(userText, sessionId) {
  const cat = matchCategory(userText);

  // Check if we sent a buffer recently for this session
  const lastSent = lastBufferTime.get(sessionId) || 0;
  const skipBuffer = Date.now() - lastSent < BUFFER_COOLDOWN_MS;

  // Pick initial phrase (avoid repeating the last one)
  let idx;
  do {
    idx = Math.floor(Math.random() * cat.initial.length);
  } while (idx === lastInitialIdx && cat.initial.length > 1);
  lastInitialIdx = idx;

  if (!skipBuffer) {
    lastBufferTime.set(sessionId, Date.now());
  }

  return {
    initial: skipBuffer ? null : cat.initial[idx],
    keepAlive: cat.keepAlive,
  };
}

// --- In-flight tracking per session ---
const inFlight = new Map(); // sessionId → AbortController

// --- Deduplication ---
const DEDUP_WINDOW_MS = 15000;
const recentRequests = new Map();

function getRequestHash(messages) {
  const tail = (messages || []).slice(-3);
  return tail.map((m) => `${m.role}:${(m.content || "").slice(0, 200)}`).join("|");
}

function getDedupedResponse(hash) {
  const cached = recentRequests.get(hash);
  if (cached && Date.now() - cached.timestamp < DEDUP_WINDOW_MS) {
    console.log("[proxy] DEDUP HIT");
    return cached.response;
  }
  return null;
}

function cacheResponse(hash, response) {
  recentRequests.set(hash, { response, timestamp: Date.now() });
  for (const [k, v] of recentRequests) {
    if (Date.now() - v.timestamp > DEDUP_WINDOW_MS * 2) recentRequests.delete(k);
  }
}

// --- Conversation log ---
const conversations = new Map();

function getSessionId(body) {
  return body.user || "default";
}

function logMessage(sessionId, role, content) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, { messages: [], startedAt: new Date() });
  }
  conversations.get(sessionId).messages.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  });
}

// --- SSE helper ---
function sseChunk(id, content) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get("/conversations", (_req, res) => {
  const result = {};
  for (const [id, conv] of conversations) {
    result[id] = {
      startedAt: conv.startedAt,
      messageCount: conv.messages.length,
      messages: conv.messages,
    };
  }
  res.json(result);
});

app.delete("/conversations", (_req, res) => {
  conversations.clear();
  res.json({ ok: true });
});

app.use((req, _res, next) => {
  console.log(`[proxy] ${req.method} ${req.url}`);
  next();
});

// --- Main endpoint ---
app.post(
  ["/v1/chat/completions", "/v1/chat/completions/chat/completions"],
  async (req, res) => {
    const body = req.body;
    const sessionId = getSessionId(body);

    // Extract user message
    const lastUserMsg = [...(body.messages || [])]
      .reverse()
      .find((m) => m.role === "user");
    const userText = (lastUserMsg?.content || "").trim();

    // --- Silence filter ---
    // Return a single empty-content chunk + DONE (not just bare DONE)
    // so ElevenLabs doesn't interpret it as an LLM failure
    if (!userText || userText === "..." || userText === "…" || userText.length < 3) {
      console.log(`[proxy] SKIP silence: "${userText}"`);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(sseChunk(`chatcmpl-silence-${Date.now()}`, " "));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    logMessage(sessionId, "user", userText);
    console.log(`[proxy] user: ${userText.slice(0, 100)}`);

    // --- Handle in-flight requests for this session ---
    if (inFlight.has(sessionId)) {
      const existing = inFlight.get(sessionId);
      // Only abort if the new message is DIFFERENT (more complete transcript)
      // If it's the same message, it's a retry — just drop the new request
      if (existing.userText === userText) {
        console.log(`[proxy] DUPLICATE — same message already in-flight, dropping`);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write(sseChunk(`chatcmpl-dup-${Date.now()}`, " "));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      // Different message = speculative turn update, abort the old one
      console.log(`[proxy] ABORT in-flight: "${existing.userText.slice(0, 40)}" → "${userText.slice(0, 40)}"`);
      try { existing.controller.abort(); } catch {}
      inFlight.delete(sessionId);
    }

    // Clean up for OpenClaw
    delete body.elevenlabs_extra_body;
    body.model = `openclaw:${OPENCLAW_AGENT}`;
    body.stream = true;

    // --- Voice hint appended to user message ---
    if (lastUserMsg) {
      lastUserMsg.content = userText + VOICE_HINT;
    }

    // --- Dedup check ---
    const reqHash = getRequestHash(body.messages);
    const cached = getDedupedResponse(reqHash);
    if (cached) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(sseChunk(`chatcmpl-dedup-${Date.now()}`, cached));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // --- Stream from OpenClaw ---
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders(); // Force headers out immediately

    // --- Contextual buffer phrase: flush BEFORE fetch starts ---
    // Skipped if we already sent a buffer in the last 4s (speculative turn duplicate)
    const phrases = getContextualPhrases(userText, sessionId);
    const buffer = phrases.initial;

    if (buffer) {
      res.write(sseChunk(`chatcmpl-buf-${Date.now()}`, buffer));
      if (typeof res.flush === "function") res.flush();
      if (res.socket) res.socket.uncork?.();
      console.log(`[proxy] buffer: "${buffer.trim()}"`);
    } else {
      console.log(`[proxy] buffer skipped (cooldown — speculative turn)`);
    }

    const controller = new AbortController();
    inFlight.set(sessionId, { controller, userText });

    const start = Date.now();
    let fullContent = buffer || "";
    let firstChunkMs = 0;

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
        const errText = await upstreamRes.text();
        console.error("[proxy] upstream error:", upstreamRes.status, errText);
        res.write(sseChunk(`chatcmpl-err-${Date.now()}`, "Sorry, having trouble connecting. "));
        res.write("data: [DONE]\n\n");
        res.end();
        if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);
        return;
      }

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let partial = "";
      let lastChunkTime = Date.now();

      // Keep-alive: send contextual filler every 10s during long tool calls
      // so ElevenLabs doesn't hit the cascade timeout and drop the connection.
      const KEEPALIVE_INTERVAL_MS = 10000;
      let keepAliveIdx = 0;
      const keepAliveTimer = setInterval(() => {
        if (Date.now() - lastChunkTime > KEEPALIVE_INTERVAL_MS - 1000) {
          const phrase = phrases.keepAlive[keepAliveIdx % phrases.keepAlive.length];
          keepAliveIdx++;
          res.write(sseChunk(`chatcmpl-keepalive-${Date.now()}`, phrase));
          if (typeof res.flush === "function") res.flush();
          fullContent += phrase;
          lastChunkTime = Date.now();
          console.log(`[proxy] keep-alive sent: "${phrase.trim()}"`);
        }
      }, KEEPALIVE_INTERVAL_MS);

      try {
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
                fullContent += content;
                lastChunkTime = Date.now();
              }
              // Pipe through verbatim
              res.write(`data: ${payload}\n\n`);
            } catch {
              res.write(`${trimmed}\n\n`);
            }
          }
        }
      } finally {
        clearInterval(keepAliveTimer);
      }

      // Cache for dedup
      cacheResponse(reqHash, fullContent);
      logMessage(sessionId, "assistant", fullContent);
      console.log(
        `[proxy] done: ${fullContent.length} chars, first_chunk=${firstChunkMs}ms, total=${Date.now() - start}ms`
      );

      res.write("data: [DONE]\n\n");
      res.end();
      if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);
    } catch (err) {
      if (err.name === "AbortError") {
        console.log("[proxy] request aborted (superseded by newer request)");
      } else {
        console.error("[proxy] error:", err.message);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);
    }
  }
);

// --- Start ---
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`[stark-proxy] ⚡ v9 — contextual buffer + contextual keep-alive`);
  console.log(`[stark-proxy] → ${OPENCLAW_URL}`);
  console.log(`[stark-proxy] Port: ${PORT} | Agent: ${OPENCLAW_AGENT}`);
});

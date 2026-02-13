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

const VOICE_HINT = " [Voice call — keep response under 3-4 sentences. Do NOT start with filler like 'Let me check' or 'Sure thing' — jump straight to the answer.]";

// --- Contextual buffer phrases (trailing space per ElevenLabs docs) ---
// Each category has: [initial buffer, ...keep-alive phrases]
// The initial buffer plays immediately. Keep-alive phrases play every ~10s
// during long tool calls to keep the connection alive.

const PHRASE_CATEGORIES = {
  email: {
    keywords: ['email', 'inbox', 'mail', 'unread', 'send an email', 'reply to'],
    initial: ["Checking your inbox... ", "Pulling up your emails... ", "Let me look at your mail... "],
    keepAlive: ["Going through your emails... ", "Still reading through them... ", "Almost done checking... "],
  },
  calendar: {
    keywords: ['calendar', 'schedule', 'meeting', 'appointment', 'event', 'free time', 'busy', 'availability'],
    initial: ["Checking your schedule... ", "Pulling up your calendar... ", "Looking at your agenda... "],
    keepAlive: ["Going through your events... ", "Checking the details... ", "One moment, still looking... "],
  },
  weather: {
    keywords: ['weather', 'forecast', 'temperature', 'rain', 'sunny', 'cold', 'hot outside'],
    initial: ["Checking the forecast... ", "Let me look at the weather... "],
    keepAlive: ["Still pulling the data... ", "Almost there... "],
  },
  whatsapp: {
    keywords: ['whatsapp', 'whats app'],
    initial: ["Checking your WhatsApp... ", "Pulling up your chats... ", "Let me look at your messages... "],
    keepAlive: ["Going through your conversations... ", "Still reading... ", "Almost done... "],
  },
  messaging: {
    keywords: ['message', 'messages', 'telegram', 'slack', 'discord', 'notification', 'notifications', 'dm', 'chat'],
    initial: ["Checking your messages... ", "Let me pull those up... ", "Looking at your notifications... "],
    keepAlive: ["Going through them... ", "Still reading... ", "Almost done... "],
  },
  twitter: {
    keywords: ['twitter', 'tweet', 'x.com', 'timeline', 'trending', 'post on x'],
    initial: ["Checking your timeline... ", "Pulling up X... ", "Let me look at that... "],
    keepAlive: ["Going through the feed... ", "Still looking... ", "Almost there... "],
  },
  tasks: {
    keywords: ['task', 'tasks', 'todo', 'to-do', 'things', 'reminder', 'reminders', 'due'],
    initial: ["Checking your tasks... ", "Pulling up your to-dos... ", "Let me look at that... "],
    keepAlive: ["Going through your list... ", "Still checking... ", "Almost done... "],
  },
  health: {
    keywords: ['health', 'whoop', 'sleep', 'recovery', 'heart rate', 'hrv', 'strain', 'workout', 'steps', 'fitness'],
    initial: ["Checking your health data... ", "Pulling up your stats... ", "Let me look at your recovery... "],
    keepAlive: ["Going through the data... ", "Still pulling your metrics... ", "Almost there... "],
  },
  crypto: {
    keywords: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'hyperliquid', 'portfolio', 'position', 'pnl', 'trading', 'price'],
    initial: ["Checking the markets... ", "Pulling up your positions... ", "Looking at the numbers... "],
    keepAlive: ["Still crunching the data... ", "Going through your portfolio... ", "Almost done... "],
  },
  search: {
    keywords: ['search', 'look up', 'find', 'google', 'what is', 'who is', 'look for', 'research'],
    initial: ["Let me look that up... ", "Searching for that... ", "Let me find out... "],
    keepAlive: ["Still searching... ", "Going through the results... ", "Almost there... "],
  },
  code: {
    keywords: ['code', 'bug', 'error', 'deploy', 'build', 'commit', 'repo', 'pull request', 'github', 'merge'],
    initial: ["Looking into that... ", "Checking the repo... ", "Let me pull that up... "],
    keepAlive: ["Still going through the code... ", "Digging into the details... ", "Almost got it... "],
  },
  notes: {
    keywords: ['note', 'notes', 'write down', 'jot', 'obsidian', 'save this', 'log this'],
    initial: ["On it... ", "Writing that down... ", "Let me save that... "],
    keepAlive: ["Still working on it... ", "Almost done... "],
  },
  browser: {
    keywords: ['browser', 'open', 'website', 'url', 'link', 'page', 'tab', 'chrome'],
    initial: ["Opening that up... ", "Let me pull that page... ", "On it... "],
    keepAlive: ["Still loading... ", "Almost there... "],
  },
  memory: {
    keywords: ['remember', 'last time', 'did i', 'have i', 'history', 'before', 'earlier', 'yesterday', 'forgot'],
    initial: ["Let me think back... ", "Checking my memory... ", "Let me recall... "],
    keepAlive: ["Going through our history... ", "Looking further back... ", "Almost there... "],
  },
  file: {
    keywords: ['file', 'document', 'folder', 'download', 'upload', 'pdf', 'read this'],
    initial: ["Grabbing that file... ", "Looking for it... ", "One sec, pulling it up... "],
    keepAlive: ["Still looking through files... ", "Almost found it... "],
  },
  music: {
    keywords: ['song', 'music', 'play', 'spotify', 'listen'],
    initial: ["Let me find that... ", "Looking it up... "],
    keepAlive: ["Still searching... ", "Almost there... "],
  },
  image: {
    keywords: ['image', 'photo', 'picture', 'generate', 'draw', 'create an image', 'camera', 'screenshot'],
    initial: ["Working on that visual... ", "Generating that for you... ", "Let me create that... "],
    keepAlive: ["Still rendering... ", "Almost done with the image... ", "Coming together... "],
  },
  voice: {
    keywords: ['say', 'read aloud', 'speak', 'pronounce', 'voice'],
    initial: ["Getting that ready... ", "One moment... "],
    keepAlive: ["Almost ready... "],
  },
  fallback: {
    initial: ["Let me work on that... ", "One sec... ", "On it... ", "Let me figure this out... ", "Give me a moment... ", "Hmm... ", "Alright... "],
    keepAlive: ["Still working on it... ", "Bear with me... ", "Almost there... ", "Just a bit longer... ", "Hang tight... "],
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

function getContextualPhrases(userText) {
  const cat = matchCategory(userText);

  let idx;
  do {
    idx = Math.floor(Math.random() * cat.initial.length);
  } while (idx === lastInitialIdx && cat.initial.length > 1);
  lastInitialIdx = idx;

  return {
    initial: cat.initial[idx],
    keepAlive: cat.keepAlive,
  };
}

// --- In-flight tracking per session ---
const inFlight = new Map(); // sessionId → { controller, userText }

// --- Debounce per session ---
// Delays the response by 1.5s to let speculative turns settle.
// If a new request arrives in that window, the old one closes cleanly
// (no buffer was sent, nothing to cut) and the new one takes over.
const DEBOUNCE_MS = 1500;
const pendingRequests = new Map(); // sessionId → { timer, resolve, reject }

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

    // --- Abort any in-flight fetch for this session ---
    if (inFlight.has(sessionId)) {
      const existing = inFlight.get(sessionId);
      console.log(`[proxy] ABORT in-flight: "${existing.userText.slice(0, 40)}"`);
      try { existing.controller.abort(); } catch {}
      inFlight.delete(sessionId);
    }

    // --- Debounce: wait for transcript to stabilize ---
    // Speculative turns send partial→complete within 1-2s. We hold 1.5s
    // before responding. If a new request arrives, the old one closes
    // cleanly (no buffer was sent, nothing to cut) and the timer resets.
    if (pendingRequests.has(sessionId)) {
      const pending = pendingRequests.get(sessionId);
      clearTimeout(pending.timer);
      pending.reject('superseded');
      pendingRequests.delete(sessionId);
    }

    // Close this response early if superseded during debounce
    let superseded = false;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, DEBOUNCE_MS);
        pendingRequests.set(sessionId, { timer, resolve, reject });
      });
      pendingRequests.delete(sessionId);
    } catch {
      // Superseded by a newer request
      superseded = true;
      pendingRequests.delete(sessionId);
    }

    if (superseded) {
      console.log(`[proxy] debounce: superseded, closing`);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.write(sseChunk(`chatcmpl-superseded-${Date.now()}`, " "));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    console.log(`[proxy] debounce: settled, proceeding with: "${userText.slice(0, 60)}"`);

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
    res.flushHeaders();

    // --- Contextual buffer phrase ---
    const phrases = getContextualPhrases(userText);
    const buffer = phrases.initial;

    if (buffer) {
      res.write(sseChunk(`chatcmpl-buf-${Date.now()}`, buffer));
      if (typeof res.flush === "function") res.flush();
      console.log(`[proxy] buffer: "${buffer.trim()}"`);
    }

    const controller = new AbortController();
    inFlight.set(sessionId, { controller, userText });

    const start = Date.now();
    let fullContent = buffer || "";
    let firstChunkMs = 0;
    let lastChunkTime = Date.now();
    let streamingStarted = false;

    // Keep-alive: starts IMMEDIATELY — fires every 10s during the ENTIRE
    // request lifecycle including the fetch() wait. This is critical because
    // tool calls can block the fetch for 20+ seconds. Without this,
    // ElevenLabs hits its 15s cascade timeout and drops the connection.
    const KEEPALIVE_INTERVAL_MS = 10000;
    let keepAliveIdx = 0;
    const keepAliveTimer = setInterval(() => {
      if (Date.now() - lastChunkTime > KEEPALIVE_INTERVAL_MS - 1000) {
        const phrase = phrases.keepAlive[keepAliveIdx % phrases.keepAlive.length];
        keepAliveIdx++;
        try {
          res.write(sseChunk(`chatcmpl-keepalive-${Date.now()}`, phrase));
          if (typeof res.flush === "function") res.flush();
          fullContent += phrase;
          lastChunkTime = Date.now();
          console.log(`[proxy] keep-alive sent: "${phrase.trim()}"`);
        } catch {
          // Response may have been closed
        }
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
        console.error("[proxy] upstream error:", upstreamRes.status, errText);
        res.write(sseChunk(`chatcmpl-err-${Date.now()}`, "Sorry, having trouble connecting. "));
        res.write("data: [DONE]\n\n");
        res.end();
        if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);
        return;
      }

      streamingStarted = true;
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
              // Hold the first real chunk until the buffer phrase has had time to finish.
              // Buffer phrases are ~1-2.5s of speech. If the LLM responds fast, wait.
              // If the LLM is slow (tool calls), the buffer is already done — no delay.
              if (!firstChunkMs) {
                firstChunkMs = Date.now() - start;
                if (buffer) {
                  const elapsed = Date.now() - lastChunkTime;
                  const minBufferTime = 2500;
                  if (elapsed < minBufferTime) {
                    await new Promise((r) => setTimeout(r, minBufferTime - elapsed));
                  }
                }
              }
              fullContent += content;
              lastChunkTime = Date.now();
            }
            res.write(`data: ${payload}\n\n`);
          } catch {
            res.write(`${trimmed}\n\n`);
          }
        }
      }

      clearInterval(keepAliveTimer);

      cacheResponse(reqHash, fullContent);
      logMessage(sessionId, "assistant", fullContent);
      console.log(
        `[proxy] done: ${fullContent.length} chars, first_chunk=${firstChunkMs}ms, total=${Date.now() - start}ms`
      );

      res.write("data: [DONE]\n\n");
      res.end();
      if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);
    } catch (err) {
      clearInterval(keepAliveTimer);
      if (err.name === "AbortError") {
        console.log("[proxy] request aborted (superseded by newer request)");
      } else {
        console.error("[proxy] error:", err.message);
      }
      try {
        res.write("data: [DONE]\n\n");
        res.end();
      } catch {}
      if (inFlight.get(sessionId)?.controller === controller) inFlight.delete(sessionId);
    }
  }
);

// --- Start ---
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`[stark-proxy] ⚡ v10 — keep-alive during fetch + no double preamble`);
  console.log(`[stark-proxy] → ${OPENCLAW_URL}`);
  console.log(`[stark-proxy] Port: ${PORT} | Agent: ${OPENCLAW_AGENT}`);
});

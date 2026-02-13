/**
 * Stark Voice Proxy v11
 *
 * Bridges ElevenLabs Conversational AI ↔ OpenClaw Gateway.
 *
 * Request lifecycle:
 *
 *   1. SILENCE FILTER     → "..." or empty → return [DONE] immediately
 *   2. ABORT IN-FLIGHT    → cancel any pending fetch for this session
 *   3. DEBOUNCE (1.5s)    → wait for speculative turn to settle;
 *                            if a new request arrives, the old one closes
 *                            cleanly (nothing was sent) and timer resets
 *   4. DEDUP CHECK        → if we recently answered this exact message, replay
 *   5. BUFFER PHRASE      → contextual filler based on user's query, spoken
 *                            by TTS while the LLM processes
 *   6. KEEP-ALIVE (10s)   → periodic filler during long tool calls so
 *                            ElevenLabs doesn't hit the 15s cascade timeout
 *   7. FETCH → OPENCLAW   → SSE stream; first real chunk is held until 2.5s
 *                            after buffer was sent (so TTS finishes the buffer)
 *   8. STREAM THROUGH     → pipe LLM chunks verbatim to ElevenLabs
 *   9. DONE               → cache response, clean up, close stream
 */

import express from "express";
import { createServer } from "http";

// ─── Config ────────────────────────────────────────────────

const PORT = process.env.PORT || 8013;
const OPENCLAW_URL = process.env.OPENCLAW_URL || "http://127.0.0.1:18789/v1/chat/completions";
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || "25b8d60afe0d8fa0141d833affca1b023d45d9f45d174e86";
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || "main";

const VOICE_HINT = " [Voice call — keep response under 3-4 sentences. Do NOT start with filler like 'Let me check' or 'Sure thing' — jump straight to the answer.]";
const DEBOUNCE_MS = 1500;
const KEEPALIVE_INTERVAL_MS = 10000;
const MIN_BUFFER_SPEECH_MS = 2500; // minimum time for buffer phrase to finish speaking
const DEDUP_WINDOW_MS = 15000;
const MAX_CONVERSATIONS = 50; // cap stored conversations

// ─── Contextual Buffer Phrases ─────────────────────────────
// Matched to the user's query by keyword. Initial phrase plays immediately.
// Keep-alive phrases play every 10s during long tool calls.
// All phrases end with trailing space per ElevenLabs docs.

const PHRASE_CATEGORIES = {
  email: {
    keywords: ["email", "inbox", "mail", "unread", "send an email", "reply to"],
    initial: ["Checking your inbox... ", "Pulling up your emails... ", "Let me look at your mail... "],
    keepAlive: ["Going through your emails... ", "Still reading through them... ", "Almost done checking... "],
  },
  calendar: {
    keywords: ["calendar", "schedule", "meeting", "appointment", "event", "free time", "busy", "availability"],
    initial: ["Checking your schedule... ", "Pulling up your calendar... ", "Looking at your agenda... "],
    keepAlive: ["Going through your events... ", "Checking the details... ", "One moment, still looking... "],
  },
  weather: {
    keywords: ["weather", "forecast", "temperature", "rain", "sunny", "cold", "hot outside"],
    initial: ["Checking the forecast... ", "Let me look at the weather... "],
    keepAlive: ["Still pulling the data... ", "Almost there... "],
  },
  whatsapp: {
    keywords: ["whatsapp", "whats app"],
    initial: ["Checking your WhatsApp... ", "Pulling up your chats... ", "Let me look at your messages... "],
    keepAlive: ["Going through your conversations... ", "Still reading... ", "Almost done... "],
  },
  messaging: {
    keywords: ["message", "messages", "telegram", "slack", "discord", "notification", "notifications", "dm", "chat"],
    initial: ["Checking your messages... ", "Let me pull those up... ", "Looking at your notifications... "],
    keepAlive: ["Going through them... ", "Still reading... ", "Almost done... "],
  },
  twitter: {
    keywords: ["twitter", "tweet", "x.com", "timeline", "trending", "post on x"],
    initial: ["Checking your timeline... ", "Pulling up X... ", "Let me look at that... "],
    keepAlive: ["Going through the feed... ", "Still looking... ", "Almost there... "],
  },
  tasks: {
    keywords: ["task", "tasks", "todo", "to-do", "things", "reminder", "reminders", "due"],
    initial: ["Checking your tasks... ", "Pulling up your to-dos... ", "Let me look at that... "],
    keepAlive: ["Going through your list... ", "Still checking... ", "Almost done... "],
  },
  health: {
    keywords: ["health", "whoop", "sleep", "recovery", "heart rate", "hrv", "strain", "workout", "steps", "fitness"],
    initial: ["Checking your health data... ", "Pulling up your stats... ", "Let me look at your recovery... "],
    keepAlive: ["Going through the data... ", "Still pulling your metrics... ", "Almost there... "],
  },
  crypto: {
    keywords: ["crypto", "bitcoin", "btc", "ethereum", "eth", "hyperliquid", "portfolio", "position", "pnl", "trading", "price"],
    initial: ["Checking the markets... ", "Pulling up your positions... ", "Looking at the numbers... "],
    keepAlive: ["Still crunching the data... ", "Going through your portfolio... ", "Almost done... "],
  },
  search: {
    keywords: ["search", "look up", "find", "google", "what is", "who is", "look for", "research"],
    initial: ["Let me look that up... ", "Searching for that... ", "Let me find out... "],
    keepAlive: ["Still searching... ", "Going through the results... ", "Almost there... "],
  },
  code: {
    keywords: ["code", "bug", "error", "deploy", "build", "commit", "repo", "pull request", "github", "merge"],
    initial: ["Looking into that... ", "Checking the repo... ", "Let me pull that up... "],
    keepAlive: ["Still going through the code... ", "Digging into the details... ", "Almost got it... "],
  },
  notes: {
    keywords: ["note", "notes", "write down", "jot", "obsidian", "save this", "log this"],
    initial: ["On it... ", "Writing that down... ", "Let me save that... "],
    keepAlive: ["Still working on it... ", "Almost done... "],
  },
  browser: {
    keywords: ["browser", "open", "website", "url", "link", "page", "tab", "chrome"],
    initial: ["Opening that up... ", "Let me pull that page... ", "On it... "],
    keepAlive: ["Still loading... ", "Almost there... "],
  },
  memory: {
    keywords: ["remember", "last time", "did i", "have i", "history", "before", "earlier", "yesterday", "forgot"],
    initial: ["Let me think back... ", "Checking my memory... ", "Let me recall... "],
    keepAlive: ["Going through our history... ", "Looking further back... ", "Almost there... "],
  },
  file: {
    keywords: ["file", "document", "folder", "download", "upload", "pdf", "read this"],
    initial: ["Grabbing that file... ", "Looking for it... ", "One sec, pulling it up... "],
    keepAlive: ["Still looking through files... ", "Almost found it... "],
  },
  music: {
    keywords: ["song", "music", "play", "spotify", "listen"],
    initial: ["Let me find that... ", "Looking it up... "],
    keepAlive: ["Still searching... ", "Almost there... "],
  },
  image: {
    keywords: ["image", "photo", "picture", "generate", "draw", "create an image", "camera", "screenshot"],
    initial: ["Working on that visual... ", "Generating that for you... ", "Let me create that... "],
    keepAlive: ["Still rendering... ", "Almost done with the image... ", "Coming together... "],
  },
  voice: {
    keywords: ["say", "read aloud", "speak", "pronounce", "voice"],
    initial: ["Getting that ready... ", "One moment... "],
    keepAlive: ["Almost ready... "],
  },
  fallback: {
    initial: ["Let me work on that... ", "One sec... ", "On it... ", "Let me figure this out... ", "Give me a moment... ", "Hmm... ", "Alright... "],
    keepAlive: ["Still working on it... ", "Bear with me... ", "Almost there... ", "Just a bit longer... ", "Hang tight... "],
  },
};

function matchCategory(text) {
  const lower = text.toLowerCase();
  for (const [name, cat] of Object.entries(PHRASE_CATEGORIES)) {
    if (name === "fallback") continue;
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
  return { initial: cat.initial[idx], keepAlive: cat.keepAlive };
}

// ─── State Maps ────────────────────────────────────────────

const inFlight = new Map();       // sessionId → { controller, userText }
const pendingRequests = new Map(); // sessionId → { timer, resolve, reject }
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
  // Evict old entries
  for (const [k, v] of recentRequests) {
    if (Date.now() - v.timestamp > DEDUP_WINDOW_MS * 2) recentRequests.delete(k);
  }
}

function logMessage(sessionId, role, content) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, { messages: [], startedAt: new Date() });
  }
  conversations.get(sessionId).messages.push({ role, content, timestamp: new Date().toISOString() });
  // Cap stored conversations
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
// ElevenLabs sends requests here. The double path handles a known
// ElevenLabs routing quirk that sometimes doubles the path segment.

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

    // ── 3. Debounce — wait for speculative turn to settle ──
    if (pendingRequests.has(sessionId)) {
      const pending = pendingRequests.get(sessionId);
      clearTimeout(pending.timer);
      pending.reject("superseded");
      pendingRequests.delete(sessionId);
    }

    let superseded = false;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, DEBOUNCE_MS);
        pendingRequests.set(sessionId, { timer, resolve, reject });
      });
      pendingRequests.delete(sessionId);
    } catch {
      superseded = true;
      pendingRequests.delete(sessionId);
    }

    if (superseded) {
      console.log(`[proxy] debounce: superseded`);
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

    // ── 5. Send buffer phrase ──
    sseHeaders(res);
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const phrases = getContextualPhrases(userText);
    const buffer = phrases.initial;
    res.write(sseChunk(`chatcmpl-buf-${Date.now()}`, buffer));
    if (typeof res.flush === "function") res.flush();
    console.log(`[proxy] buffer: "${buffer.trim()}"`);

    const controller = new AbortController();
    inFlight.set(sessionId, { controller, userText });

    const start = Date.now();
    let llmContent = ""; // only the LLM's actual response (not buffer/keep-alive)
    let firstChunkMs = 0;
    let lastChunkTime = Date.now();

    // ── 6. Keep-alive timer (starts before fetch) ──
    let keepAliveIdx = 0;
    const keepAliveTimer = setInterval(() => {
      if (Date.now() - lastChunkTime > KEEPALIVE_INTERVAL_MS - 1000) {
        const phrase = phrases.keepAlive[keepAliveIdx % phrases.keepAlive.length];
        keepAliveIdx++;
        try {
          res.write(sseChunk(`chatcmpl-keepalive-${Date.now()}`, phrase));
          if (typeof res.flush === "function") res.flush();
          lastChunkTime = Date.now();
          console.log(`[proxy] keep-alive: "${phrase.trim()}"`);
        } catch {}
      }
    }, KEEPALIVE_INTERVAL_MS);

    try {
      // ── 7. Fetch from OpenClaw ──
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

      // ── 8. Stream response through ──
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
              // Smart hold: ensure buffer phrase has finished speaking
              if (!firstChunkMs) {
                firstChunkMs = Date.now() - start;
                const elapsed = Date.now() - lastChunkTime;
                if (elapsed < MIN_BUFFER_SPEECH_MS) {
                  await new Promise((r) => setTimeout(r, MIN_BUFFER_SPEECH_MS - elapsed));
                }
              }
              llmContent += content;
              lastChunkTime = Date.now();
            }
            res.write(`data: ${payload}\n\n`);
          } catch {
            res.write(`${trimmed}\n\n`);
          }
        }
      }

      // ── 9. Done ──
      clearInterval(keepAliveTimer);
      cacheResponse(reqHash, llmContent); // cache only the LLM response, not filler
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
  console.log(`[stark-proxy] v11 — debounce + contextual buffer + keep-alive`);
  console.log(`[stark-proxy] → ${OPENCLAW_URL}`);
  console.log(`[stark-proxy] agent: ${OPENCLAW_AGENT} | port: ${PORT}`);
});

/**
 * StarkChrome Event Logger v2
 *
 * Receives browser events from StarkChrome extension and writes
 * human-readable markdown to daily log files. Zero LLM cost.
 *
 * Filters noise (window focus, loading states) and formats events
 * into clean timestamped entries grouped by type.
 */

import express from "express";
import { appendFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";

const PORT = process.env.CHROME_LOGGER_PORT || 8014;
const LOG_DIR = "/Users/starkai/.openclaw/workspace/memory/browsing";
const AUTH_TOKEN = "25b8d60afe0d8fa0141d833affca1b023d45d9f45d174e86";

const app = express();
app.use(express.json({ limit: "5mb" }));

// --- Auth ---
function checkAuth(req) {
  const auth = req.headers.authorization || "";
  const token = req.headers["x-api-key"] || req.query.token || "";
  return auth === `Bearer ${AUTH_TOKEN}` || token === AUTH_TOKEN;
}

// --- Date helpers (Dubai GMT+4) ---
function dubaiNow() {
  return new Date(Date.now() + 4 * 60 * 60 * 1000);
}

function getLogPath() {
  const date = dubaiNow().toISOString().slice(0, 10);
  return `${LOG_DIR}/${date}.md`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts : Date.parse(ts));
  const dubai = new Date(d.getTime() + 4 * 60 * 60 * 1000);
  return dubai.toISOString().slice(11, 16); // HH:MM
}

async function ensureLogFile(path) {
  if (!existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });
  if (!existsSync(path)) {
    const date = path.split("/").pop().replace(".md", "");
    await appendFile(path, `# Browser Activity — ${date}\n\n`);
  }
}

// --- Event parser ---
// Converts raw StarkChrome events into readable markdown lines
function parseEvents(body) {
  const lines = [];

  // Handle different payload formats
  let events = [];
  if (Array.isArray(body)) {
    events = body;
  } else if (Array.isArray(body.events)) {
    events = body.events;
  } else if (body.message && typeof body.message === "string") {
    // OpenClaw webhook format — extract from message text
    return parseTextReport(body.message);
  } else if (typeof body === "string") {
    return parseTextReport(body);
  } else {
    // Single event object
    events = [body];
  }

  for (const event of events) {
    const time = formatTime(event.timestamp || event.ts);
    const type = event.type || event.event || "";
    const data = event.data || event;

    switch (type) {
      case "navigation":
      case "navigated":
        if (data.url && !data.url.startsWith("chrome://")) {
          lines.push(`- ${time} 🔗 Navigated to: ${data.title || ""} — ${data.url}`);
        }
        break;

      case "tab.switch":
      case "switched":
        if (data.title) {
          lines.push(`- ${time} 📑 Switched to: ${data.title}`);
        }
        break;

      case "tab.open":
      case "opened":
        if (data.url && !data.url.startsWith("chrome://newtab")) {
          lines.push(`- ${time} ➕ Opened tab: ${data.url}`);
        }
        break;

      case "tab.close":
      case "closed":
        lines.push(`- ${time} ✖️ Closed tab${data.title ? ": " + data.title : ""}`);
        break;

      case "bookmark.created":
      case "bookmarked":
        lines.push(`- ${time} ⭐ Bookmarked: ${data.title || ""} — ${data.url || ""}`);
        break;

      case "bookmark.removed":
        lines.push(`- ${time} ❌ Removed bookmark: ${data.title || ""}`);
        break;

      case "download.started":
        lines.push(`- ${time} ⬇️ Download started: ${data.filename || data.url || ""}`);
        break;

      case "download.complete":
      case "download.completed":
        lines.push(`- ${time} ✅ Downloaded: ${data.filename || ""} (${data.mime || data.mimeType || ""})`);
        break;

      case "visit":
      case "visited":
        if (data.url && !data.url.startsWith("chrome://")) {
          const visits = data.visitCount ? ` (visit #${data.visitCount})` : "";
          lines.push(`- ${time} 📄 Visited: ${data.title || ""}${visits} — ${data.url}`);
        }
        break;

      case "user.idle":
        lines.push(`- ${time} 💤 Went idle`);
        break;

      case "user.active":
        lines.push(`- ${time} ⚡ Back active`);
        break;

      case "user.locked":
        lines.push(`- ${time} 🔒 Screen locked`);
        break;

      case "user.comeback":
        const mins = data.idleDuration ? Math.round(data.idleDuration / 60000) : "?";
        lines.push(`- ${time} 👋 Back after ${mins} min away`);
        break;

      case "page.content":
        if (data.url && (data.summary || data.description || data.content)) {
          const summary = data.summary || data.description || "";
          const timeSpent = data.timeSpent ? ` (${Math.round(data.timeSpent / 1000)}s)` : "";
          lines.push(`- ${time} 📝 Read${timeSpent}: **${data.title || "Untitled"}** — ${data.url}`);
          if (summary) {
            lines.push(`  > ${summary.slice(0, 500)}`);
          }
          // Also write to content log for richer digests
          writeContentEntry(time, data).catch(() => {});
        }
        break;

      case "test":
        lines.push(`- ${time} 🧪 Test event: ${data.message || "connection check"}`);
        break;

      default:
        // Skip window.focus, tab.updated loading states, navigation.started/committed
        if (type.includes("window.focus") || type.includes("navigation.started") ||
            type.includes("navigation.committed") || type.includes("tab.updated")) {
          break;
        }
        // Log unknown types for debugging
        if (type) {
          lines.push(`- ${time} ❓ ${type}: ${JSON.stringify(data).slice(0, 150)}`);
        }
    }
  }

  return lines;
}

// Parse text-format reports (from webhook forwarding)
function parseTextReport(text) {
  const lines = [];
  const rows = text.split("\n");
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed || trimmed.startsWith("[StarkChrome") || trimmed.startsWith("Time:") ||
        trimmed.startsWith("Events:") || trimmed === "---" ||
        trimmed.includes("window.focus") || trimmed.includes("User state: active") ||
        trimmed.includes("navigation.started") || trimmed.includes("navigation.committed") ||
        trimmed.includes('"status":"loading"') || trimmed.startsWith("Current time:") ||
        trimmed.startsWith("Return your summary")) {
      continue;
    }
    lines.push(`- ${trimmed}`);
  }
  return lines;
}

// --- Content log (richer page summaries for knowledge extraction) ---
const CONTENT_DIR = "/Users/starkai/.openclaw/workspace/memory/browsing/content";

async function writeContentEntry(time, data) {
  if (!existsSync(CONTENT_DIR)) await mkdir(CONTENT_DIR, { recursive: true });
  const date = dubaiNow().toISOString().slice(0, 10);
  const contentPath = `${CONTENT_DIR}/${date}.md`;
  if (!existsSync(contentPath)) {
    await appendFile(contentPath, `# Page Content — ${date}\n\n`);
  }
  const summary = data.summary || data.description || "";
  const content = data.content || "";
  const timeSpent = data.timeSpent ? `${Math.round(data.timeSpent / 1000)}s` : "unknown";
  const entry = `## ${data.title || "Untitled"}\n- **URL:** ${data.url}\n- **Time spent:** ${timeSpent}\n- **Summary:** ${summary.slice(0, 500)}\n${content ? `- **Key content:**\n  ${content.slice(0, 2000).replace(/\n/g, "\n  ")}\n` : ""}\n---\n\n`;
  await appendFile(contentPath, entry);
  console.log(`[chrome-logger] 📝 content saved: "${(data.title || "").slice(0, 50)}"`);
}

// --- Routes ---
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Main event receiver
app.post("/events", async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: "unauthorized" });

  const logPath = getLogPath();
  await ensureLogFile(logPath);

  const lines = parseEvents(req.body);

  if (lines.length === 0) {
    return res.json({ ok: true, logged: 0 });
  }

  const entry = lines.join("\n") + "\n";
  await appendFile(logPath, entry);

  console.log(`[chrome-logger] +${lines.length} events → ${logPath.split("/").pop()}`);
  res.json({ ok: true, logged: lines.length });
});

// Compatibility with /hooks/agent format
app.post("/hooks/agent", async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: "unauthorized" });

  const logPath = getLogPath();
  await ensureLogFile(logPath);

  const lines = parseEvents(req.body);

  if (lines.length === 0) {
    return res.json({ ok: true, logged: 0 });
  }

  const entry = lines.join("\n") + "\n";
  await appendFile(logPath, entry);

  console.log(`[chrome-logger] +${lines.length} events (via hooks) → ${logPath.split("/").pop()}`);
  res.json({ ok: true, logged: lines.length });
});

// Read today's log
app.get("/today", async (_req, res) => {
  const logPath = getLogPath();
  if (!existsSync(logPath)) return res.json({ date: dubaiNow().toISOString().slice(0, 10), events: 0, log: "" });
  const content = await readFile(logPath, "utf-8");
  const eventCount = (content.match(/^- /gm) || []).length;
  res.json({ date: dubaiNow().toISOString().slice(0, 10), events: eventCount, log: content });
});

app.listen(PORT, () => {
  console.log(`[chrome-logger] ⚡ v2 — smart markdown logging`);
  console.log(`[chrome-logger] → ${LOG_DIR}/`);
  console.log(`[chrome-logger] Port: ${PORT}`);
});

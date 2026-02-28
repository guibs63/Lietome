// guibs:/server.js (COMPLET) — ULTRA v3.4.1 (Railway-safe + FIX /projects + socket compat) ✅
"use strict";

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");
const OpenAI = require("openai");

// Node 18+ has global fetch
const fetchFn = global.fetch;

// ==================================================
// OPTIONAL DEPENDENCIES (NEVER CRASH ON REQUIRE)
// ==================================================
function optionalRequire(name) {
  try {
    return require(name);
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND") return null;
    throw e;
  }
}

// Web extraction (optional)
const jsdomPkg = optionalRequire("jsdom");
const readabilityPkg = optionalRequire("@mozilla/readability");
const JSDOM = jsdomPkg ? jsdomPkg.JSDOM : null;
const Readability = readabilityPkg ? (readabilityPkg.Readability || readabilityPkg) : null;

// Docs creation (optional)
const docxPkg = optionalRequire("docx");
const excelJSPkg = optionalRequire("exceljs");
const pptxPkg = optionalRequire("pptxgenjs");

const Document = docxPkg ? docxPkg.Document : null;
const Packer = docxPkg ? docxPkg.Packer : null;
const Paragraph = docxPkg ? docxPkg.Paragraph : null;
const HeadingLevel = docxPkg ? docxPkg.HeadingLevel : null;
const TextRun = docxPkg ? docxPkg.TextRun : null;

const ExcelJS = excelJSPkg || null;
const PptxGenJS = pptxPkg || null;

// ==================================================
// APP INIT
// ==================================================
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "6mb" }));

// ✅ anti-cache Railway
app.get("/", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.get("/client.js", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use(express.static(__dirname));

// ==================================================
// CONFIG
// ==================================================
function cleanEnv(v) { return String(v ?? "").trim(); }

const APP_VERSION = process.env.APP_VERSION || "ultra-v3.4.1";
const STORAGE_DIR = path.join(__dirname, "storage");
const HISTORY_FILE = path.join(STORAGE_DIR, "messages.json");
const PROJECTS_FILE = path.join(STORAGE_DIR, "projects.json");
const MEMORY_FILE = path.join(STORAGE_DIR, "global_memory.json");
const LOG_FILE = path.join(STORAGE_DIR, "logs.txt");

const UPLOADS_DIR = path.join(__dirname, "uploads");
const GENERATED_DIR = path.join(__dirname, "generated");

const MAX_MESSAGES_PER_PROJECT = Number(process.env.MAX_MESSAGES_PER_PROJECT || 350);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 40);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// IA
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2-chat-latest";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// URL open
const WEB_PAGE_TIMEOUT_MS = Number(process.env.WEB_PAGE_TIMEOUT_MS || 12000);
const WEB_MAX_CHARS_PER_PAGE = Number(process.env.WEB_MAX_CHARS_PER_PAGE || 14000);

// 🔥 TAVILY SEARCH (ALWAYS SEARCH)
const WEB_SEARCH_PROVIDER = cleanEnv(process.env.WEB_SEARCH_PROVIDER || ""); // must be "tavily"
const TAVILY_API_KEY = cleanEnv(process.env.TAVILY_API_KEY || "");
const WEB_SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 12000);
const WEB_SEARCH_MAX_RESULTS = Number(process.env.WEB_SEARCH_MAX_RESULTS || 5);

// Cache
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

// Audio auto transcript message
const AUDIO_AUTO_TRANSCRIPT_MESSAGE = String(process.env.AUDIO_AUTO_TRANSCRIPT_MESSAGE || "1") !== "0";
const AUDIO_TRANSCRIPT_LANGUAGE = process.env.AUDIO_TRANSCRIPT_LANGUAGE || "fr";
const AUDIO_TRANSCRIPT_PREFIX = process.env.AUDIO_TRANSCRIPT_PREFIX || "🗣️ (transcription) ";

// (optionnel) Protéger /logs avec un token
const LOGS_TOKEN = cleanEnv(process.env.LOGS_TOKEN || "");

// ==================================================
// INIT DIRS
// ==================================================
function ensureDirs() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify({}, null, 2), "utf8");
  if (!fs.existsSync(PROJECTS_FILE)) fs.writeFileSync(PROJECTS_FILE, JSON.stringify(["test"], null, 2), "utf8");
  if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify({ facts: [] }, null, 2), "utf8");
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "", "utf8");
}
ensureDirs();

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/generated", express.static(GENERATED_DIR));

// ==================================================
// LOGGING (FILE + CONSOLE)
// ==================================================
function logLine(...args) {
  const safe = args.map((a) => {
    try { return typeof a === "string" ? a : JSON.stringify(a); }
    catch { return String(a); }
  });

  const line = `[${new Date().toISOString()}] ${safe.join(" ")}\n`;

  try {
    if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {}
  console.log(...args);
}

function tailFile(filePath, maxLines = 200) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  } catch {
    return "";
  }
}

// ==================================================
// HELPERS
// ==================================================
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { logLine("[storage] write failed:", file, e?.message || e); }
}
function cleanStr(v) { return String(v ?? "").trim(); }
function safeProjectKey(project) {
  const p = cleanStr(project);
  return p ? p.slice(0, 80) : "";
}
function isValidProjectName(name) {
  return /^[a-zA-Z0-9 _.\-]{2,50}$/.test(name);
}
function hasOpenAI() { return Boolean(OPENAI_API_KEY); }
function getOpenAIClient() { return new OpenAI({ apiKey: OPENAI_API_KEY }); }

function hasTavily() {
  return WEB_SEARCH_PROVIDER === "tavily" && Boolean(TAVILY_API_KEY);
}

// ==================================================
// STATE
// ==================================================
let historyByProject = readJSON(HISTORY_FILE, {});
let projects = readJSON(PROJECTS_FILE, ["test"]);
let globalMemory = readJSON(MEMORY_FILE, { facts: [] });

if (!Array.isArray(projects) || projects.length === 0) projects = ["test"];
projects = Array.from(new Set(projects.map((p) => cleanStr(p)).filter(Boolean)));
if (!globalMemory || typeof globalMemory !== "object") globalMemory = { facts: [] };
if (!Array.isArray(globalMemory.facts)) globalMemory.facts = [];

// save debounce
let saveTimer = null;
function scheduleHistorySave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeJSON(HISTORY_FILE, historyByProject);
  }, 400);
}
function saveProjectsNow() { writeJSON(PROJECTS_FILE, projects); }
function saveMemoryNow() { writeJSON(MEMORY_FILE, globalMemory); }

function getHistory(project) {
  const p = safeProjectKey(project);
  const arr = historyByProject[p];
  return Array.isArray(arr) ? arr : [];
}
function pushMessage(project, msgObj) {
  const p = safeProjectKey(project);
  if (!p) return;
  if (!Array.isArray(historyByProject[p])) historyByProject[p] = [];
  historyByProject[p].push(msgObj);
  if (historyByProject[p].length > MAX_MESSAGES_PER_PROJECT) {
    historyByProject[p] = historyByProject[p].slice(-MAX_MESSAGES_PER_PROJECT);
  }
  scheduleHistorySave();
}
function listProjects() {
  return projects.slice().sort((a, b) => a.localeCompare(b, "fr"));
}

// ==================================================
// MEMORY GLOBAL
// ==================================================
function normalizeFactText(t) {
  return cleanStr(t).replace(/\s+/g, " ").slice(0, 280);
}
function addGlobalFact({ text, who = "", project = "" }) {
  const factText = normalizeFactText(text);
  if (!factText) return false;

  const exists = globalMemory.facts.some((f) => normalizeFactText(f.text) === factText);
  if (exists) return false;

  const now = Date.now();
  globalMemory.facts.unshift({
    id: `fact_${now}_${Math.random().toString(16).slice(2)}`,
    text: factText,
    who: cleanStr(who).slice(0, 80),
    project: cleanStr(project).slice(0, 80),
    ts: now,
  });
  if (globalMemory.facts.length > 500) globalMemory.facts = globalMemory.facts.slice(0, 500);
  saveMemoryNow();
  return true;
}
function memoryTop(n = 14) {
  return globalMemory.facts.slice(0, n);
}
function renderMemoryBlock() {
  const facts = memoryTop(14);
  if (!facts.length) return "Aucune mémoire globale enregistrée.";
  return facts.map((f, i) => `${i + 1}. ${f.text}`).join("\n");
}

// ==================================================
// ROUTES
// ==================================================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    version: APP_VERSION,
    ai: hasOpenAI() ? "enabled" : "disabled",
    deps: {
      jsdom: Boolean(JSDOM),
      readability: Boolean(Readability),
      docx: Boolean(docxPkg),
      exceljs: Boolean(ExcelJS),
      pptxgenjs: Boolean(PptxGenJS),
    },
    models: {
      chat: OPENAI_MODEL,
      transcribe: OPENAI_TRANSCRIBE_MODEL,
      image: OPENAI_IMAGE_MODEL,
    },
    web: hasTavily() ? "tavily-search + url-open" : "url-open only (tavily not configured)",
    audio: { autoTranscriptMessage: AUDIO_AUTO_TRANSCRIPT_MESSAGE, language: AUDIO_TRANSCRIPT_LANGUAGE },
    logs: { enabled: true, protectedByToken: Boolean(LOGS_TOKEN) },
  });
});

// ✅ IMPORTANT: compat ancien client => renvoie un TABLEAU
app.get("/projects", (req, res) => res.json(listProjects()));
// ✅ nouveau format (si tu veux l’utiliser plus tard)
app.get("/projects/v2", (req, res) => res.json({ ok: true, projects: listProjects() }));

app.get("/logs", (req, res) => {
  if (LOGS_TOKEN) {
    const token = cleanStr(req.query?.token);
    if (!token || token !== LOGS_TOKEN) return res.status(401).send("unauthorized (missing/invalid token)");
  }
  const out = tailFile(LOG_FILE, 220);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(out || "no logs");
});

// ==================================================
// SERVER + SOCKET
// ==================================================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ==================================================
// FILE HELPERS
// ==================================================
function isTextLikeExt(ext) {
  return [".txt", ".md", ".csv", ".log", ".json", ".yaml", ".yml"].includes(ext);
}
function isAudioLike(mimetype, ext) {
  if (mimetype && mimetype.startsWith("audio/")) return true;
  return [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".webm", ".flac", ".mp4", ".mka"].includes(ext);
}
function extFromMime(mime, originalName) {
  const fallback = path.extname(originalName || "").slice(0, 10);
  if (fallback) return fallback;

  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "application/pdf") return ".pdf";
  if (mime === "text/plain") return ".txt";

  if (mime === "audio/webm") return ".webm";
  if (mime === "audio/ogg") return ".ogg";
  if (mime === "audio/mpeg") return ".mp3";
  if (mime === "audio/wav") return ".wav";
  if (mime === "audio/x-wav") return ".wav";
  if (mime === "audio/mp4") return ".m4a";
  if (mime && mime.startsWith("audio/")) return ".audio";

  return "";
}

// ==================================================
// UPLOAD
// ==================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = extFromMime(file.mimetype, file.originalname);
    const id = crypto.randomBytes(12).toString("hex");
    cb(null, `${Date.now()}_${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const project = safeProjectKey(req.body?.project);
    const username = cleanStr(req.body?.username) || "Anonyme";
    const userId = cleanStr(req.body?.userId);

    if (!project || !projects.includes(project)) return res.status(400).json({ ok: false, error: "Projet invalide." });
    if (!userId) return res.status(400).json({ ok: false, error: "userId manquant." });
    if (!req.file) return res.status(400).json({ ok: false, error: "Aucun fichier." });

    const hostBase = `${req.protocol}://${req.get("host")}`;
    const url = `${hostBase}/uploads/${encodeURIComponent(req.file.filename)}`;

    const attachment = {
      url,
      path: `/uploads/${req.file.filename}`,
      filename: req.file.originalname,
      storedAs: req.file.filename,
      mimetype: req.file.mimetype || "application/octet-stream",
      size: req.file.size,
    };

    const msg = {
      id: Date.now(),
      ts: Date.now(),
      project,
      username,
      userId,
      message: `📎 ${attachment.filename}`,
      attachment,
    };

    pushMessage(project, {
      id: msg.id,
      ts: msg.ts,
      username: msg.username,
      userId: msg.userId,
      message: msg.message,
      attachment: msg.attachment,
    });

    io.to(project).emit("chatMessage", msg);

    const ext = (path.extname(attachment.filename || "") || "").toLowerCase();
    const isAudio = isAudioLike(String(attachment.mimetype || ""), ext);

    if (isAudio && AUDIO_AUTO_TRANSCRIPT_MESSAGE) {
      const localPath = path.join(UPLOADS_DIR, attachment.storedAs);

      (async () => {
        try {
          const transcript = await transcribeAudioFile(localPath);
          const t = cleanStr(transcript);
          if (t) {
            const tMsg = {
              id: Date.now(),
              ts: Date.now(),
              project,
              username,
              userId,
              message: `${AUDIO_TRANSCRIPT_PREFIX}${t}`,
              meta: { kind: "audio_transcript", attachmentUrl: attachment.url, attachmentName: attachment.filename },
            };

            pushMessage(project, {
              id: tMsg.id,
              ts: tMsg.ts,
              username: tMsg.username,
              userId: tMsg.userId,
              message: tMsg.message,
              meta: tMsg.meta,
            });

            io.to(project).emit("chatMessage", tMsg);

            try { await sensiAnswer({ project, username, userText: t }); }
            catch (e) { logLine("[sensi-audio-transcript]", e?.message || e, e?.stack); emitSensi(project, "⚠️ Erreur Sensi sur transcription."); }
          } else {
            emitSystem(project, `🎙️ Audio reçu (${attachment.filename}) — transcription indisponible.`);
          }

          analyzeFileWithSensi({ project, username, attachment }).catch((e) => logLine("[sensi-file]", e?.message || e, e?.stack));
        } catch (e) {
          logLine("[audio-transcript-flow]", e?.message || e, e?.stack);
          analyzeFileWithSensi({ project, username, attachment }).catch((er) => logLine("[sensi-file]", er?.message || er, er?.stack));
        }
      })();
    } else {
      analyzeFileWithSensi({ project, username, attachment }).catch((e) => logLine("[sensi-file]", e?.message || e, e?.stack));
    }

    res.json({ ok: true, project, attachment });
  } catch (e) {
    logLine("[upload]", e?.message || e, e?.stack);
    res.status(500).json({ ok: false, error: "Upload error" });
  }
});

// ==================================================
// EMIT HELPERS
// ==================================================
function emitSensi(project, text, extra = {}) {
  const msg = {
    id: Date.now(),
    ts: Date.now(),
    project,
    username: "Sensi",
    userId: "sensi",
    message: text,
    ...extra,
  };
  pushMessage(project, {
    id: msg.id,
    ts: msg.ts,
    username: msg.username,
    userId: msg.userId,
    message: msg.message,
    attachment: msg.attachment,
    meta: msg.meta,
  });
  io.to(project).emit("chatMessage", msg);
}
function emitSystem(project, text) {
  io.to(project).emit("systemMessage", { id: Date.now(), ts: Date.now(), project, text });
}

// ==================================================
// DELETE author-only + DELETE ATTACHMENT FILE
// ==================================================
function safeUnlinkUpload(storedAs) {
  const name = cleanStr(storedAs);
  if (!name) return;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return;
  const full = path.join(UPLOADS_DIR, name);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) {
    logLine("[unlink]", e?.message || e);
  }
}

function deleteMessageIfAuthor(project, messageId, requesterUserId) {
  const p = safeProjectKey(project);
  if (!p) return { ok: false, reason: "bad_project" };
  if (!Array.isArray(historyByProject[p])) return { ok: false, reason: "no_history" };

  const idNum = Number(messageId);
  if (!Number.isFinite(idNum)) return { ok: false, reason: "bad_id" };
  const reqId = cleanStr(requesterUserId);
  if (!reqId) return { ok: false, reason: "no_user" };

  const arr = historyByProject[p];
  const idx = arr.findIndex((m) => Number(m?.id) === idNum);
  if (idx === -1) return { ok: false, reason: "not_found" };

  const msg = arr[idx];
  if (cleanStr(msg?.userId) !== reqId) return { ok: false, reason: "not_author" };

  const storedAs = cleanStr(msg?.attachment?.storedAs);
  if (storedAs) safeUnlinkUpload(storedAs);

  arr.splice(idx, 1);
  scheduleHistorySave();
  return { ok: true };
}

// ==================================================
// URL OPEN (Readability) + CACHE
// ==================================================
const cache = new Map(); // key -> { ts, data }
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetchFn(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SensiBot/3.4.1)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function cleanExtractedText(t) {
  return cleanStr(t).replace(/\n{3,}/g, "\n\n").slice(0, WEB_MAX_CHARS_PER_PAGE);
}

function naiveHtmlToText(html) {
  const s = cleanStr(html);
  if (!s) return "";
  return cleanExtractedText(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/p>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
  );
}

async function extractReadableTextFromUrl(url) {
  const u = cleanStr(url);
  if (!u) return { ok: false, url, text: "", title: "" };

  const cacheKey = `page:${u}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetchWithTimeout(u, WEB_PAGE_TIMEOUT_MS);
    if (!resp.ok) {
      const out = { ok: false, url: u, text: "", title: "" };
      cacheSet(cacheKey, out);
      return out;
    }

    const ct = resp.headers.get("content-type") || "";
    const raw = await resp.text().catch(() => "");

    if (!ct.includes("text/html")) {
      const out = { ok: true, url: u, title: "", text: cleanExtractedText(raw) };
      cacheSet(cacheKey, out);
      return out;
    }

    if (!JSDOM || !Readability) {
      const out = { ok: true, url: u, title: "", text: naiveHtmlToText(raw) };
      cacheSet(cacheKey, out);
      return out;
    }

    const dom = new JSDOM(raw, { url: u });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    const title = cleanStr(article?.title) || cleanStr(dom.window.document.title) || "";
    const text = cleanExtractedText(article?.textContent || "");

    const out = { ok: true, url: u, title, text };
    cacheSet(cacheKey, out);
    return out;
  } catch {
    const out = { ok: false, url: u, text: "", title: "" };
    cacheSet(cacheKey, out);
    return out;
  }
}

function chunkText(text, chunkSize = 1400, overlap = 180) {
  const t = cleanStr(text);
  if (!t) return [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    chunks.push(t.slice(i, i + chunkSize));
    i += (chunkSize - overlap);
  }
  return chunks.slice(0, 12);
}

function buildContextFromPages(pages) {
  const blocks = [];
  let srcIndex = 1;

  for (const p of pages) {
    if (!p?.text) continue;
    const title = cleanStr(p.title) || "Source";
    const url = cleanStr(p.url);
    const chunks = chunkText(p.text);
    if (!chunks.length) continue;

    blocks.push({
      source_id: srcIndex,
      title,
      url,
      chunk: chunks[0],
    });

    srcIndex += 1;
    if (srcIndex > 6) break;
  }

  if (!blocks.length) return { contextText: "", sources: [] };

  const contextText = blocks
    .map((b) => `SOURCE [${b.source_id}]\nTitre: ${b.title}\nURL: ${b.url}\nContenu:\n${b.chunk}`)
    .join("\n\n");
  const sources = blocks.map((b) => ({ id: b.source_id, title: b.title, url: b.url }));
  return { contextText, sources };
}

function extractUrlsFromText(text) {
  const t = cleanStr(text);
  if (!t) return [];
  const re = /\bhttps?:\/\/[^\s<>()"]+/gi;
  const found = t.match(re) || [];
  return Array.from(new Set(found.map((u) => u.replace(/[)\].,;!?]+$/g, "")))).slice(0, 10);
}

// ==================================================
// 🔥 TAVILY SEARCH (ALWAYS SEARCH) + CACHE
// ==================================================
async function tavilySearch(query) {
  const q = cleanStr(query);
  if (!q) return { ok: false, provider: "tavily", results: [] };
  if (!hasTavily()) return { ok: false, provider: "tavily", results: [] };

  const cacheKey = `search:tavily:${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const r = await fetchFn("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: q,
        max_results: WEB_SEARCH_MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
      }),
    });

    const j = await r.json().catch(() => ({}));
    const results = Array.isArray(j?.results) ? j.results : [];

    const out = {
      ok: r.ok,
      provider: "tavily",
      results: results.slice(0, WEB_SEARCH_MAX_RESULTS).map((it) => ({
        title: cleanStr(it?.title),
        url: cleanStr(it?.url),
        snippet: cleanStr(it?.content || it?.snippet || "").slice(0, 800),
      })),
    };

    cacheSet(cacheKey, out);
    return out;
  } catch (e) {
    logLine("[tavilySearch]", e?.message || e);
    const out = { ok: false, provider: "tavily", results: [] };
    cacheSet(cacheKey, out);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchContext(searchRes) {
  const results = Array.isArray(searchRes?.results) ? searchRes.results : [];
  if (!results.length) return { contextText: "", sources: [] };

  const blocks = results.slice(0, WEB_SEARCH_MAX_RESULTS).map((r, idx) => ({
    source_id: idx + 1,
    title: cleanStr(r.title) || "Résultat",
    url: cleanStr(r.url),
    snippet: cleanStr(r.snippet),
  }));

  const contextText = blocks
    .map((b) => `SOURCE [${b.source_id}]\nTitre: ${b.title}\nURL: ${b.url}\nExtrait:\n${b.snippet}`)
    .join("\n\n");

  const sources = blocks.map((b) => ({ id: b.source_id, title: b.title, url: b.url }));
  return { contextText, sources };
}

function formatSources(sources) {
  const arr = Array.isArray(sources) ? sources : [];
  if (!arr.length) return "";
  return "\n\nSources:\n" + arr.map((s) => `- ${s.title} — ${s.url}`).join("\n");
}

// ==================================================
// FILE ANALYSIS (docs + images + audio)
// ==================================================
async function extractTextFromFile(localFilePath, mimetype, originalName) {
  const ext = (path.extname(originalName || "") || "").toLowerCase();

  if ((mimetype && mimetype.startsWith("text/")) || isTextLikeExt(ext)) {
    try {
      const raw = fs.readFileSync(localFilePath, "utf8");
      return raw.slice(0, 18000);
    } catch {
      return "";
    }
  }

  if (mimetype === "application/pdf" || ext === ".pdf") {
    const pdfParse = optionalRequire("pdf-parse");
    if (!pdfParse) return "";
    try {
      const buf = fs.readFileSync(localFilePath);
      const out = await pdfParse(buf);
      return String(out?.text || "").slice(0, 18000);
    } catch (e) {
      logLine("[pdf-parse]", e?.message || e);
      return "";
    }
  }

  if (ext === ".docx") {
    const mammoth = optionalRequire("mammoth");
    if (!mammoth) return "";
    try {
      const result = await mammoth.extractRawText({ path: localFilePath });
      return String(result?.value || "").slice(0, 18000);
    } catch (e) {
      logLine("[mammoth]", e?.message || e);
      return "";
    }
  }

  if (ext === ".xlsx") {
    const XLSX = optionalRequire("xlsx");
    if (!XLSX) return "";
    try {
      const wb = XLSX.readFile(localFilePath);
      const sheetName = wb.SheetNames?.[0];
      if (!sheetName) return "";
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws);
      return String(csv || "").slice(0, 18000);
    } catch (e) {
      logLine("[xlsx-read]", e?.message || e);
      return "";
    }
  }

  return "";
}

async function transcribeAudioFile(localFilePath) {
  if (!hasOpenAI()) return "";
  const client = getOpenAIClient();
  try {
    const file = fs.createReadStream(localFilePath);
    const resp = await client.audio.transcriptions.create({
      model: OPENAI_TRANSCRIBE_MODEL,
      file,
      language: AUDIO_TRANSCRIPT_LANGUAGE,
    });
    const text = cleanStr(resp?.text || "");
    return text.slice(0, 18000);
  } catch (e) {
    logLine("[transcribe]", e?.message || e, e?.stack);
    return "";
  }
}

async function analyzeFileWithSensi({ project, username, attachment }) {
  if (!hasOpenAI()) {
    emitSensi(project, `ℹ️ IA non configurée. Fichier reçu : ${attachment.filename}`);
    return;
  }

  const client = getOpenAIClient();
  const mimetype = String(attachment.mimetype || "application/octet-stream");
  const isImage = mimetype.startsWith("image/");
  const ext = (path.extname(attachment.filename || "") || "").toLowerCase();
  const isAudio = isAudioLike(mimetype, ext);

  const localPath = path.join(UPLOADS_DIR, attachment.storedAs);

  let extracted = "";
  if (isAudio) extracted = await transcribeAudioFile(localPath);
  else if (!isImage) extracted = await extractTextFromFile(localPath, mimetype, attachment.filename);

  const system = `
Tu es Sensi.
Tu reçois un fichier uploadé dans un projet.

Tâches:
1) Résumer (3-8 lignes)
2) Points clés (bullet points)
3) Actions recommandées (3-8)
4) Si image: décrire précisément ce que tu vois.
5) Si audio: résume la transcription + extrait les décisions/actions.

IMPORTANT:
- Si tu n'as AUCUN contenu exploitable (extraction/transcription vide), dis-le clairement en 1 phrase,
  puis propose 3 actions concrètes (ex: ré-uploader, autre format).
Réponds en français, concret.
`.trim();

  const parts = [{
    type: "text",
    text:
      `Projet: ${project}\nAuteur upload: ${username}\n` +
      `Fichier: ${attachment.filename}\nType: ${mimetype}\nURL: ${attachment.url}\n\n` +
      (isImage
        ? `Analyse l'image via son URL.`
        : isAudio
          ? `Transcription (si dispo):\n${extracted || "(transcription vide / indisponible)"}\n`
          : `Extrait (si dispo):\n${extracted || "(extraction vide / indisponible)"}\n`),
  }];

  if (isImage) parts.push({ type: "image_url", image_url: { url: attachment.url } });

  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: parts },
    ],
    temperature: 0.2,
    max_tokens: 900,
  });

  const out = cleanStr(completion?.choices?.[0]?.message?.content);
  if (out) emitSensi(project, `🧠 Analyse Sensi — ${attachment.filename}\n\n${out}`);
}

// ==================================================
// SENSI: ALWAYS TAVILY SEARCH + URL OPEN + MEMORY
// ==================================================
function stripActionBlock(text) {
  const t = cleanStr(text);
  const re = /```json\s*([\s\S]*?)\s*```/i;
  const m = t.match(re);
  if (!m) return { cleanText: t, plan: null };
  const cleanText = t.replace(m[0], "").trim();
  return { cleanText, plan: null };
}

async function buildUrlOpenBundle(userText) {
  const urls = extractUrlsFromText(userText);
  const pages = [];
  for (const u of urls.slice(0, 4)) {
    const page = await extractReadableTextFromUrl(u);
    if (page.ok && page.text) pages.push(page);
  }
  return buildContextFromPages(pages);
}

async function maybeExtractAndStoreMemory({ project, username, userText }) {
  const t = cleanStr(userText);
  if (!t) return;
  if (!/(m[ée]morise|souviens[- ]toi|note\s+que|garde\s+en\s+t[êe]te|remember)/i.test(t)) return;
  if (!hasOpenAI()) return;

  const client = getOpenAIClient();
  const sys = `
Tu es un extracteur de faits à mémoriser.
Retourne uniquement un JSON STRICT.
Si rien: {"facts":[]}
Format: {"facts":["...","..."]}
`.trim();

  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: "system", content: sys }, { role: "user", content: `Message: ${t}` }],
    temperature: 0,
    max_tokens: 220,
  });

  const raw = cleanStr(completion?.choices?.[0]?.message?.content);
  if (!raw) return;

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed || !Array.isArray(parsed.facts)) return;

  const added = [];
  for (const f of parsed.facts.slice(0, 5)) {
    const ok = addGlobalFact({ text: f, who: username, project });
    if (ok) added.push(normalizeFactText(f));
  }
  if (added.length) emitSensi(project, `🧠 Mémoire globale mise à jour ✅\n- ${added.join("\n- ")}`);
}

async function sensiAnswer({ project, username, userText }) {
  if (!hasOpenAI()) {
    emitSensi(project, "ℹ️ IA non configurée (OPENAI_API_KEY manquante).");
    return;
  }

  const client = getOpenAIClient();
  const memBlock = renderMemoryBlock();

  // 🔥 ALWAYS TAVILY SEARCH (si configuré)
  let searchContext = "";
  let searchSources = [];
  try {
    if (hasTavily()) {
      const s = await tavilySearch(userText);
      const built = buildSearchContext(s);
      searchContext = built.contextText || "";
      searchSources = built.sources || [];
    }
  } catch (e) {
    logLine("[always-tavily]", e?.message || e);
  }

  // URL-open (si l’utilisateur colle des URLs)
  let urlContext = "";
  let urlSources = [];
  try {
    const urls = extractUrlsFromText(userText);
    if (urls.length) {
      const built = await buildUrlOpenBundle(userText);
      urlContext = built.contextText || "";
      urlSources = built.sources || [];
    }
  } catch (e) {
    logLine("[url-open]", e?.message || e);
  }

  const allSources = [...searchSources, ...urlSources].slice(0, 8);

  const system = `
Tu es Sensi, IA d’assistance dans un chat collaboratif.

Règles:
1) Réponds en français, clair, concret.
2) Utilise prioritairement le contexte WEB fourni (Tavily + extraits).
3) Ne fabrique PAS de sources. Si le web n’apporte rien, dis-le clairement.
4) Ajoute une section "Sources" à la fin si et seulement si des sources sont disponibles.
`.trim();

  const user = `
Projet: ${project}
Auteur: ${username}
Message: ${userText}

Mémoire globale (faits):
${memBlock}

${searchContext ? `\nTAVILY SEARCH:\n${searchContext}\n` : ""}
${urlContext ? `\nURL OPEN (extraits):\n${urlContext}\n` : ""}
`.trim();

  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: 1100,
  });

  const rawOut = cleanStr(completion?.choices?.[0]?.message?.content);
  if (!rawOut) return emitSensi(project, "⚠️ Je n’ai pas pu générer de réponse.");

  const { cleanText } = stripActionBlock(rawOut);
  const final = cleanText + (allSources.length ? formatSources(allSources) : "");
  emitSensi(project, final);

  await maybeExtractAndStoreMemory({ project, username, userText }).catch((e) => logLine("[memory]", e?.message || e));
}

// ==================================================
// PRESENCE + SOCKET EVENTS
// ==================================================
const presence = new Map(); // project -> Map(socketId -> {username,userId})

function getUsers(project) {
  const map = presence.get(project);
  if (!map) return [];
  return Array.from(map.values()).map((v) => v.username).filter(Boolean);
}
function emitPresence(project) {
  io.to(project).emit("presenceUpdate", { project, users: getUsers(project) });
}
function broadcastProjects() {
  io.emit("projectsUpdate", { projects: listProjects() });
}

function normalizeCreatePayload(payload) {
  // accepte {name:"x"} ou "x"
  if (typeof payload === "string") return { name: payload };
  return payload || {};
}
function normalizeJoinPayload(payload) {
  // accepte {project,username,userId} ou "projectName"
  if (typeof payload === "string") return { project: payload };
  return payload || {};
}

io.on("connection", (socket) => {
  logLine("Socket connected:", socket.id);
  socket.data.userId = "";
  socket.data.username = "";
  socket.data.project = "";

  socket.on("getProjects", () => socket.emit("projectsUpdate", { projects: listProjects() }));

  // ✅ compat: "createProject" et "create project"
  const handleCreateProject = (payload, ack) => {
    const { name } = normalizeCreatePayload(payload);
    const n = cleanStr(name);
    if (!isValidProjectName(n)) {
      const err = { message: "Nom invalide (2-50, lettres/chiffres/espaces/_-.)" };
      socket.emit("projectError", err);
      if (typeof ack === "function") ack({ ok: false, ...err });
      return;
    }
    if (projects.includes(n)) {
      const err = { message: "Projet déjà existant." };
      socket.emit("projectError", err);
      if (typeof ack === "function") ack({ ok: false, ...err });
      return;
    }
    projects.push(n);
    projects = Array.from(new Set(projects));
    saveProjectsNow();
    broadcastProjects();
    if (typeof ack === "function") ack({ ok: true, project: n, projects: listProjects() });
  };
  socket.on("createProject", handleCreateProject);
  socket.on("create project", handleCreateProject);

  socket.on("deleteProject", ({ project }) => {
    const p = safeProjectKey(project);
    if (!p) return;
    if (!projects.includes(p)) return socket.emit("projectError", { message: "Projet introuvable." });
    if (projects.length <= 1) return socket.emit("projectError", { message: "Impossible de supprimer le dernier projet." });

    io.to(p).emit("projectDeleted", { project: p });

    if (historyByProject[p]) delete historyByProject[p];
    if (presence.has(p)) presence.delete(p);

    projects = projects.filter((x) => x !== p);
    if (projects.length === 0) projects = ["test"];
    saveProjectsNow();
    writeJSON(HISTORY_FILE, historyByProject);
    broadcastProjects();
  });

  // ✅ compat: joinProject(obj) et joinProject("name")
  socket.on("joinProject", (payload) => {
    const { project, username, userId } = normalizeJoinPayload(payload);

    const p = safeProjectKey(project);
    const u = cleanStr(username) || "Anonyme";
    const uid = cleanStr(userId);

    if (!p) return;
    if (!projects.includes(p)) {
      socket.emit("projectError", { message: `Projet "${p}" inexistant.` });
      socket.emit("projectsUpdate", { projects: listProjects() });
      return;
    }
    if (!uid) return socket.emit("projectError", { message: "Identifiant utilisateur manquant (userId)." });

    socket.data.userId = uid;
    socket.data.username = u;
    socket.data.project = p;

    socket.join(p);

    if (!presence.has(p)) presence.set(p, new Map());
    presence.get(p).set(socket.id, { username: u, userId: uid });

    socket.emit("chatHistory", { project: p, messages: getHistory(p) });
    emitPresence(p);
    emitSystem(p, `👋 ${u} a rejoint ${p}`);
  });

  socket.on("chatMessage", async ({ project, username, userId, message }) => {
    const p = safeProjectKey(project);
    const u = cleanStr(username) || socket.data.username || "Anonyme";
    const uid = cleanStr(userId) || socket.data.userId;
    const m = cleanStr(message);

    if (!p || !m) return;
    if (!projects.includes(p)) return;
    if (!uid) return;

    const msg = { id: Date.now(), ts: Date.now(), project: p, username: u, userId: uid, message: m };
    pushMessage(p, { id: msg.id, ts: msg.ts, username: msg.username, userId: msg.userId, message: msg.message });
    io.to(p).emit("chatMessage", msg);

    try {
      await sensiAnswer({ project: p, username: u, userText: m });
    } catch (e) {
      const code = `sensi_${Date.now().toString(36)}`;
      logLine("[sensi-auto]", code, { message: e?.message, name: e?.name, stack: e?.stack });
      emitSensi(p,
        `⚠️ Erreur Sensi (${code}).\n` +
        `👉 Ouvre /health (AI=enabled?) puis /logs pour le détail.\n` +
        `Causes fréquentes: OPENAI_API_KEY manquante/invalid, modèle invalide, quota, TAVILY_API_KEY manquante.`
      );
    }
  });

  socket.on("deleteMessage", ({ project, messageId, userId }) => {
    const p = safeProjectKey(project);
    const id = Number(messageId);
    const uid = cleanStr(userId) || socket.data.userId;

    if (!p || !Number.isFinite(id)) return;
    if (!projects.includes(p)) return;

    const res = deleteMessageIfAuthor(p, id, uid);
    if (!res.ok) {
      if (res.reason === "not_author") socket.emit("projectError", { message: "Suppression refusée : seul l’auteur peut supprimer ce message." });
      return;
    }
    io.to(p).emit("messageDeleted", { project: p, messageId: id });
  });

  socket.on("disconnect", () => {
    for (const [proj, map] of presence.entries()) {
      if (map.has(socket.id)) {
        map.delete(socket.id);
        emitPresence(proj);
      }
    }
    logLine("Socket disconnected:", socket.id);
  });
});

// ==================================================
// PROCESS + START
// ==================================================
process.on("unhandledRejection", (err) => logLine("[unhandledRejection]", err?.message || err, err?.stack));
process.on("uncaughtException", (err) => logLine("[uncaughtException]", err?.message || err, err?.stack));

process.on("SIGTERM", () => {
  logLine("[SIGTERM] shutting down");
  try {
    saveProjectsNow();
    writeJSON(HISTORY_FILE, historyByProject);
    saveMemoryNow();
  } catch (_) {}
  server.close(() => process.exit(0));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  logLine("🚀 Server running on", PORT);
  logLine("Version:", APP_VERSION);
  logLine("AI:", hasOpenAI() ? "enabled" : "disabled");
  logLine("Models:", { chat: OPENAI_MODEL, transcribe: OPENAI_TRANSCRIBE_MODEL, image: OPENAI_IMAGE_MODEL });
  logLine("Web:", hasTavily() ? "tavily-search + url-open" : "url-open only (tavily not configured)");
  logLine("Audio:", { autoTranscriptMessage: AUDIO_AUTO_TRANSCRIPT_MESSAGE, lang: AUDIO_TRANSCRIPT_LANGUAGE });
});
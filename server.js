




// 
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

/**
 * OPTIONAL DEPENDENCIES (NEVER CRASH ON REQUIRE)
 * ⚠️ Railway crash fix:
 * - Certaines libs (ex: pdf-parse >=2.x) peuvent throw au require() (DOMMatrix not defined).
 * - Ici, on considère ces deps comme "optionnelles": on NE DOIT JAMAIS planter au démarrage.
 */
function optionalRequire(name) {
  try {
    return require(name);
  } catch (e) {
    // soft-fail: don't crash app on optional deps
    const msg = String(e?.message || e || "");
    const code = e?.code;
    if (code === "MODULE_NOT_FOUND") return null;

    // Known runtime crashes in server environments (Railway) for PDF/canvas polyfills:
    if (/DOMMatrix|ImageData|Path2D/i.test(msg)) return null;

    // Also treat any require-time error as optional (safer for prod)
    return null;
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
app.get("/", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
app.get("/client.js", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
app.get("/index.html", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

app.use(express.static(__dirname));

// ==================================================
// CONFIG
// ==================================================
function cleanEnv(v) { return String(v ?? "").trim(); }

const APP_VERSION = process.env.APP_VERSION || "ultra-v3.4.3";
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

// Web search provider (optional)
const WEB_SEARCH_PROVIDER = cleanEnv(process.env.WEB_SEARCH_PROVIDER || "tavily"); // tavily | serpapi
const TAVILY_API_KEY = cleanEnv(process.env.TAVILY_API_KEY || "");
const SERPAPI_KEY = cleanEnv(process.env.SERPAPI_KEY || "");
const WEB_SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 12000);
const WEB_SEARCH_MAX_RESULTS = Number(process.env.WEB_SEARCH_MAX_RESULTS || 6);

// Web URL-open limits
const WEB_PAGE_TIMEOUT_MS = Number(process.env.WEB_PAGE_TIMEOUT_MS || 12000);
const WEB_MAX_CHARS_PER_PAGE = Number(process.env.WEB_MAX_CHARS_PER_PAGE || 14000);

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
function hasOpenAI() { return Boolean(cleanEnv(OPENAI_API_KEY)); }
function getOpenAIClient() { return new OpenAI({ apiKey: OPENAI_API_KEY }); }

function hasWebSearch() {
  if (WEB_SEARCH_PROVIDER === "serpapi") return Boolean(cleanEnv(SERPAPI_KEY));
  return Boolean(cleanEnv(TAVILY_API_KEY));
}
function webModeLabel() {
  if (hasWebSearch()) return `search(${WEB_SEARCH_PROVIDER})`;
  return `url-open only (tavily not configured)`;
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
      // NOTE: pdf-parse est chargé à la demande (et peut être désactivé)
      pdfParse: Boolean(optionalRequire("pdf-parse")),
    },
    models: {
      chat: OPENAI_MODEL,
      transcribe: OPENAI_TRANSCRIBE_MODEL,
      image: OPENAI_IMAGE_MODEL,
    },
    web: webModeLabel(),
    audio: { autoTranscriptMessage: AUDIO_AUTO_TRANSCRIPT_MESSAGE, language: AUDIO_TRANSCRIPT_LANGUAGE },
    logs: { enabled: true, protectedByToken: Boolean(LOGS_TOKEN) },
  });
});

// ✅ compat: certains clients attendent un tableau JSON direct
app.get("/projects", (req, res) => res.json(listProjects()));
// ✅ format “propre” si tu veux l’utiliser côté front moderne
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


// =======================
// Speech-to-text (Firefox fallback)
// POST /transcribe  (multipart/form-data: audio=<file>)
// =======================
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.min(MAX_UPLOAD_BYTES, 12 * 1024 * 1024) },
});

app.post("/transcribe", memUpload.single("audio"), async (req, res) => {
  let tmpPath = null;
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY manquante." });
    if (!req.file) return res.status(400).json({ ok: false, error: "Aucun audio." });

    // Save to /tmp to give the SDK a filename/extension (some formats need it)
    const mime = (req.file.mimetype || "").toLowerCase();
    let ext = "webm";
    if (mime.includes("wav")) ext = "wav";
    else if (mime.includes("mpeg") || mime.includes("mp3")) ext = "mp3";
    else if (mime.includes("mp4") || mime.includes("m4a")) ext = "m4a";
    else if (mime.includes("ogg")) ext = "ogg";

    tmpPath = path.join("/tmp", `sensi_voice_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`);
    await fs.promises.writeFile(tmpPath, req.file.buffer);

    const openai = getOpenAIClient();

    const model = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model,
      language: "fr",
    });

    const text = (result && typeof result === "object" && "text" in result) ? result.text : String(result || "");
    return res.json({ ok: true, text: cleanStr(text) });
  } catch (e) {
    console.error("TRANSCRIBE_ERROR:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    if (tmpPath) {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
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

    // Note: tu peux remettre ici ton flow d'analyse Sensi si tu veux
    res.json({ ok: true, project, attachment });
  } catch (e) {
    logLine("[upload]", e?.message || e, e?.stack);
    res.status(500).json({ ok: false, error: "Upload error" });
  }
});

// ==================================================
// EMIT HELPERS
// ==================================================
function emitSystem(project, text) {
  io.to(project).emit("systemMessage", { id: Date.now(), ts: Date.now(), project, text });
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
  if (typeof payload === "string") return { name: payload };
  return payload || {};
}

io.on("connection", (socket) => {
  logLine("Socket connected:", socket.id);
  socket.data.userId = "";
  socket.data.username = "";
  socket.data.project = "";

  socket.on("getProjects", () => socket.emit("projectsUpdate", { projects: listProjects() }));

  // ✅ createProject({name}) + createProject("name") + alias "create project"
  const handleCreateProject = (payload, ack) => {
    const { name } = normalizeCreatePayload(payload);
    const n = cleanStr(name);

    if (!isValidProjectName(n)) {
      const err = { ok: false, message: "Nom invalide (2-50, lettres/chiffres/espaces/_-.)" };
      socket.emit("projectError", { message: err.message });
      if (typeof ack === "function") ack(err);
      return;
    }
    if (projects.includes(n)) {
      const err = { ok: false, message: "Projet déjà existant." };
      socket.emit("projectError", { message: err.message });
      if (typeof ack === "function") ack(err);
      return;
    }

    projects.push(n);
    projects = Array.from(new Set(projects));
    saveProjectsNow();
    broadcastProjects();

    const ok = { ok: true, project: n, projects: listProjects() };
    if (typeof ack === "function") ack(ok);
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

  socket.on("joinProject", ({ project, username, userId }) => {
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

  socket.on("chatMessage", ({ project, username, userId, message }) => {
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
  logLine("Web:", webModeLabel());
  logLine("Audio:", { autoTranscriptMessage: AUDIO_AUTO_TRANSCRIPT_MESSAGE, lang: AUDIO_TRANSCRIPT_LANGUAGE });
});
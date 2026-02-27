// guibs:/server.js (COMPLET) — CLEAN + Sensi auto-web + upload + delete + presence + projects
"use strict";

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

let OpenAI = null;
try { OpenAI = require("openai"); } catch (_) {}

const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ==================================================
   CONFIG
================================================== */
const APP_VERSION = process.env.APP_VERSION || "dynamic-projects-v6-auto-web";

const STORAGE_DIR = path.join(__dirname, "storage");
const HISTORY_FILE = path.join(STORAGE_DIR, "messages.json");
const PROJECTS_FILE = path.join(STORAGE_DIR, "projects.json");

const UPLOADS_DIR = path.join(__dirname, "uploads");

const MAX_MESSAGES_PER_PROJECT = Number(process.env.MAX_MESSAGES_PER_PROJECT || 200);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 15);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// IA
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

// Web search provider
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const SERPER_ENDPOINT = "https://google.serper.dev/search";

/* ==================================================
   INIT DIRS
================================================== */
function ensureDirs() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify({}, null, 2), "utf8");
  if (!fs.existsSync(PROJECTS_FILE)) fs.writeFileSync(PROJECTS_FILE, JSON.stringify(["Ever"], null, 2), "utf8");
}
ensureDirs();

app.use("/uploads", express.static(UPLOADS_DIR));

/* ==================================================
   STORAGE
================================================== */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("[storage] write failed:", file, e); }
}

let historyByProject = readJSON(HISTORY_FILE, {});
let projects = readJSON(PROJECTS_FILE, ["Ever"]);

if (!Array.isArray(projects) || projects.length === 0) projects = ["Ever"];
projects = Array.from(new Set(projects.map((p) => String(p || "").trim()).filter(Boolean)));
if (projects.length === 0) projects = ["Ever"];

function cleanStr(v) { return String(v ?? "").trim(); }
function safeProjectKey(project) { const p = cleanStr(project); return p ? p.slice(0, 80) : ""; }
function isValidProjectName(name) { return /^[a-zA-Z0-9 _.\-]{2,50}$/.test(name); }
function listProjects() { return projects.slice().sort((a, b) => a.localeCompare(b, "fr")); }
function saveProjects() { writeJSON(PROJECTS_FILE, projects); }
function saveHistoryNow() { writeJSON(HISTORY_FILE, historyByProject); }

let saveTimer = null;
function scheduleHistorySave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveHistoryNow(); }, 400);
}

function getHistory(project) {
  const p = safeProjectKey(project);
  if (!p) return [];
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

// author-only delete
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

  arr.splice(idx, 1);
  scheduleHistorySave();
  return { ok: true };
}

/* ==================================================
   HEALTH + ROUTES
================================================== */
function hasOpenAI() { return Boolean(OpenAI && process.env.OPENAI_API_KEY); }
function hasWeb() { return Boolean(SERPER_API_KEY); }

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || "production",
    version: APP_VERSION,
    ai: hasOpenAI() ? "enabled" : "disabled",
    web: hasWeb() ? "enabled" : "disabled",
  });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/projects", (req, res) => res.json({ ok: true, projects: listProjects() }));

/* ==================================================
   SOCKET.IO INIT (io doit exister avant /upload)
================================================== */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

/* ==================================================
   UPLOAD (HTTP)
================================================== */
function extFromMime(mime, originalName) {
  const fallback = path.extname(originalName || "").slice(0, 10);
  if (fallback) return fallback;
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "application/pdf") return ".pdf";
  return "";
}

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
  fileFilter: (req, file, cb) => {
    const allowedExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf", ".txt", ".md", ".csv", ".docx", ".xlsx"]);
    const ext = (path.extname(file.originalname || "") || "").toLowerCase();
    if (allowedExt.has(ext)) return cb(null, true);

    const allowedMime = new Set([
      "image/png", "image/jpeg", "image/webp",
      "application/pdf",
      "text/plain", "text/markdown", "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
    if (allowedMime.has(file.mimetype)) return cb(null, true);

    cb(new Error("Type de fichier non autorisé."));
  },
});

function emitSensi(project, text, meta = {}) {
  const msg = { id: Date.now(), ts: Date.now(), project, username: "Sensi", userId: "sensi", message: text, meta };
  pushMessage(project, { id: msg.id, ts: msg.ts, username: msg.username, userId: msg.userId, message: msg.message, meta: msg.meta });
  io.to(project).emit("chatMessage", msg);
}

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const project = safeProjectKey(req.body?.project);
    const username = cleanStr(req.body?.username) || "Anonyme";
    const userId = cleanStr(req.body?.userId);

    if (!project || !projects.includes(project)) return res.status(400).json({ ok: false, error: "Projet invalide." });
    if (!userId) return res.status(400).json({ ok: false, error: "userId manquant." });
    if (!req.file) return res.status(400).json({ ok: false, error: "Aucun fichier." });

    const hostBase = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const url = `${hostBase}/uploads/${encodeURIComponent(req.file.filename)}`;

    const attachment = {
      url,
      path: `/uploads/${req.file.filename}`,
      filename: req.file.originalname,
      storedAs: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
    };

    const msg = { id: Date.now(), ts: Date.now(), project, username, userId, message: `📎 ${attachment.filename}`, attachment };

    pushMessage(project, { id: msg.id, ts: msg.ts, username: msg.username, userId: msg.userId, message: msg.message, attachment: msg.attachment });
    io.to(project).emit("chatMessage", msg);

    emitSensi(project, `🧠 Fichier reçu: ${attachment.filename} (analyse auto activée)`);
    res.json({ ok: true, project, attachment });
  } catch (e) {
    console.error("[upload]", e);
    res.status(500).json({ ok: false, error: "Upload error" });
  }
});

/* ==================================================
   WEB SEARCH TOOL (Serper)
================================================== */
async function serperSearch(query, num = 6) {
  if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY missing");
  const q = cleanStr(query);
  if (!q) return [];
  const resp = await fetch(SERPER_ENDPOINT, {
    method: "POST",
    headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q, num }),
  });
  if (!resp.ok) throw new Error(`Serper error: ${resp.status}`);
  const data = await resp.json();
  return (data?.organic || []).slice(0, num).map((r) => ({
    title: r.title || "", link: r.link || "", snippet: r.snippet || "", source: "organic",
  }));
}

function formatSearchResults(results) {
  if (!results || results.length === 0) return "Aucun résultat.";
  return results.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.link}\nRésumé: ${r.snippet}`).join("\n\n");
}

function extractFunctionCallsFromResponses(resp) {
  const out = Array.isArray(resp?.output) ? resp.output : [];
  return out.filter((item) => item && item.type === "function_call");
}

async function sensiRespondToUserMessage({ project, username, userText }) {
  if (!hasOpenAI()) return;

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const tools = [{
    type: "function",
    function: {
      name: "web_search",
      description: "Recherche web si nécessaire (infos récentes, sources officielles).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          num: { type: "integer", default: 6 },
        },
        required: ["query"],
      },
    },
  }];

  const system = `
Tu es Sensi.
Si tu as besoin d'infos récentes/spécifiques non garanties, appelle web_search.
Sinon répond sans web.
Si web_search utilisé: donne une liste de sources (titre + URL).
Réponds en français, actionnable.
`.trim();

  const userPrompt = `Message de ${username} (projet ${project}) : ${userText}`;

  let response = await client.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: system }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    tools,
    tool_choice: "auto",
    max_output_tokens: 350,
  });

  const fnCalls = extractFunctionCallsFromResponses(response);

  if (!fnCalls.length) {
    const out = (response.output_text || "").trim();
    if (out) emitSensi(project, out);
    return;
  }

  const toolOutputs = [];
  for (const call of fnCalls) {
    if (call?.name !== "web_search") continue;

    let args = {};
    try { args = call?.arguments ? JSON.parse(call.arguments) : {}; } catch { args = {}; }

    if (!hasWeb()) {
      toolOutputs.push({ tool_call_id: call.call_id || call.id, output: JSON.stringify({ error: "SERPER_API_KEY missing" }) });
      continue;
    }

    const q = cleanStr(args.query);
    const n = Math.max(1, Math.min(Number(args.num || 6), 8));
    const results = await serperSearch(q, n);

    toolOutputs.push({
      tool_call_id: call.call_id || call.id,
      output: JSON.stringify({ query: q, results, formatted: formatSearchResults(results) }),
    });
  }

  response = await client.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: system }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    tools,
    tool_choice: "auto",
    tool_outputs: toolOutputs,
    max_output_tokens: 450,
  });

  const out = (response.output_text || "").trim();
  if (out) emitSensi(project, out);
}

/* ==================================================
   SOCKET.IO LOGIC
================================================== */
const presence = new Map();
function getUsers(project) {
  const map = presence.get(project);
  if (!map) return [];
  return Array.from(map.values()).map((v) => v.username).filter(Boolean);
}
function emitPresence(project) { io.to(project).emit("presenceUpdate", { project, users: getUsers(project) }); }
function emitSystem(project, text) { io.to(project).emit("systemMessage", { id: Date.now(), ts: Date.now(), project, text }); }
function broadcastProjects() { io.emit("projectsUpdate", { projects: listProjects() }); }

io.on("connection", (socket) => {
  socket.data.userId = "";
  socket.data.username = "";

  socket.on("getProjects", () => socket.emit("projectsUpdate", { projects: listProjects() }));

  socket.on("createProject", ({ name }) => {
    const n = cleanStr(name);
    if (!isValidProjectName(n)) return socket.emit("projectError", { message: "Nom invalide." });
    if (projects.includes(n)) return socket.emit("projectError", { message: "Projet déjà existant." });
    projects.push(n);
    projects = Array.from(new Set(projects));
    saveProjects();
    broadcastProjects();
  });

  socket.on("deleteProject", ({ project }) => {
    const p = safeProjectKey(project);
    if (!p) return;
    if (!projects.includes(p)) return socket.emit("projectError", { message: "Projet introuvable." });
    if (projects.length <= 1) return socket.emit("projectError", { message: "Impossible de supprimer le dernier projet." });

    io.to(p).emit("projectDeleted", { project: p });
    delete historyByProject[p];
    presence.delete(p);

    projects = projects.filter((x) => x !== p);
    saveProjects();
    saveHistoryNow();
    broadcastProjects();
  });

  socket.on("joinProject", ({ project, username, userId }) => {
    const p = safeProjectKey(project);
    const u = cleanStr(username) || "Anonyme";
    const uid = cleanStr(userId);
    if (!p) return;
    if (!projects.includes(p)) return socket.emit("projectError", { message: `Projet "${p}" inexistant.` });
    if (!uid) return socket.emit("projectError", { message: "userId manquant." });

    socket.data.userId = uid;
    socket.data.username = u;

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

    sensiRespondToUserMessage({ project: p, username: u, userText: m }).catch((e) => {
      console.error("[sensi-auto]", e);
      emitSensi(p, "⚠️ Erreur Sensi (voir logs).");
    });
  });

  socket.on("deleteMessage", ({ project, messageId, userId }) => {
    const p = safeProjectKey(project);
    const id = Number(messageId);
    const uid = cleanStr(userId) || socket.data.userId;
    if (!p || !Number.isFinite(id)) return;
    if (!projects.includes(p)) return;

    const res = deleteMessageIfAuthor(p, id, uid);
    if (!res.ok) return;

    io.to(p).emit("messageDeleted", { project: p, messageId: id });
  });

  socket.on("disconnect", () => {
    for (const [proj, map] of presence.entries()) {
      if (map.has(socket.id)) {
        map.delete(socket.id);
        emitPresence(proj);
      }
    }
  });
});

/* ==================================================
   START
================================================== */
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

process.on("SIGTERM", () => {
  try { saveProjects(); saveHistoryNow(); } catch (_) {}
  server.close(() => process.exit(0));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on", PORT);
  console.log("Version:", APP_VERSION);
  console.log("AI:", hasOpenAI() ? "enabled" : "disabled");
  console.log("WEB:", hasWeb() ? "enabled" : "disabled");
});
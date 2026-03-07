
 
 
 
// guibs:/server.js (COMPLET) — ULTRA v3.5.1 — protected global room + socket client local ✅
// Base stable Railway/Socket + IA OpenAI (Responses API) + transcription + génération docx/xlsx/pptx/png
 
"use strict";
 
const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const OpenAI = require("openai");
const { Server } = require("socket.io");
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
const ExcelJS = require("exceljs");
const PptxGenJS = require("pptxgenjs");
 
// =========================
// App
// =========================
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "10mb" }));
app.disable("x-powered-by");
 
// =========================
// Paths & storage
// =========================
const ROOT = __dirname;
const STORAGE_DIR = path.join(ROOT, "storage");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const GENERATED_DIR = path.join(UPLOADS_DIR, "generated");
const INDEX_HTML = path.join(ROOT, "index.html");
const PROJECTS_FILE = path.join(STORAGE_DIR, "projects.json");
const MESSAGES_FILE = path.join(STORAGE_DIR, "messages.json");
const META_FILE = path.join(STORAGE_DIR, "project-meta.json");
const DEFAULT_PROJECT = "global";
 
ensureDir(STORAGE_DIR);
ensureDir(UPLOADS_DIR);
ensureDir(GENERATED_DIR);
 
app.use("/uploads", express.static(UPLOADS_DIR, { fallthrough: true }));
app.use(express.static(ROOT, { fallthrough: true }));
 
// =========================
// AI config
// =========================
const VERSION = "ultra-v3.5.2-ai-workspace-safe-rooms";
const OPENAI_API_KEY = cleanStr(process.env.OPENAI_API_KEY);
const AI_ENABLED = Boolean(OPENAI_API_KEY);
const MODEL_TEXT = cleanStr(process.env.OPENAI_MODEL_TEXT) || "gpt-4.1-mini";
const MODEL_WEB = cleanStr(process.env.OPENAI_MODEL_WEB) || "gpt-5";
const MODEL_IMAGE = cleanStr(process.env.OPENAI_MODEL_IMAGE) || "gpt-4.1-mini";
const MODEL_TRANSCRIBE = cleanStr(process.env.OPENAI_MODEL_TRANSCRIBE) || "gpt-4o-mini-transcribe";
const AI_BOT_NAME = cleanStr(process.env.AI_BOT_NAME) || "Sensi";
 
const openai = AI_ENABLED ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
 
// =========================
// Persistence
// =========================
function normalizeProjects(list) {
  const src = Array.isArray(list) ? list : [];
  const cleaned = [];
  for (const item of src) {
    const p = cleanStr(item);
    if (p && !cleaned.includes(p)) cleaned.push(p);
  }
  if (!cleaned.includes(DEFAULT_PROJECT)) cleaned.unshift(DEFAULT_PROJECT);
  return cleaned;
}
 
let projects = normalizeProjects(loadJson(PROJECTS_FILE, [DEFAULT_PROJECT]));
let messagesByProject = loadJson(MESSAGES_FILE, {});
let projectMeta = loadJson(META_FILE, {}); // { [project]: { latestAttachment, lastGenerated } }
let nextId = computeNextId(messagesByProject);
 
function saveAll() {
  projects = normalizeProjects(projects);
  saveJson(PROJECTS_FILE, projects);
  saveJson(MESSAGES_FILE, messagesByProject);
  saveJson(META_FILE, projectMeta);
}
 
function ensureProjectMeta(project) {
  if (!projectMeta[project]) {
    projectMeta[project] = {
      latestAttachment: null,
      lastGenerated: null,
    };
  }
  return projectMeta[project];
}
 
function ensureDefaultProject() {
  projects = normalizeProjects(projects);
  if (!Array.isArray(messagesByProject[DEFAULT_PROJECT])) {
    messagesByProject[DEFAULT_PROJECT] = [];
  }
  ensureProjectMeta(DEFAULT_PROJECT);
}
 
ensureDefaultProject();
saveAll();
 
// =========================
// Health
// =========================
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    version: VERSION,
    ai: AI_ENABLED ? "enabled" : "disabled",
    ai_model_text: AI_ENABLED ? MODEL_TEXT : null,
    web: AI_ENABLED ? "responses-api + web_search" : "disabled",
    features: {
      transcription: AI_ENABLED,
      file_analysis: AI_ENABLED,
      office_generation: AI_ENABLED,
      image_generation: AI_ENABLED,
    },
  });
});
 
// =========================
// /projects
// =========================
app.get("/projects", (_req, res) => {
  ensureDefaultProject();
  saveAll();
  res.json({ ok: true, projects });
});
 
// =========================
// Uploads
// =========================
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safe = safeFileName(file.originalname || "file");
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});
 
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    const f = req.file;
    if (!f) {
      return res.status(400).json({ ok: false, error: "No file" });
    }
 
    const url = `/uploads/${encodeURIComponent(f.filename)}`;
    const project = cleanStr(req.body?.project);
    const username = cleanStr(req.body?.username) || "Anonyme";
    const userId = cleanStr(req.body?.userId) || "";
 
    if (project) {
      const meta = ensureProjectMeta(project);
      meta.latestAttachment = {
        path: f.path,
        url,
        filename: f.originalname,
        storedName: f.filename,
        mimetype: f.mimetype,
        size: f.size,
        uploadedAt: Date.now(),
        uploadedBy: username,
      };
      saveJson(META_FILE, projectMeta);
 
      const msg = makeMessage({
        project,
        username,
        userId,
        message: `📎 Fichier envoyé: ${f.originalname}`,
        attachment: {
          url,
          filename: f.originalname,
          mimetype: f.mimetype,
          size: f.size,
        },
      });
      pushMessage(project, msg);
      io.to(project).emit("chatMessage", msg);
    }
 
    return res.json({ ok: true, url, filename: f.originalname, mimetype: f.mimetype, size: f.size });
  } catch (e) {
    console.error("🔥 Upload error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
 
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!AI_ENABLED) {
      return res.status(501).json({ ok: false, error: "AI disabled (OPENAI_API_KEY manquante)" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No audio" });
    }
 
    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: MODEL_TRANSCRIBE,
      response_format: "json",
      language: "fr",
    });
 
    return res.json({ ok: true, text: cleanStr(transcript?.text) });
  } catch (e) {
    console.error("🔥 Transcribe error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
 
// =========================
// Root
// =========================
app.get("/", (_req, res) => {
  if (fs.existsSync(INDEX_HTML)) {
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(INDEX_HTML);
  }
  return res.status(200).send("OK (no index.html in build)");
});
 
// =========================
// HTTP + Socket.IO
// =========================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 10 * 1024 * 1024,
  connectTimeout: 45000,
  allowEIO3: false,
  serveClient: true,
});
 
// =========================
// Presence
// =========================
const presenceByProject = new Map();
 
function getPresenceList(project) {
  const map = presenceByProject.get(project);
  if (!map) return [];
  return Array.from(map.values());
}
 
function emitPresence(project) {
  io.to(project).emit("presenceUpdate", { project, users: getPresenceList(project) });
}
 
function presenceJoin(socket, project, username, userId) {
  if (!presenceByProject.has(project)) {
    presenceByProject.set(project, new Map());
  }
  presenceByProject.get(project).set(socket.id, { username, userId });
  emitPresence(project);
}
 
function presenceLeave(socket, project) {
  const map = presenceByProject.get(project);
  if (map) {
    map.delete(socket.id);
    if (map.size === 0) {
      presenceByProject.delete(project);
    }
  }
  emitPresence(project);
}
 
// =========================
// Socket events
// =========================
io.on("connection", (socket) => {
  console.log("🔌 connected", socket.id);
 
  socket.on("getProjects", () => {
    socket.emit("projectsUpdate", { projects });
  });
 
  socket.on("createProject", ({ name } = {}, ack) => {
    const p = cleanStr(name);
    if (!isValidProjectName(p)) {
      const resp = { ok: false, message: "Nom invalide (2-50, lettres/chiffres/espaces/_-.)" };
      if (typeof ack === "function") ack(resp);
      return;
    }
 
    if (!projects.includes(p)) {
      projects.push(p);
      ensureProjectMeta(p);
      saveAll();
    }
    io.emit("projectsUpdate", { projects });
    const resp = { ok: true, project: p, projects };
    if (typeof ack === "function") ack(resp);
  });
 
  socket.on("deleteProject", ({ project } = {}, ack) => {
    const p = cleanStr(project);
    if (!p) {
      if (typeof ack === "function") ack({ ok: false, error: "bad_request", message: "Projet manquant." });
      return;
    }
    if (p === DEFAULT_PROJECT) {
      if (typeof ack === "function") ack({ ok: false, error: "protected_project", message: 'Impossible de supprimer le projet "global".' });
      return;
    }
    if (projects.length <= 1) {
      if (typeof ack === "function") ack({ ok: false, error: "last_project", message: "Impossible de supprimer le dernier projet restant." });
      return;
    }
    if (!projects.includes(p)) {
      if (typeof ack === "function") ack({ ok: false, error: "not_found", message: "Projet introuvable." });
      return;
    }
 
    projects = projects.filter((x) => x !== p);
    delete messagesByProject[p];
    delete projectMeta[p];
    ensureDefaultProject();
    saveAll();
 
    io.to(p).emit("projectDeleted", { project: p, fallbackProject: DEFAULT_PROJECT });
    presenceByProject.delete(p);
    io.emit("projectsUpdate", { projects });
    io.to(p).emit("presenceUpdate", { project: p, users: [] });
 
    if (typeof ack === "function") ack({ ok: true, project: p, projects, fallbackProject: DEFAULT_PROJECT });
  });
 
  socket.on("joinProject", ({ username, project, userId } = {}) => {
    ensureDefaultProject();
    const requested = cleanStr(project);
    const p = projects.includes(requested) ? requested : DEFAULT_PROJECT;
    const u = cleanStr(username) || "Anonyme";
    const uid = cleanStr(userId) || "";
    if (!p) return;
 
    const prev = socket.data.project;
    if (prev && prev !== p) {
      try { socket.leave(prev); } catch {}
      presenceLeave(socket, prev);
    }
 
    socket.data.project = p;
    socket.data.username = u;
    socket.data.userId = uid;
    socket.join(p);
 
    const hist = Array.isArray(messagesByProject[p]) ? messagesByProject[p] : [];
    socket.emit("chatHistory", { project: p, messages: hist });
    if (requested && requested !== p) {
      socket.emit("systemMessage", { project: p, text: `ℹ️ Projet introuvable. Bascule automatique vers "${DEFAULT_PROJECT}".` });
    }
    io.to(p).emit("systemMessage", { project: p, text: `👋 ${u} a rejoint le projet.` });
    presenceJoin(socket, p, u, uid);
  });
 
  socket.on("leaveProject", () => {
    const p = cleanStr(socket.data.project);
    if (!p) return;
    try { socket.leave(p); } catch {}
    presenceLeave(socket, p);
    io.to(p).emit("systemMessage", { project: p, text: `👋 ${socket.data.username || "Un user"} a quitté le projet.` });
    socket.data.project = null;
  });
 
  socket.on("chatMessage", async ({ username, userId, message, project } = {}) => {
    const p = cleanStr(project) || cleanStr(socket.data.project);
    if (!p) return;
 
    const u = cleanStr(username) || cleanStr(socket.data.username) || "Anonyme";
    const uid = cleanStr(userId) || cleanStr(socket.data.userId) || "";
    const msg = cleanStr(message);
    if (!msg) return;
 
    const row = makeMessage({ project: p, username: u, userId: uid, message: msg });
    pushMessage(p, row);
    io.to(p).emit("chatMessage", row);
 
    try {
      if (shouldInvokeAI(msg)) {
        await handleAIRequest({ project: p, username: u, userId: uid, message: msg });
      }
    } catch (e) {
      console.error("🔥 AI request error:", e);
      await emitBotText(p, `⚠️ IA indisponible : ${String(e?.message || e)}`);
    }
  });
 
  socket.on("deleteMessage", ({ project, messageId } = {}, ack) => {
    const p = cleanStr(project) || cleanStr(socket.data.project);
    const mid = Number(messageId);
    if (!p || !Number.isFinite(mid)) {
      if (typeof ack === "function") ack({ ok: false, error: "bad_request" });
      return;
    }
 
    const uid = cleanStr(socket.data.userId);
    const arr = Array.isArray(messagesByProject[p]) ? messagesByProject[p] : [];
    const idx = arr.findIndex((m) => Number(m.id) === mid);
    if (idx === -1) {
      if (typeof ack === "function") ack({ ok: false, error: "not_found" });
      return;
    }
 
    const owner = cleanStr(arr[idx]?.userId);
    if (owner && uid && owner !== uid) {
      if (typeof ack === "function") ack({ ok: false, error: "forbidden" });
      return;
    }
 
    arr.splice(idx, 1);
    messagesByProject[p] = arr;
    saveJson(MESSAGES_FILE, messagesByProject);
    io.to(p).emit("messageDeleted", { project: p, messageId: mid });
    if (typeof ack === "function") ack({ ok: true });
  });
 
  socket.on("disconnect", (reason) => {
    const p = cleanStr(socket.data.project);
    if (p) {
      presenceLeave(socket, p);
      io.to(p).emit("systemMessage", { project: p, text: `💨 ${socket.data.username || "Un user"} s'est déconnecté.` });
    }
    console.log("❌ disconnected", socket.id, reason);
  });
 
  socket.on("error", (err) => {
    console.error("💥 socket error:", socket.id, err);
  });
});
 
// =========================
// AI dispatcher
// =========================
function shouldInvokeAI(message) {
  const m = cleanStr(message).toLowerCase();
  if (!m) return false;
  return (
    m.startsWith("@sensi") ||
    m.startsWith("/ai") ||
    m.startsWith("/web") ||
    m.startsWith("/analyze") ||
    m.startsWith("/analyse") ||
    m.startsWith("/docx") ||
    m.startsWith("/xlsx") ||
    m.startsWith("/pptx") ||
    m.startsWith("/image") ||
    m.startsWith("/help")
  );
}
 
async function handleAIRequest({ project, username, userId, message }) {
  if (!AI_ENABLED) {
    await emitBotText(project, "🔒 IA désactivée : ajoute OPENAI_API_KEY dans Railway > Variables, puis redeploy.");
    return;
  }
 
  const raw = cleanStr(message);
  const lower = raw.toLowerCase();
 
  if (lower === "/help" || lower === "@sensi /help" || lower === "@sensi help") {
    await emitBotText(project,
      "Commandes IA :\n" +
      "• @sensi <question> : réponse IA générale\n" +
      "• /web <question> : recherche web avec sources\n" +
      "• /analyze : analyse le dernier fichier du projet\n" +
      "• /docx <brief> : génère un Word\n" +
      "• /xlsx <brief> : génère un Excel\n" +
      "• /pptx <brief> : génère un PowerPoint\n" +
      "• /image <brief> : génère une image PNG"
    );
    return;
  }
 
  if (lower.startsWith("/web ")) {
    const query = cleanStr(raw.slice(5));
    const answer = await askAIWithWeb(query);
    await emitBotText(project, answer.text);
    return;
  }
 
  if (lower === "/analyze" || lower === "/analyse" || lower.startsWith("/analyze ") || lower.startsWith("/analyse ")) {
    const meta = ensureProjectMeta(project);
    if (!meta.latestAttachment?.path) {
      await emitBotText(project, "📎 Aucun fichier récent à analyser dans ce projet.");
      return;
    }
    const answer = await analyzeProjectFile(project, raw);
    await emitBotText(project, answer.text);
    return;
  }
 
  if (lower.startsWith("/docx ")) {
    const brief = cleanStr(raw.slice(6));
    const generated = await generateDocxForProject(project, brief, username);
    await emitGeneratedFile(project, generated, "📄 Document Word généré.");
    return;
  }
 
  if (lower.startsWith("/xlsx ")) {
    const brief = cleanStr(raw.slice(6));
    const generated = await generateXlsxForProject(project, brief, username);
    await emitGeneratedFile(project, generated, "📊 Classeur Excel généré.");
    return;
  }
 
  if (lower.startsWith("/pptx ")) {
    const brief = cleanStr(raw.slice(6));
    const generated = await generatePptxForProject(project, brief, username);
    await emitGeneratedFile(project, generated, "📽️ Présentation PowerPoint générée.");
    return;
  }
 
  if (lower.startsWith("/image ")) {
    const brief = cleanStr(raw.slice(7));
    const generated = await generateImageForProject(project, brief, username);
    await emitGeneratedFile(project, generated, "🖼️ Image générée.");
    return;
  }
 
  const prompt = raw.startsWith("@sensi") ? cleanStr(raw.replace(/^@sensi\s*/i, "")) : cleanStr(raw.replace(/^\/ai\s*/i, ""));
  const answer = await askAIText(prompt, { project, username, userId });
  await emitBotText(project, answer.text);
}
 
async function askAIText(prompt, ctx = {}) {
  const system = [
    "Tu es Sensi, une assistante professionnelle intégrée à un espace collaboratif temps réel.",
    "Réponds en français, de manière claire, utile et opérationnelle.",
    "Quand l'utilisateur demande un livrable, structure ta réponse pour être directement exploitable.",
    `Projet courant : ${ctx.project || "inconnu"}.`,
    `Utilisateur courant : ${ctx.username || "inconnu"}.`,
  ].join(" ");
 
  const response = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: system,
    input: prompt,
  });
 
  return { text: cleanStr(response.output_text) || "(aucune réponse)" };
}
 
async function askAIWithWeb(prompt) {
  const response = await openai.responses.create({
    model: MODEL_WEB,
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    instructions: "Réponds en français. Cite clairement les sources pertinentes à la fin avec leur URL.",
    input: prompt,
  });
 
  let text = cleanStr(response.output_text) || "(aucune réponse)";
  const sources = collectWebSources(response.output || []);
  if (sources.length) {
    text += "\n\nSources :\n" + sources.map((s) => `- ${s.title || s.url} — ${s.url}`).join("\n");
  }
  return { text };
}
 
async function analyzeProjectFile(project, userPrompt) {
  const meta = ensureProjectMeta(project);
  const att = meta.latestAttachment;
  const fileId = await uploadFileToOpenAI(att.path, att.filename, att.mimetype);
 
  const prompt = [
    `Analyse le fichier \"${att.filename}\" pour un espace collaboratif.`,
    "Donne : 1) résumé exécutif, 2) points clés, 3) risques/incohérences éventuels, 4) actions recommandées.",
    `Consigne utilisateur complémentaire : ${userPrompt}`,
    "Réponds en français, de façon exploitable et professionnelle.",
  ].join("\n");
 
  const response = await openai.responses.create({
    model: MODEL_TEXT,
    input: [
      { role: "user", content: [
        { type: "input_text", text: prompt },
        { type: "input_file", file_id: fileId },
      ] },
    ],
  });
 
  return { text: cleanStr(response.output_text) || `Analyse terminée pour ${att.filename}.` };
}
 
async function generateDocxForProject(project, brief, username) {
  const spec = await askForStructuredJson(
    [
      "Tu prépares le contenu d'un document Word professionnel.",
      "Retourne uniquement un JSON valide avec cette structure :",
      '{"title":"...","subtitle":"...","sections":[{"heading":"...","bullets":["..."],"paragraph":"..."}]}',
      "4 à 6 sections maximum. Français. Pas de markdown.",
      `Brief : ${brief}`,
    ].join("\n")
  );
 
  const title = cleanStr(spec.title) || "Document Sensi";
  const subtitle = cleanStr(spec.subtitle) || `Projet ${project}`;
  const sections = Array.isArray(spec.sections) ? spec.sections : [];
 
  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          heading: HeadingLevel.TITLE,
          spacing: { after: 180 },
          children: [new TextRun({ text: title, bold: true })],
        }),
        new Paragraph({
          spacing: { after: 260 },
          children: [new TextRun({ text: subtitle, italics: true })],
        }),
        ...sections.flatMap((section) => {
          const items = [];
          const heading = cleanStr(section?.heading);
          const paragraph = cleanStr(section?.paragraph);
          const bullets = Array.isArray(section?.bullets) ? section.bullets : [];
          if (heading) items.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: heading, spacing: { before: 220, after: 120 } }));
          if (paragraph) items.push(new Paragraph({ text: paragraph, spacing: { after: 100 } }));
          for (const bullet of bullets) {
            const txt = cleanStr(bullet);
            if (!txt) continue;
            items.push(new Paragraph({ text: txt, bullet: { level: 0 }, spacing: { after: 60 } }));
          }
          return items;
        }),
      ],
    }],
  });
 
  const buffer = await Packer.toBuffer(doc);
  const safe = `${Date.now()}_${safeFileName(title)}.docx`;
  const full = path.join(GENERATED_DIR, safe);
  fs.writeFileSync(full, buffer);
  return buildGeneratedAttachment(project, full, `/uploads/generated/${encodeURIComponent(safe)}`, `${title}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", username);
}
 
async function generateXlsxForProject(project, brief, username) {
  const spec = await askForStructuredJson(
    [
      "Tu prépares le contenu d'un classeur Excel professionnel.",
      "Retourne uniquement un JSON valide avec cette structure :",
      '{"title":"...","columns":["Colonne 1","Colonne 2","Colonne 3"],"rows":[["...","...","..."]]}',
      "6 à 12 lignes utiles. Français. Pas de markdown.",
      `Brief : ${brief}`,
    ].join("\n")
  );
 
  const wb = new ExcelJS.Workbook();
  wb.creator = AI_BOT_NAME;
  wb.created = new Date();
  const ws = wb.addWorksheet("Sensi");
 
  const title = cleanStr(spec.title) || "Synthèse";
  const columns = (Array.isArray(spec.columns) && spec.columns.length ? spec.columns : ["Élément", "Détail", "Action"]).map((x) => cleanStr(x) || "Colonne");
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
 
  ws.mergeCells(1, 1, 1, columns.length);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 16 };
  ws.getCell(1, 1).alignment = { vertical: "middle", horizontal: "left" };
 
  ws.addRow([]);
  const header = ws.addRow(columns);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };
    cell.border = thinBorder();
  });
 
  for (const row of rows) {
    const data = Array.isArray(row) ? row.map((x) => cleanStr(x)) : columns.map(() => "");
    const added = ws.addRow(data);
    added.alignment = { vertical: "top", wrapText: true };
    added.eachCell((cell) => { cell.border = thinBorder(); });
  }
 
  ws.columns.forEach((col, idx) => {
    const maxLen = Math.max(columns[idx]?.length || 10, 18);
    col.width = Math.min(Math.max(maxLen + 4, 18), 34);
  });
 
  const safe = `${Date.now()}_${safeFileName(title)}.xlsx`;
  const full = path.join(GENERATED_DIR, safe);
  await wb.xlsx.writeFile(full);
  return buildGeneratedAttachment(project, full, `/uploads/generated/${encodeURIComponent(safe)}`, `${title}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", username);
}
 
async function generatePptxForProject(project, brief, username) {
  const spec = await askForStructuredJson(
    [
      "Tu prépares le contenu d'une présentation PowerPoint professionnelle.",
      "Retourne uniquement un JSON valide avec cette structure :",
      '{"title":"...","slides":[{"title":"...","bullets":["...","..."]}]}',
      "4 à 6 slides maximum, 3 à 5 bullets par slide. Français. Pas de markdown.",
      `Brief : ${brief}`,
    ].join("\n")
  );
 
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = AI_BOT_NAME;
  pptx.subject = project;
  pptx.title = cleanStr(spec.title) || "Présentation Sensi";
  pptx.company = "Sensi Collaboration";
  pptx.lang = "fr-FR";
 
  const title = cleanStr(spec.title) || "Présentation Sensi";
  const first = pptx.addSlide();
  first.addText(title, { x: 0.6, y: 0.8, w: 11.4, h: 0.8, fontSize: 24, bold: true, color: "1F2937" });
  first.addText(`Projet : ${project}`, { x: 0.6, y: 1.7, w: 7.5, h: 0.4, fontSize: 12, color: "4B5563" });
  first.addShape(pptx.ShapeType.rect, { x: 0.6, y: 2.2, w: 5.2, h: 0.12, line: { color: "7C3AED", pt: 1 }, fill: { color: "7C3AED" } });
 
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  for (const slideSpec of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: "F8FAFC" };
    slide.addText(cleanStr(slideSpec?.title) || "Slide", { x: 0.6, y: 0.5, w: 11.2, h: 0.6, fontSize: 22, bold: true, color: "111827" });
    const bullets = Array.isArray(slideSpec?.bullets) ? slideSpec.bullets.map((b) => ({ text: cleanStr(b) || "•" })) : [{ text: "Contenu à compléter" }];
    slide.addText(bullets, {
      x: 0.9,
      y: 1.4,
      w: 11.0,
      h: 4.8,
      fontSize: 18,
      color: "1F2937",
      bullet: { indent: 18 },
      breakLine: true,
      paraSpaceAfterPt: 12,
    });
  }
 
  const safe = `${Date.now()}_${safeFileName(title)}.pptx`;
  const full = path.join(GENERATED_DIR, safe);
  await pptx.writeFile({ fileName: full });
  return buildGeneratedAttachment(project, full, `/uploads/generated/${encodeURIComponent(safe)}`, `${title}.pptx`, "application/vnd.openxmlformats-officedocument.presentationml.presentation", username);
}
 
async function generateImageForProject(project, brief, username) {
  const response = await openai.responses.create({
    model: MODEL_IMAGE,
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" },
    input: `Crée une image professionnelle pour ce brief : ${brief}`,
  });
 
  const img = (response.output || []).find((item) => item.type === "image_generation_call" && item.result);
  if (!img?.result) {
    throw new Error("Aucune image générée par l'API");
  }
 
  const safe = `${Date.now()}_sensi-image.png`;
  const full = path.join(GENERATED_DIR, safe);
  fs.writeFileSync(full, Buffer.from(img.result, "base64"));
  return buildGeneratedAttachment(project, full, `/uploads/generated/${encodeURIComponent(safe)}`, safe, "image/png", username);
}
 
async function askForStructuredJson(prompt) {
  const response = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: "Réponds uniquement avec un JSON valide, sans commentaire avant ou après.",
    input: prompt,
  });
 
  const text = cleanStr(response.output_text);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Impossible de parser le JSON IA");
  }
}
 
async function uploadFileToOpenAI(localPath, filename, mimetype) {
  const uploaded = await openai.files.create({
    purpose: "user_data",
    file: fs.createReadStream(localPath),
  });
  return uploaded.id;
}
 
function collectWebSources(outputItems) {
  const sources = [];
  for (const item of outputItems || []) {
    const actionSources = item?.action?.sources;
    if (Array.isArray(actionSources)) {
      for (const src of actionSources) {
        const url = cleanStr(src?.url);
        if (!url) continue;
        sources.push({ url, title: cleanStr(src?.title) || url });
      }
    }
  }
  const seen = new Set();
  return sources.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  }).slice(0, 8);
}
 
async function emitBotText(project, text) {
  const row = makeMessage({
    project,
    username: AI_BOT_NAME,
    userId: "",
    message: text,
  });
  pushMessage(project, row);
  io.to(project).emit("chatMessage", row);
}
 
async function emitGeneratedFile(project, generated, introText) {
  const row = makeMessage({
    project,
    username: AI_BOT_NAME,
    userId: "",
    message: `${introText} ${generated.attachment.filename}`,
    attachment: generated.attachment,
  });
  pushMessage(project, row);
  io.to(project).emit("chatMessage", row);
 
  const meta = ensureProjectMeta(project);
  meta.lastGenerated = generated.attachment;
  saveJson(META_FILE, projectMeta);
}
 
function buildGeneratedAttachment(project, fullPath, url, filename, mimetype, requestedBy) {
  const attachment = {
    url,
    filename,
    mimetype,
    size: safeStatSize(fullPath),
  };
  return { project, fullPath, attachment, requestedBy };
}
 
// =========================
// SPA fallback
// =========================
app.get("*", (req, res) => {
  if (req.path.startsWith("/uploads/")) {
    return res.status(404).end();
  }
  if (fs.existsSync(INDEX_HTML)) {
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(INDEX_HTML);
  }
  return res.status(404).json({ ok: false, error: "not_found", path: req.path });
});
 
app.use((err, _req, res, _next) => {
  console.error("🔥 Express error:", err);
  res.status(500).json({ ok: false, error: "server_error", detail: String(err?.message || err) });
});
 
// =========================
// Helpers
// =========================
function cleanStr(v) {
  return String(v ?? "").trim();
}
 
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}
 
function isValidProjectName(name) {
  return /^[a-zA-Z0-9 _\.\-]{2,50}$/.test(cleanStr(name));
}
 
function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    return data ?? fallback;
  } catch {
    return fallback;
  }
}
 
function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("💥 saveJson error:", file, e);
  }
}
 
function computeNextId(allMessages) {
  try {
    let maxId = 0;
    for (const arr of Object.values(allMessages || {})) {
      if (!Array.isArray(arr)) continue;
      for (const msg of arr) {
        const id = Number(msg?.id);
        if (Number.isFinite(id) && id > maxId) maxId = id;
      }
    }
    return maxId + 1;
  } catch {
    return 1;
  }
}
 
function makeMessage({ project, username, userId, message, attachment }) {
  return {
    id: nextId++,
    ts: Date.now(),
    project: cleanStr(project),
    username: cleanStr(username) || "Anonyme",
    userId: cleanStr(userId) || "",
    message: cleanStr(message) || "",
    attachment: attachment || null,
  };
}
 
function pushMessage(project, msg) {
  const p = cleanStr(project);
  if (!messagesByProject[p]) messagesByProject[p] = [];
  messagesByProject[p].push(msg);
  if (messagesByProject[p].length > 800) {
    messagesByProject[p] = messagesByProject[p].slice(-800);
  }
  saveJson(MESSAGES_FILE, messagesByProject);
}
 
function safeFileName(name) {
  return String(name || "file")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "file";
}
 
function safeStatSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
 
function thinBorder() {
  return {
    top: { style: "thin", color: { argb: "FFD1D5DB" } },
    left: { style: "thin", color: { argb: "FFD1D5DB" } },
    bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
    right: { style: "thin", color: { argb: "FFD1D5DB" } },
  };
}
 
// =========================
// Listen
// =========================
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on", PORT);
  console.log("Version:", VERSION);
  console.log("AI:", AI_ENABLED ? `enabled (${MODEL_TEXT})` : "disabled");
});
 
// =========================
// Shutdown / safety
// =========================
function shutdown(signal) {
  console.log(`🛑 ${signal} received, shutting down...`);
  try {
    io.close(() => {
      server.close(() => {
        console.log("✅ HTTP/Socket server closed");
        process.exit(0);
      });
    });
    setTimeout(() => {
      console.warn("⚠️ Forced shutdown timeout");
      process.exit(1);
    }, 10000).unref();
  } catch (e) {
    console.error("💥 shutdown error:", e);
    process.exit(1);
  }
}
 
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => console.error("💥 unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("💥 uncaughtException:", e));
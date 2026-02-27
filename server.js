// guibs:/server.js (COMPLET) — ULTRA v2 (Railway-safe) ✅
// Fix: "ReferenceError: express is not defined" + no-cache index/client
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
app.use(express.json({ limit: "3mb" }));

// ✅ anti-cache Railway (évite client.js/index.html "vieux" après deploy)
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
const APP_VERSION = process.env.APP_VERSION || "ultra-v2-web-any-create-files";
const STORAGE_DIR = path.join(__dirname, "storage");
const HISTORY_FILE = path.join(STORAGE_DIR, "messages.json");
const PROJECTS_FILE = path.join(STORAGE_DIR, "projects.json");
const MEMORY_FILE = path.join(STORAGE_DIR, "global_memory.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const GENERATED_DIR = path.join(__dirname, "generated");

const MAX_MESSAGES_PER_PROJECT = Number(process.env.MAX_MESSAGES_PER_PROJECT || 350);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// IA
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// WEB provider (Serper)
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const SERPER_ENDPOINT = "https://google.serper.dev/search";

// Web behavior
const WEB_MAX_RESULTS = Number(process.env.WEB_MAX_RESULTS || 10);
const WEB_FETCH_PAGES = Number(process.env.WEB_FETCH_PAGES || 6);
const WEB_PAGE_TIMEOUT_MS = Number(process.env.WEB_PAGE_TIMEOUT_MS || 12000);
const WEB_MAX_CHARS_PER_PAGE = Number(process.env.WEB_MAX_CHARS_PER_PAGE || 14000);

// Cache
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

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
}
ensureDirs();

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/generated", express.static(GENERATED_DIR));

// ==================================================
// HELPERS
// ==================================================
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("[storage] write failed:", file, e); }
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
function hasWeb() { return Boolean(SERPER_API_KEY); }
function getOpenAIClient() { return new OpenAI({ apiKey: OPENAI_API_KEY }); }

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
    web: hasWeb() ? "enabled" : "disabled",
    deps: {
      jsdom: Boolean(JSDOM),
      readability: Boolean(Readability),
      docx: Boolean(docxPkg),
      exceljs: Boolean(ExcelJS),
      pptxgenjs: Boolean(PptxGenJS),
    },
  });
});

// NOTE: "/" est servi par express.static (index.html) — pas besoin de res.sendFile
app.get("/projects", (req, res) => res.json({ ok: true, projects: listProjects() }));

// ==================================================
// SERVER + SOCKET
// ==================================================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ==================================================
// UPLOAD
// ==================================================
function extFromMime(mime, originalName) {
  const fallback = path.extname(originalName || "").slice(0, 10);
  if (fallback) return fallback;

  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "application/pdf") return ".pdf";
  if (mime === "text/plain") return ".txt";
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
      mimetype: req.file.mimetype,
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

    // best effort analysis
    analyzeFileWithSensi({ project, username, attachment }).catch((e) => console.error("[sensi-file]", e));

    res.json({ ok: true, project, attachment });
  } catch (e) {
    console.error("[upload]", e);
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
// DELETE author-only
// ==================================================
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

// ==================================================
// WEB: CACHE + SEARCH + URL OPEN
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

async function serperSearch(query, num = 10) {
  if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY missing");
  const q = cleanStr(query);
  if (!q) return [];

  const cacheKey = `serper:${q}:${num}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const resp = await fetch(SERPER_ENDPOINT, {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q, num }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Serper error: ${resp.status} ${t}`);
  }

  const data = await resp.json();
  const items = [];
  for (const r of (data?.organic || []).slice(0, num)) {
    items.push({ title: r.title || "", link: r.link || "", snippet: r.snippet || "" });
  }

  cacheSet(cacheKey, items);
  return items;
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SensiBot/2.0)",
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

    // Non HTML -> return as text
    if (!ct.includes("text/html")) {
      const out = { ok: true, url: u, title: "", text: cleanExtractedText(raw) };
      cacheSet(cacheKey, out);
      return out;
    }

    // No jsdom/readability -> degrade
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
  return chunks.slice(0, 18);
}

function buildWebContext(pages) {
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
    if (srcIndex > WEB_FETCH_PAGES) break;
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
// TIME (France)
// ==================================================
function nowInFrance() {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

// ==================================================
// FILE GENERATION HELPERS
// ==================================================
function safeFileName(name, fallback) {
  const base = cleanStr(name) || fallback;
  return base.replace(/[^\w.\- ()]/g, "_").replace(/_{2,}/g, "_").slice(0, 80);
}

// DOCX
async function createDocxFile({ filename, title, paragraphs }) {
  if (!Document || !Packer || !Paragraph || !HeadingLevel || !TextRun) {
    throw new Error("docx package missing (install 'docx')");
  }
  const safe = safeFileName(filename, `document_${Date.now()}.docx`);
  const outPath = path.join(GENERATED_DIR, safe.endsWith(".docx") ? safe : `${safe}.docx`);

  const kids = [];
  if (title) kids.push(new Paragraph({ text: cleanStr(title), heading: HeadingLevel.TITLE }));
  const paras = Array.isArray(paragraphs) ? paragraphs : [];
  for (const p of paras) {
    const text = cleanStr(p);
    if (!text) continue;
    kids.push(new Paragraph({ children: [new TextRun(text)] }));
  }
  if (!kids.length) kids.push(new Paragraph(""));

  const doc = new Document({ sections: [{ properties: {}, children: kids }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
  return { localPath: outPath, relUrl: `/generated/${encodeURIComponent(path.basename(outPath))}` };
}

// XLSX
async function createXlsxFile({ filename, sheets }) {
  if (!ExcelJS) throw new Error("exceljs package missing (install 'exceljs')");
  const safe = safeFileName(filename, `tableur_${Date.now()}.xlsx`);
  const outPath = path.join(GENERATED_DIR, safe.endsWith(".xlsx") ? safe : `${safe}.xlsx`);

  const wb = new ExcelJS.Workbook();
  const arr = Array.isArray(sheets) ? sheets : [{ name: "Feuille1", rows: [] }];

  for (const s of arr.slice(0, 6)) {
    const ws = wb.addWorksheet(cleanStr(s.name) || "Feuille");
    const rows = Array.isArray(s.rows) ? s.rows : [];
    for (const r of rows.slice(0, 2000)) ws.addRow(Array.isArray(r) ? r : [String(r)]);
  }

  await wb.xlsx.writeFile(outPath);
  return { localPath: outPath, relUrl: `/generated/${encodeURIComponent(path.basename(outPath))}` };
}

// PPTX
async function createPptxFile({ filename, slides }) {
  if (!PptxGenJS) throw new Error("pptxgenjs package missing (install 'pptxgenjs')");
  const safe = safeFileName(filename, `presentation_${Date.now()}.pptx`);
  const outPath = path.join(GENERATED_DIR, safe.endsWith(".pptx") ? safe : `${safe}.pptx`);

  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const arr = Array.isArray(slides) ? slides : [];
  if (!arr.length) {
    const s = pptx.addSlide();
    s.addText("Présentation", { x: 0.7, y: 0.6, w: 12, h: 1, fontSize: 34 });
  } else {
    for (const sl of arr.slice(0, 12)) {
      const s = pptx.addSlide();
      const title = cleanStr(sl.title) || "Slide";
      s.addText(title, { x: 0.7, y: 0.5, w: 12, h: 0.8, fontSize: 30 });

      const bullets = Array.isArray(sl.bullets) ? sl.bullets : [];
      const text = bullets.map((b) => `• ${cleanStr(b)}`).filter(Boolean).join("\n");
      if (text) s.addText(text, { x: 0.9, y: 1.5, w: 12, h: 5.0, fontSize: 18 });
    }
  }

  await pptx.writeFile({ fileName: outPath });
  return { localPath: outPath, relUrl: `/generated/${encodeURIComponent(path.basename(outPath))}` };
}

// PNG (OpenAI Images)
async function createPngWithOpenAI({ prompt, filename }) {
  if (!hasOpenAI()) throw new Error("OPENAI_API_KEY missing");
  const client = getOpenAIClient();

  const safe = safeFileName(filename, `image_${Date.now()}.png`);
  const outPath = path.join(GENERATED_DIR, safe.endsWith(".png") ? safe : `${safe}.png`);

  const resp = await client.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    prompt: cleanStr(prompt).slice(0, 1500),
    size: "1024x1024",
  });

  const b64 = resp?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image API did not return b64_json");
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  return { localPath: outPath, relUrl: `/generated/${encodeURIComponent(path.basename(outPath))}` };
}

async function createFilesFromPlan(plan) {
  const created = [];
  const items = Array.isArray(plan?.create_files) ? plan.create_files : [];
  for (const it of items.slice(0, 4)) {
    const type = cleanStr(it.type).toLowerCase();
    try {
      if (type === "docx") {
        const r = await createDocxFile({ filename: it.filename, title: it.title, paragraphs: it.paragraphs });
        created.push({ ...r, kind: "docx", filename: path.basename(r.localPath) });
      } else if (type === "xlsx") {
        const r = await createXlsxFile({ filename: it.filename, sheets: it.sheets });
        created.push({ ...r, kind: "xlsx", filename: path.basename(r.localPath) });
      } else if (type === "pptx") {
        const r = await createPptxFile({ filename: it.filename, slides: it.slides });
        created.push({ ...r, kind: "pptx", filename: path.basename(r.localPath) });
      } else if (type === "png") {
        const r = await createPngWithOpenAI({ filename: it.filename, prompt: it.prompt || it.description || "" });
        created.push({ ...r, kind: "png", filename: path.basename(r.localPath) });
      }
    } catch (e) {
      console.error("[create-file]", type, e);
      created.push({ kind: type || "file", error: String(e?.message || e) });
    }
  }
  return created;
}

// ==================================================
// FILE ANALYSIS (upload) — docs + images
// ==================================================
async function extractTextFromFile(localFilePath, mimetype, originalName) {
  const ext = (path.extname(originalName || "") || "").toLowerCase();

  if (mimetype.startsWith("text/") || [".txt", ".md", ".csv"].includes(ext)) {
    const raw = fs.readFileSync(localFilePath, "utf8");
    return raw.slice(0, 18000);
  }

  if (mimetype === "application/pdf" || ext === ".pdf") {
    const pdfParse = optionalRequire("pdf-parse");
    if (!pdfParse) return "";
    try {
      const buf = fs.readFileSync(localFilePath);
      const out = await pdfParse(buf);
      return String(out?.text || "").slice(0, 18000);
    } catch (e) {
      console.error("[pdf-parse]", e);
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
      console.error("[mammoth]", e);
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
      console.error("[xlsx-read]", e);
      return "";
    }
  }

  return "";
}

async function analyzeFileWithSensi({ project, username, attachment }) {
  if (!hasOpenAI()) {
    emitSensi(project, `ℹ️ IA non configurée. Fichier reçu : ${attachment.filename}`);
    return;
  }

  const client = getOpenAIClient();
  const isImage = String(attachment.mimetype || "").startsWith("image/");
  const localPath = path.join(UPLOADS_DIR, attachment.storedAs);

  let extracted = "";
  if (!isImage) extracted = await extractTextFromFile(localPath, attachment.mimetype, attachment.filename);

  const system = `
Tu es Sensi.
Tu reçois un fichier uploadé dans un projet.

Tâches:
1) Résumer (3-8 lignes)
2) Points clés (bullet points)
3) Actions recommandées (3-8)
4) Si image: décrire précisément ce que tu vois (et si document scanné: extraire ce que tu peux).

Réponds en français, concret.
`.trim();

  const parts = [];
  parts.push({
    type: "text",
    text:
      `Projet: ${project}\nAuteur upload: ${username}\n` +
      `Fichier: ${attachment.filename}\nType: ${attachment.mimetype}\nURL: ${attachment.url}\n\n` +
      (isImage ? `Analyse l'image via son URL.` : `Extrait (si dispo):\n${extracted || "(pas d'extraction dispo)"}\n`),
  });

  if (isImage) parts.push({ type: "image_url", image_url: { url: attachment.url } });

  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: parts },
    ],
    temperature: 0.2,
    max_tokens: 800,
  });

  const out = cleanStr(completion?.choices?.[0]?.message?.content);
  if (out) emitSensi(project, `🧠 Analyse Sensi — ${attachment.filename}\n\n${out}`);
}

// ==================================================
// SENSI: WEB + MEMORY + FILE PLAN
// ==================================================
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

function stripActionBlock(text) {
  const t = cleanStr(text);
  const re = /```json\s*([\s\S]*?)\s*```/i;
  const m = t.match(re);
  if (!m) return { cleanText: t, plan: null };
  const jsonRaw = m[1];
  let plan = null;
  try { plan = JSON.parse(jsonRaw); } catch { plan = null; }
  const cleanText = t.replace(m[0], "").trim();
  return { cleanText, plan };
}

async function buildWebBundle(userText) {
  const urls = extractUrlsFromText(userText);
  const pages = [];

  for (const u of urls.slice(0, 4)) {
    const page = await extractReadableTextFromUrl(u);
    if (page.ok && page.text) pages.push(page);
  }

  if (hasWeb()) {
    const results = await serperSearch(userText, Math.max(6, Math.min(WEB_MAX_RESULTS, 12)));
    const links = results.map((r) => r.link).filter(Boolean);
    for (const u of links.slice(0, WEB_FETCH_PAGES)) {
      if (urls.includes(u)) continue;
      const page = await extractReadableTextFromUrl(u);
      if (page.ok && page.text) pages.push(page);
    }
  }

  return buildWebContext(pages);
}

async function sensiAnswer({ project, username, userText }) {
  if (!hasOpenAI()) {
    emitSensi(project, "ℹ️ IA non configurée (OPENAI_API_KEY manquante).");
    return;
  }

  const low = cleanStr(userText).toLowerCase();
  if (/quelle\s+heure|heure\s+est[- ]il/i.test(low) && /(france|paris|fr)\b/i.test(low)) {
    emitSensi(project, `🕒 En France (Europe/Paris), nous sommes : **${nowInFrance()}**.`);
    return;
  }

  const client = getOpenAIClient();
  const memBlock = renderMemoryBlock();

  let webContext = "";
  let sources = [];
  try {
    const shouldWeb = hasWeb() || extractUrlsFromText(userText).length > 0;
    if (shouldWeb) {
      const built = await buildWebBundle(userText);
      webContext = built.contextText || "";
      sources = built.sources || [];
    }
  } catch (e) {
    console.error("[web-any]", e);
    webContext = "";
    sources = [];
  }

  const system = `
Tu es Sensi, IA d’assistance dans un chat collaboratif.

Règles:
1) Réponds en français, clair, concret.
2) Si tu utilises le Contexte WEB, ajoute une section "Sources" (URLs) à la fin.
3) Ne fabrique pas de sources.
4) Si tu veux créer des fichiers, AJOUTE À LA FIN un bloc unique:

\`\`\`json
{
  "create_files": [
    { "type": "docx|xlsx|pptx|png", "filename": "nom.ext" }
  ]
}
\`\`\`
`.trim();

  const user = `
Projet: ${project}
Auteur: ${username}
Message: ${userText}

Mémoire globale (faits):
${memBlock}

${webContext ? `\nContexte WEB (extraits):\n${webContext}\n` : ""}
`.trim();

  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: 900,
  });

  const rawOut = cleanStr(completion?.choices?.[0]?.message?.content);
  if (!rawOut) {
    emitSensi(project, "⚠️ Je n’ai pas pu générer de réponse.");
    return;
  }

  const { cleanText, plan } = stripActionBlock(rawOut);

  let final = cleanText;
  if (webContext && sources.length && !/(?:^|\n)Sources\s*:/i.test(final)) {
    final += `\n\nSources:\n` + sources.map((s) => `- ${s.title} — ${s.url}`).join("\n");
  }

  if (final) emitSensi(project, final);

  if (plan?.create_files?.length) {
    emitSensi(project, "🛠️ Création de fichier(s) en cours…");
    const created = await createFilesFromPlan(plan);

    for (const c of created) {
      if (c.error) {
        emitSensi(project, `⚠️ Fichier (${c.kind}) non créé: ${c.error}`);
        continue;
      }
      const attachment = {
        url: c.relUrl,
        path: c.relUrl,
        filename: c.filename,
        mimetype:
          c.kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" :
          c.kind === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :
          c.kind === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" :
          c.kind === "png" ? "image/png" : "application/octet-stream",
      };

      const msg = {
        id: Date.now(),
        ts: Date.now(),
        project,
        username: "Sensi",
        userId: "sensi",
        message: `📦 Fichier généré : ${attachment.filename}`,
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
    }
  }

  await maybeExtractAndStoreMemory({ project, username, userText }).catch(() => {});
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

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.data.userId = "";
  socket.data.username = "";
  socket.data.project = "";

  socket.on("getProjects", () => socket.emit("projectsUpdate", { projects: listProjects() }));

  socket.on("createProject", ({ name }) => {
    const n = cleanStr(name);
    if (!isValidProjectName(n)) {
      return socket.emit("projectError", { message: "Nom invalide (2-50, lettres/chiffres/espaces/_-.)" });
    }
    if (projects.includes(n)) return socket.emit("projectError", { message: "Projet déjà existant." });
    projects.push(n);
    projects = Array.from(new Set(projects));
    saveProjectsNow();
    broadcastProjects();
  });

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
      console.error("[sensi-auto]", e);
      emitSensi(p, "⚠️ Erreur Sensi (voir logs).");
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
    console.log("Socket disconnected:", socket.id);
  });
});

// ==================================================
// PROCESS + START
// ==================================================
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

process.on("SIGTERM", () => {
  console.warn("[SIGTERM] shutting down");
  try {
    saveProjectsNow();
    writeJSON(HISTORY_FILE, historyByProject);
    saveMemoryNow();
  } catch (_) {}
  server.close(() => process.exit(0));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on", PORT);
  console.log("Version:", APP_VERSION);
  console.log("AI:", hasOpenAI() ? "enabled" : "disabled");
  console.log("WEB:", hasWeb() ? "enabled" : "disabled");
  console.log("Deps:", {
    jsdom: Boolean(JSDOM),
    readability: Boolean(Readability),
    docx: Boolean(docxPkg),
    exceljs: Boolean(ExcelJS),
    pptxgenjs: Boolean(PptxGenJS),
  });
});
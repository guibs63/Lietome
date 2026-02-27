// guibs:/server.js
"use strict";

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ==================================================
   CONFIG
================================================== */
const APP_VERSION = process.env.APP_VERSION || "dynamic-projects-v3-author-delete";

const STORAGE_DIR = path.join(__dirname, "storage");
const HISTORY_FILE = path.join(STORAGE_DIR, "messages.json");
const PROJECTS_FILE = path.join(STORAGE_DIR, "projects.json");

const MAX_MESSAGES_PER_PROJECT = Number(process.env.MAX_MESSAGES_PER_PROJECT || 200);

/* ==================================================
   STORAGE INIT
================================================== */
function ensureStorage() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
    if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify({}, null, 2), "utf8");
    if (!fs.existsSync(PROJECTS_FILE)) fs.writeFileSync(PROJECTS_FILE, JSON.stringify(["Ever"], null, 2), "utf8");
  } catch (e) {
    console.error("[storage] ensureStorage failed:", e);
  }
}
ensureStorage();

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[storage] write failed:", file, e);
  }
}

let historyByProject = readJSON(HISTORY_FILE, {});
let projects = readJSON(PROJECTS_FILE, ["Ever"]);

if (!Array.isArray(projects) || projects.length === 0) projects = ["Ever"];
projects = Array.from(new Set(projects.map((p) => String(p || "").trim()).filter(Boolean)));
if (projects.length === 0) projects = ["Ever"];

/* ==================================================
   HELPERS
================================================== */
function cleanStr(v) {
  return String(v ?? "").trim();
}

function safeProjectKey(project) {
  const p = cleanStr(project);
  if (!p) return "";
  return p.slice(0, 80);
}

function isValidProjectName(name) {
  return /^[a-zA-Z0-9 _.\-]{2,50}$/.test(name);
}

function listProjects() {
  return projects.slice().sort((a, b) => a.localeCompare(b, "fr"));
}

function saveProjects() {
  writeJSON(PROJECTS_FILE, projects);
}

function saveHistoryNow() {
  writeJSON(HISTORY_FILE, historyByProject);
}

let saveTimer = null;
function scheduleHistorySave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveHistoryNow();
  }, 400);
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

// author-only deletion
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
   HEALTH
================================================== */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || "production",
    version: APP_VERSION,
  });
});

/* ==================================================
   ROUTES
================================================== */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/projects", (req, res) => {
  res.json({ ok: true, projects: listProjects() });
});

/* ==================================================
   SOCKET.IO
================================================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// presence: project -> Map(socketId -> { username, userId })
const presence = new Map();

function getUsers(project) {
  const map = presence.get(project);
  if (!map) return [];
  return Array.from(map.values()).map((v) => v.username).filter(Boolean);
}

function emitPresence(project) {
  io.to(project).emit("presenceUpdate", { project, users: getUsers(project) });
}

function emitSystem(project, text) {
  io.to(project).emit("systemMessage", {
    id: Date.now(),
    ts: Date.now(),
    project,
    text,
  });
}

function broadcastProjects() {
  io.emit("projectsUpdate", { projects: listProjects() });
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.data.userId = "";
  socket.data.username = "";

  // ---- Projects list ----
  socket.on("getProjects", () => {
    socket.emit("projectsUpdate", { projects: listProjects() });
  });

  socket.on("createProject", ({ name }) => {
    const n = cleanStr(name);

    if (!isValidProjectName(n)) {
      socket.emit("projectError", { message: "Nom invalide (2-50, lettres/chiffres/espaces/_-.)" });
      return;
    }
    if (projects.includes(n)) {
      socket.emit("projectError", { message: "Projet déjà existant." });
      return;
    }

    projects.push(n);
    projects = Array.from(new Set(projects));
    saveProjects();
    broadcastProjects();
  });

  socket.on("deleteProject", ({ project }) => {
    const p = safeProjectKey(project);
    if (!p) return;

    if (!projects.includes(p)) {
      socket.emit("projectError", { message: "Projet introuvable." });
      return;
    }
    if (projects.length <= 1) {
      socket.emit("projectError", { message: "Impossible de supprimer le dernier projet." });
      return;
    }

    io.to(p).emit("projectDeleted", { project: p });

    if (historyByProject[p]) delete historyByProject[p];
    if (presence.has(p)) presence.delete(p);

    projects = projects.filter((x) => x !== p);
    if (projects.length === 0) projects = ["Ever"];

    saveProjects();
    saveHistoryNow();
    broadcastProjects();
  });

  // ---- Join ----
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

    if (!uid) {
      socket.emit("projectError", { message: "Identifiant utilisateur manquant (userId)." });
      return;
    }

    socket.data.userId = uid;
    socket.data.username = u;

    socket.join(p);

    if (!presence.has(p)) presence.set(p, new Map());
    presence.get(p).set(socket.id, { username: u, userId: uid });

    socket.emit("chatHistory", { project: p, messages: getHistory(p) });

    emitPresence(p);
    emitSystem(p, `👋 ${u} a rejoint ${p}`);
  });

  // ---- Chat ----
  socket.on("chatMessage", ({ project, username, userId, message }) => {
    const p = safeProjectKey(project);
    const u = cleanStr(username) || socket.data.username || "Anonyme";
    const uid = cleanStr(userId) || socket.data.userId;
    const m = cleanStr(message);

    if (!p || !m) return;
    if (!projects.includes(p)) return;

    if (!uid) {
      socket.emit("projectError", { message: "Identifiant utilisateur manquant (userId)." });
      return;
    }

    const msg = {
      id: Date.now(),
      ts: Date.now(),
      project: p,
      username: u,
      userId: uid,
      message: m,
    };

    pushMessage(p, {
      id: msg.id,
      ts: msg.ts,
      username: msg.username,
      userId: msg.userId,
      message: msg.message,
    });

    io.to(p).emit("chatMessage", msg);
  });

  // ---- Delete message (author-only) ----
  socket.on("deleteMessage", ({ project, messageId, userId }) => {
    const p = safeProjectKey(project);
    const id = Number(messageId);
    const uid = cleanStr(userId) || socket.data.userId;

    if (!p || !Number.isFinite(id)) return;
    if (!projects.includes(p)) return;

    const res = deleteMessageIfAuthor(p, id, uid);

    if (!res.ok) {
      if (res.reason === "not_author") {
        socket.emit("projectError", { message: "Suppression refusée : seul l’auteur peut supprimer ce message." });
      }
      return;
    }

    io.to(p).emit("messageDeleted", { project: p, messageId: id });
  });

  // ---- Disconnect ----
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

/* ==================================================
   SAFETY
================================================== */
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

process.on("SIGTERM", () => {
  console.warn("[SIGTERM] shutting down");
  try {
    saveProjects();
    saveHistoryNow();
  } catch (_) {}
  server.close(() => process.exit(0));
});

/* ==================================================
   START
================================================== */
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on", PORT);
  console.log("Version:", APP_VERSION);
});
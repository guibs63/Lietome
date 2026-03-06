// guibs:/server.js (COMPLET) — ULTRA v3.4.7 — Railway Socket stability + root/SPA fallback + hardening ✅
// Aligné client ULTRA v3.4.5 :
// - joinProject / presenceUpdate / chatMessage / chatHistory / projectsUpdate / createProject / deleteProject / deleteMessage
// - /projects (HTTP) + /upload (HTTP) + /health (HTTP)
// - Rooms Socket.IO = nom du projet (string)
// - Présence temps réel
//
// Ajustements v3.4.7 :
// - Socket.IO plus stable derrière Railway / reverse proxy
// - pingInterval / pingTimeout explicités
// - maxHttpBufferSize augmenté pour éviter certains rejets
// - nettoyage léger / logs plus parlants
// - arrêt propre du process

"use strict";

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

// =========================
// App
// =========================
const app = express();

// Trust proxy (Railway / reverse proxy)
app.set("trust proxy", 1);

// CORS large
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "2mb" }));
app.disable("x-powered-by");

// =========================
// Paths & storage
// =========================
const ROOT = __dirname;
const STORAGE_DIR = path.join(ROOT, "storage");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const INDEX_HTML = path.join(ROOT, "index.html");

ensureDir(STORAGE_DIR);
ensureDir(UPLOADS_DIR);

// Static front + uploads
app.use("/uploads", express.static(UPLOADS_DIR, { fallthrough: true }));
app.use(express.static(ROOT, { fallthrough: true }));

// =========================
// Version / Health
// =========================
const VERSION = "ultra-v3.4.7-socket-stability";

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    version: VERSION,
    ai: "disabled",
    web: "url-open only",
    socket: {
      transports: ["websocket", "polling"],
      pingInterval: 25000,
      pingTimeout: 60000,
    },
  });
});

// =========================
// Simple JSON persistence
// =========================
const PROJECTS_FILE = path.join(STORAGE_DIR, "projects.json");
const MESSAGES_FILE = path.join(STORAGE_DIR, "messages.json");

let projects = loadJson(PROJECTS_FILE, ["test", "Evercell"]);
let messagesByProject = loadJson(MESSAGES_FILE, {}); // { [project]: [messages...] }

// ID monotone in-memory
let nextId = computeNextId(messagesByProject);

function saveAll() {
  saveJson(PROJECTS_FILE, projects);
  saveJson(MESSAGES_FILE, messagesByProject);
}

// =========================
// /projects (client fetch avant socket)
// =========================
app.get("/projects", (_req, res) => {
  res.json({ ok: true, projects });
});

// =========================
// Upload
// =========================
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || "file").replace(/[^\w.\-]+/g, "_");
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

    // Optionnel : push un message chat avec pièce jointe
    const project = cleanStr(req.body?.project);
    const username = cleanStr(req.body?.username) || "Anonyme";
    const userId = cleanStr(req.body?.userId) || "";

    if (project) {
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

    return res.json({
      ok: true,
      url,
      filename: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
    });
  } catch (e) {
    console.error("🔥 Upload error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// Root route explicite
// =========================
app.get("/", (_req, res) => {
  if (fs.existsSync(INDEX_HTML)) {
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(INDEX_HTML);
  }
  return res.status(200).send("OK (no index.html in build)");
});

// =========================
// HTTP Server + Socket.IO
// =========================
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },

  // Important derrière Railway / reverse proxy
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 60000,

  // Laisse un peu de marge pour des payloads socket plus lourds
  maxHttpBufferSize: 10 * 1024 * 1024,

  // Tolérance utile si certains clients sont lents à se reconnecter
  connectTimeout: 45000,

  allowEIO3: false,
  serveClient: false,
});

// =========================
// Presence
// project -> Map(socket.id -> { username, userId })
// =========================
const presenceByProject = new Map();

function getPresenceList(project) {
  const map = presenceByProject.get(project);
  if (!map) return [];
  return Array.from(map.values());
}

function emitPresence(project) {
  io.to(project).emit("presenceUpdate", {
    project,
    users: getPresenceList(project),
  });
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
// Socket events (alignés client)
// =========================
io.on("connection", (socket) => {
  console.log("🔌 connected", socket.id);

  socket.on("getProjects", () => {
    socket.emit("projectsUpdate", { projects });
  });

  socket.on("createProject", ({ name } = {}, ack) => {
    const p = cleanStr(name);

    if (!isValidProjectName(p)) {
      const resp = {
        ok: false,
        message: "Nom invalide (2-50, lettres/chiffres/espaces/_-.)",
      };
      if (typeof ack === "function") ack(resp);
      return;
    }

    if (!projects.includes(p)) {
      projects.push(p);
      saveJson(PROJECTS_FILE, projects);
    }

    io.emit("projectsUpdate", { projects });

    const resp = { ok: true, project: p, projects };
    if (typeof ack === "function") ack(resp);
  });

  socket.on("deleteProject", ({ project } = {}, ack) => {
    const p = cleanStr(project);
    if (!p) {
      if (typeof ack === "function") ack({ ok: false, error: "bad_request" });
      return;
    }

    projects = projects.filter((x) => x !== p);
    delete messagesByProject[p];

    saveAll();

    // Annonce avant purge room
    io.to(p).emit("projectDeleted", { project: p });

    // Purge présence
    presenceByProject.delete(p);

    // Mise à jour globale
    io.emit("projectsUpdate", { projects });
    io.to(p).emit("presenceUpdate", { project: p, users: [] });

    if (typeof ack === "function") ack({ ok: true, project: p });
  });

  socket.on("joinProject", ({ username, project, userId } = {}) => {
    const p = cleanStr(project);
    const u = cleanStr(username) || "Anonyme";
    const uid = cleanStr(userId) || "";

    if (!p) return;

    const prev = socket.data.project;
    if (prev && prev !== p) {
      try {
        socket.leave(prev);
      } catch {}
      presenceLeave(socket, prev);
    }

    socket.data.project = p;
    socket.data.username = u;
    socket.data.userId = uid;

    socket.join(p);

    const hist = Array.isArray(messagesByProject[p]) ? messagesByProject[p] : [];
    socket.emit("chatHistory", { project: p, messages: hist });

    io.to(p).emit("systemMessage", {
      project: p,
      text: `👋 ${u} a rejoint le projet.`,
    });

    presenceJoin(socket, p, u, uid);
  });

  socket.on("leaveProject", () => {
    const p = cleanStr(socket.data.project);
    if (!p) return;

    try {
      socket.leave(p);
    } catch {}

    presenceLeave(socket, p);

    io.to(p).emit("systemMessage", {
      project: p,
      text: `👋 ${socket.data.username || "Un user"} a quitté le projet.`,
    });

    socket.data.project = null;
  });

  socket.on("chatMessage", ({ username, userId, message, project } = {}) => {
    const p = cleanStr(project) || cleanStr(socket.data.project);
    if (!p) return;

    const u = cleanStr(username) || cleanStr(socket.data.username) || "Anonyme";
    const uid = cleanStr(userId) || cleanStr(socket.data.userId) || "";
    const msg = cleanStr(message);

    if (!msg) return;

    const row = makeMessage({
      project: p,
      username: u,
      userId: uid,
      message: msg,
    });

    pushMessage(p, row);
    io.to(p).emit("chatMessage", row);
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
      io.to(p).emit("systemMessage", {
        project: p,
        text: `💨 ${socket.data.username || "Un user"} s'est déconnecté.`,
      });
    }

    console.log("❌ disconnected", socket.id, reason);
  });

  socket.on("error", (err) => {
    console.error("💥 socket error:", socket.id, err);
  });
});

// =========================
// SPA fallback : si index.html existe, on le sert sur tout le reste
// =========================
app.get("*", (req, res) => {
  if (req.path.startsWith("/uploads/")) {
    return res.status(404).end();
  }

  if (fs.existsSync(INDEX_HTML)) {
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(INDEX_HTML);
  }

  return res.status(404).json({
    ok: false,
    error: "not_found",
    path: req.path,
  });
});

// =========================
// Error handler Express
// =========================
app.use((err, _req, res, _next) => {
  console.error("🔥 Express error:", err);
  res.status(500).json({
    ok: false,
    error: "server_error",
    detail: String(err?.message || err),
  });
});

// =========================
// Helpers
// =========================
function cleanStr(v) {
  return String(v ?? "").trim();
}

function isValidProjectName(name) {
  return /^[a-zA-Z0-9 _.\-]{2,50}$/.test(cleanStr(name));
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
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
  if (!messagesByProject[p]) {
    messagesByProject[p] = [];
  }

  messagesByProject[p].push(msg);

  if (messagesByProject[p].length > 600) {
    messagesByProject[p] = messagesByProject[p].slice(-600);
  }

  saveJson(MESSAGES_FILE, messagesByProject);
}

// =========================
// Listen (Railway PORT)
// =========================
const PORT = Number(process.env.PORT || 8080);

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on", PORT);
  console.log("Version:", VERSION);
});

// =========================
// Graceful shutdown
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

// =========================
// Process-level safety logs
// =========================
process.on("unhandledRejection", (e) => {
  console.error("💥 unhandledRejection:", e);
});

process.on("uncaughtException", (e) => {
  console.error("💥 uncaughtException:", e);
});
// guibs:/server.js
"use strict";

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

// ✅ tes fichiers sont à la racine (index.html, client.js, etc.)
app.use(express.static(__dirname));

// ✅ route racine
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// --- DB
if (!process.env.DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL is missing. /projects and /messages will fail.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

function cleanStr(v) {
  return String(v ?? "").trim();
}

// --- Ensure schema aligned with your DBeaver view:
// messages: id, username, content, project, role, created_at, deleted
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      project TEXT NOT NULL,
      role TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE
    );
  `);

  // "soft migrations" (safe even if columns already exist)
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS content TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS role TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`).catch(() => {});
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;`).catch(() => {});
}
ensureSchema().catch((e) => console.error("ensureSchema error:", e));

// --- HEALTH
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    hasDbUrl: Boolean(process.env.DATABASE_URL),
  });
});

// --- REST: projects
app.get("/projects", async (req, res) => {
  try {
    const r = await pool.query("SELECT name FROM projects ORDER BY created_at DESC");
    res.json(r.rows.map((x) => x.name));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load projects" });
  }
});

app.post("/projects", async (req, res) => {
  try {
    const name = cleanStr(req.body?.name);
    if (!name) return res.status(400).json({ error: "Project name required" });

    await pool.query(
      "INSERT INTO projects(name) VALUES($1) ON CONFLICT (name) DO NOTHING",
      [name]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create project" });
  }
});

app.delete("/projects/:name", async (req, res) => {
  try {
    const name = cleanStr(req.params.name);
    if (!name) return res.status(400).json({ error: "Project required" });

    // soft delete messages (keeps history if needed)
    await pool.query("UPDATE messages SET deleted = TRUE WHERE project = $1", [name]);
    await pool.query("DELETE FROM projects WHERE name = $1", [name]);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// --- REST: messages
app.get("/messages", async (req, res) => {
  try {
    const project = cleanStr(req.query.project);
    if (!project) return res.json([]);

    const r = await pool.query(
      `SELECT id, project, username, content AS message, role, created_at
       FROM messages
       WHERE project = $1 AND (deleted IS DISTINCT FROM TRUE)
       ORDER BY id ASC`,
      [project]
    );

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load messages" });
  }
});

// ---- Socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
});

// Presence: project -> Map(socketId -> username)
const presence = new Map();

function getProjectUsers(project) {
  const m = presence.get(project);
  if (!m) return [];
  return Array.from(m.values()).filter(Boolean);
}

function emitPresence(project) {
  io.to(project).emit("presenceUpdate", { project, users: getProjectUsers(project) });
}

function emitSystem(project, text) {
  // not stored in DB: lightweight
  const id = Date.now() + Math.floor(Math.random() * 1000);
  io.to(project).emit("systemMessage", { id, project, text });
}

function removeSocketFromAllPresence(socketId) {
  for (const [proj, map] of presence.entries()) {
    if (map.has(socketId)) {
      const u = map.get(socketId);
      map.delete(socketId);
      if (map.size === 0) presence.delete(proj);
      emitPresence(proj);
      emitSystem(proj, `👋 ${u || "Un utilisateur"} a quitté ${proj === "__GLOBAL__" ? "Global" : proj}`);
    }
  }
}

io.on("connection", (socket) => {
  socket.on("joinProject", ({ project, username }) => {
    const p = cleanStr(project);
    const u = cleanStr(username) || "Anonyme";
    if (!p) return;

    // leave other rooms (keep socket.id)
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }

    // remove from any previous presence
    for (const [proj, map] of presence.entries()) {
      if (map.has(socket.id)) {
        map.delete(socket.id);
        if (map.size === 0) presence.delete(proj);
        emitPresence(proj);
      }
    }

    // join room
    socket.join(p);

    // set presence
    if (!presence.has(p)) presence.set(p, new Map());
    presence.get(p).set(socket.id, u);

    emitPresence(p);
    emitSystem(p, `👋 ${u} a rejoint ${p === "__GLOBAL__" ? "Global" : p}`);
  });

  socket.on("chatMessage", async ({ project, username, message }) => {
    try {
      const p = cleanStr(project);
      const u = cleanStr(username) || "Anonyme";
      const m = cleanStr(message);
      if (!p || !m) return;

      // if user isn't in room (edge case), join it
      if (!socket.rooms.has(p)) socket.join(p);

      const r = await pool.query(
        `INSERT INTO messages(project, username, content, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, project, username, content AS message, role, created_at`,
        [p, u, m, null]
      );

      // ✅ single emission to room => no double display
      io.to(p).emit("chatMessage", r.rows[0]);
    } catch (e) {
      console.error("chatMessage error:", e);
      socket.emit("errorMessage", { error: "Failed to save message" });
    }
  });

  socket.on("deleteMessage", async ({ id, project }) => {
    try {
      const mid = Number(id);
      const p = cleanStr(project);
      if (!Number.isFinite(mid) || !p) return;

      await pool.query("UPDATE messages SET deleted = TRUE WHERE id = $1 AND project = $2", [mid, p]);
      io.to(p).emit("messageDeleted", { id: mid });
    } catch (e) {
      console.error("deleteMessage error:", e);
      socket.emit("errorMessage", { error: "Failed to delete message" });
    }
  });

  socket.on("disconnect", () => {
    removeSocketFromAllPresence(socket.id);
  });
});

// --- 404 JSON for API-ish calls + fallback to index
app.use((req, res) => {
  if (req.path.startsWith("/projects") || req.path.startsWith("/messages")) {
    return res.status(404).json({ error: "Not found", path: req.url });
  }
  return res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));
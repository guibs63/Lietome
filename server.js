const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const OpenAI = require("openai");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

const PORT = process.env.PORT || 8080;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log("✅ OpenAI connected");

// ===== DATABASE =====
const db = new sqlite3.Database("./database.sqlite");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      message TEXT,
      project TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS project_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      filename TEXT,
      filepath TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ===== UPLOAD CONFIG =====
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

// Route upload
app.post("/upload", upload.single("file"), (req, res) => {
  const { project } = req.body;
  const file = req.file;

  if (!file || !project) {
    return res.status(400).send("Missing file or project");
  }

  db.run(
    "INSERT INTO project_files (project, filename, filepath) VALUES (?, ?, ?)",
    [project, file.originalname, file.path],
    () => {
      res.json({ success: true });
    }
  );
});

// Servir fichiers uploadés
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Static
app.use(express.static(path.resolve(".")));

app.get("/", (req, res) => {
  res.sendFile(path.resolve("index.html"));
});

// ===== SOCKET =====
io.on("connection", (socket) => {
  console.log("🟢 User connected");

  socket.on("joinProject", ({ project, username }) => {
    if (!project) return;
    socket.join(project);

    db.all(
      "SELECT * FROM messages WHERE project = ? ORDER BY timestamp ASC",
      [project],
      (err, rows) => {
        if (!err) socket.emit("projectHistory", rows);
      }
    );

    db.all(
      "SELECT * FROM project_files WHERE project = ?",
      [project],
      (err, rows) => {
        if (!err) socket.emit("fileList", rows);
      }
    );
  });

  socket.on("chatMessage", (data) => {
    const { username, message, project } = data;
    if (!username || !message || !project) return;

    db.run(
      "INSERT INTO messages (username, message, project) VALUES (?, ?, ?)",
      [username, message, project],
      function () {
        io.in(project).emit("chatMessage", {
          id: this.lastID,
          username,
          message,
          project,
        });
      }
    );
  });
});

// START
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
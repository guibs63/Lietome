const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;

// ===== OPENAI =====
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
});

// ===== STATIC FILES =====
app.use(express.static(path.resolve(".")));

app.get("/", (req, res) => {
  res.sendFile(path.resolve("index.html"));
});

// ===== SOCKET =====
io.on("connection", (socket) => {
  console.log("User connected");

  // 🔹 Charger liste projets
  socket.on("getProjects", () => {
    db.all("SELECT * FROM projects", (err, rows) => {
      if (!err) socket.emit("projectList", rows);
    });
  });

  // 🔹 Créer projet
  socket.on("createProject", (projectName) => {
    if (!projectName) return;

    db.run(
      "INSERT OR IGNORE INTO projects (name) VALUES (?)",
      [projectName],
      () => {
        db.all("SELECT * FROM projects", (err, rows) => {
          if (!err) io.emit("projectList", rows);
        });
      }
    );
  });

  // 🔹 Rejoindre projet
  socket.on("joinProject", (project) => {
    socket.join(project);

    db.all(
      "SELECT * FROM messages WHERE project = ? ORDER BY timestamp ASC",
      [project],
      (err, rows) => {
        if (!err) socket.emit("projectHistory", rows);
      }
    );
  });

  // 🔹 Message utilisateur
  socket.on("chatMessage", async (data) => {
    const { username, message, project } = data;

    if (!username || !message || !project) return;

    // Enregistrer message utilisateur
    db.run(
      "INSERT INTO messages (username, message, project) VALUES (?, ?, ?)",
      [username, message, project]
    );

    io.to(project).emit("chatMessage", data);

    // ===== SENSI =====
    try {
      db.all(
        "SELECT username, message FROM messages WHERE project = ? ORDER BY timestamp ASC LIMIT 20",
        [project],
        async (err, history) => {
          if (err) return;

          const messages = [
            {
              role: "system",
              content:
                "Tu es Sensi, une IA collaborative intégrée à un projet. Tu aides à structurer, analyser, améliorer les idées.",
            },
            ...history.map((m) => ({
              role: m.username === "Sensi" ? "assistant" : "user",
              content: `${m.username}: ${m.message}`,
            })),
          ];

          const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages,
          });

          const reply = response.choices[0].message.content;

          db.run(
            "INSERT INTO messages (username, message, project) VALUES (?, ?, ?)",
            ["Sensi", reply, project]
          );

          io.to(project).emit("chatMessage", {
            username: "Sensi",
            message: reply,
            project,
          });
        }
      );
    } catch (error) {
      console.error("OpenAI error:", error);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// ===== START =====
server.listen(PORT, () => {
  console.log(`Server running 🚀 on port ${PORT}`);
});
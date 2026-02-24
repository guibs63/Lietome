const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 8080;

// =======================
// DATABASE
// =======================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// =======================
// OPENAI
// =======================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// =======================
// SOCKET.IO
// =======================

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // =======================
  // JOIN PROJECT ROOM
  // =======================

  socket.on("join project", async ({ project }) => {
    socket.join(project);
    socket.project = project;

    console.log(`Socket ${socket.id} joined project ${project}`);

    try {
      const result = await pool.query(
        `SELECT * FROM messages
         WHERE project = $1
         ORDER BY created_at ASC
         LIMIT 100`,
        [project]
      );

      socket.emit("chat history", result.rows);

    } catch (err) {
      console.error("History load error:", err);
    }
  });

  // =======================
  // MESSAGE WITH MEMORY
  // =======================

  socket.on("chat message", async (data) => {
    const { username, message, project } = data;

    try {
      // 1️⃣ Save user message
      await pool.query(
        "INSERT INTO messages (username, content, project, role) VALUES ($1,$2,$3,$4)",
        [username, message, project, "user"]
      );

      // 2️⃣ Fetch last 20 messages of this project
      const historyResult = await pool.query(
        `SELECT role, content
         FROM messages
         WHERE project = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [project]
      );

      const previousMessages = historyResult.rows
        .reverse()
        .map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        }));

      // 3️⃣ Generate AI response with memory
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are Sensi, AI assistant for project ${project}.
            You remember previous discussions of this project and respond coherently.`,
          },
          ...previousMessages,
        ],
      });

      const reply = completion.choices[0].message.content;

      // 4️⃣ Save AI reply
      await pool.query(
        "INSERT INTO messages (username, content, project, role) VALUES ($1,$2,$3,$4)",
        ["Sensi", reply, project, "assistant"]
      );

      // 5️⃣ Emit only to project room
      io.to(project).emit("chat message", {
        username: "Sensi",
        message: reply,
        project,
      });

    } catch (err) {
      console.error("Memory AI error:", err);

      socket.emit("chat message", {
        username: "SYSTEM",
        message: "Erreur IA mémoire.",
        project,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// =======================
// START
// =======================

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port " + PORT);
});
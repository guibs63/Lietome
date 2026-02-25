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

pool.query("SELECT NOW()")
  .then(res => console.log("✅ DB CONNECTED:", res.rows[0]))
  .catch(err => console.error("❌ DB ERROR:", err));

// =======================
// OPENAI
// =======================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =======================
// PROJECT CRUD
// =======================

app.get("/projects", async (req, res) => {
  const result = await pool.query(
    "SELECT name FROM projects ORDER BY created_at ASC"
  );
  res.json(result.rows);
});

app.post("/projects", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  try {
    await pool.query(
      "INSERT INTO projects (name) VALUES ($1)",
      [name.trim()]
    );
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: "Project exists" });
  }
});

app.delete("/projects/:name", async (req, res) => {
  const name = req.params.name;

  await pool.query("DELETE FROM messages WHERE project = $1", [name]);
  await pool.query("DELETE FROM projects WHERE name = $1", [name]);

  res.json({ success: true });
});

// =======================
// SOFT DELETE MESSAGE
// =======================

app.delete("/messages/:id", async (req, res) => {
  const { id } = req.params;

  await pool.query(
    "UPDATE messages SET deleted = TRUE WHERE id = $1",
    [id]
  );

  res.json({ success: true });
});

// =======================
// SOCKET.IO
// =======================

io.on("connection", (socket) => {

  console.log("🔌 User connected:", socket.id);

  socket.on("join project", async ({ project }) => {

    if (!project) return;

    socket.join(project);

    const result = await pool.query(
      `SELECT id, username, content, role, project, created_at
       FROM messages
       WHERE project = $1 AND deleted = FALSE
       ORDER BY created_at ASC`,
      [project]
    );

    socket.emit("chat history", result.rows);
  });

  socket.on("chat message", async (data) => {

    const { username, message, project } = data;
    if (!username || !message || !project) return;

    // Save user message
    const insertUser = await pool.query(
      "INSERT INTO messages (username, content, project, role) VALUES ($1,$2,$3,$4) RETURNING id",
      [username, message, project, "user"]
    );

    const userId = insertUser.rows[0].id;

    io.to(project).emit("chat message", {
      id: userId,
      username,
      message,
      project,
    });

    io.to(project).emit("typing", {
      username: "Sensi",
      project,
    });

    // Load memory
    const history = await pool.query(
      `SELECT role, content
       FROM messages
       WHERE project = $1 AND deleted = FALSE
       ORDER BY created_at DESC
       LIMIT 20`,
      [project]
    );

    const previousMessages = history.rows
      .reverse()
      .map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are Sensi, AI assistant for project ${project}.`,
        },
        ...previousMessages,
      ],
    });

    const reply = completion.choices[0].message.content;

    io.to(project).emit("stop typing", { project });

    const insertAI = await pool.query(
      "INSERT INTO messages (username, content, project, role) VALUES ($1,$2,$3,$4) RETURNING id",
      ["Sensi", reply, project, "assistant"]
    );

    const aiId = insertAI.rows[0].id;

    io.to(project).emit("chat message", {
      id: aiId,
      username: "Sensi",
      message: reply,
      project,
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port " + PORT);
});
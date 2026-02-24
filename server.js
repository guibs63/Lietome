const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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

  socket.on("chat message", async (msg) => {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are Sensi, helpful AI assistant." },
          { role: "user", content: msg },
        ],
      });

      const reply = completion.choices[0].message.content;

      io.emit("chat message", reply);
    } catch (err) {
      console.error(err);
      socket.emit("chat message", "Error with AI.");
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// =======================
// START
// =======================

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port " + PORT);
});
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 8080;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("chatMessage", async (data) => {
    const { username, message } = data;

    io.emit("chatMessage", { username, message });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are Sensi." },
        { role: "user", content: message },
      ],
    });

    const reply = completion.choices[0].message.content;

    io.emit("chatMessage", {
      username: "Sensi",
      message: reply,
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port " + PORT);
});
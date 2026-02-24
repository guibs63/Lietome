const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);

const io = new Server(server);

const PORT = process.env.PORT || 8080;

app.use(express.static("public"));

app.get("/ping", (req, res) => {
  res.send("pong");
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("chatMessage", async (data) => {
    console.log("Message reçu:", data);

    io.emit("chatMessage", {
      username: data.username,
      message: data.message,
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Running on " + PORT);
});
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("chatMessage", (data) => {
    io.emit("chatMessage", data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Running on " + PORT);
});
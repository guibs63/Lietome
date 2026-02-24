const socket = io();

const chat = document.getElementById("chat");
const form = document.getElementById("chat-form");
const input = document.getElementById("message");
const usernameInput = document.getElementById("username");
const projectSelect = document.getElementById("project");
const joinBtn = document.getElementById("join");

let currentProject = null;

// =======================
// UI HELPERS
// =======================

function addMessage(username, message, role = "user") {
  const div = document.createElement("div");

  if (role === "assistant") {
    div.innerHTML = `<strong style="color:#7c3aed;">${username}:</strong> ${message}`;
  } else if (role === "system") {
    div.innerHTML = `<strong style="color:#999;">${username}:</strong> ${message}`;
  } else {
    div.innerHTML = `<strong>${username}:</strong> ${message}`;
  }

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function clearChat() {
  chat.innerHTML = "";
}

// =======================
// JOIN PROJECT
// =======================

joinBtn.addEventListener("click", () => {
  const project = projectSelect.value;
  const username = usernameInput.value.trim();

  if (!username) {
    alert("Enter username");
    return;
  }

  if (!project) {
    alert("Select project");
    return;
  }

  currentProject = project;

  clearChat();

  socket.emit("join project", { project });

  addMessage("SYSTEM", `Connecté au projet ${project}`, "system");
});

// =======================
// SEND MESSAGE
// =======================

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const message = input.value.trim();
  const username = usernameInput.value.trim();

  if (!message || !username || !currentProject) return;

  // Affichage immédiat local
  addMessage(username, message, "user");

  socket.emit("chat message", {
    username,
    message,
    project: currentProject,
  });

  input.value = "";
});

// =======================
// RECEIVE MESSAGE
// =======================

socket.on("chat message", (data) => {
  if (!currentProject || data.project !== currentProject) return;

  const role = data.username === "Sensi" ? "assistant" : "user";

  addMessage(data.username, data.message, role);
});

// =======================
// LOAD HISTORY (PAR PROJET)
// =======================

socket.on("chat history", (messages) => {
  clearChat();

  messages.forEach((msg) => {
    const role =
      msg.role === "assistant"
        ? "assistant"
        : msg.role === "system"
        ? "system"
        : "user";

    addMessage(msg.username, msg.content, role);
  });
});

// =======================
// CONNECTION STATUS
// =======================

socket.on("connect", () => {
  console.log("Connected to server");
});

socket.on("disconnect", () => {
  console.log("Disconnected from server");
});
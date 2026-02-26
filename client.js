const socket = io();

const chat = document.getElementById("chat");
const form = document.getElementById("chat-form");
const input = document.getElementById("message");
const usernameInput = document.getElementById("username");
const projectSelect = document.getElementById("project");
const joinBtn = document.getElementById("join-btn");

let currentProject = null;
let typingIndicator = null;

// =======================
// LOAD PROJECTS
// =======================

async function loadProjects() {
  const res = await fetch("/projects");
  const projects = await res.json();

  projectSelect.innerHTML = "";

  projects.forEach(p => {
    const option = document.createElement("option");
    option.value = p.name;
    option.textContent = p.name;
    projectSelect.appendChild(option);
  });

  // 🔥 Auto-select first project
  if (projects.length > 0) {
    currentProject = projects[0].name;
    socket.emit("join project", { project: currentProject });
  }
}

loadProjects();

// =======================
// UI
// =======================

function addMessage(id, username, message, role) {
  const div = document.createElement("div");
  div.dataset.id = id;

  let color = role === "assistant" ? "#7c3aed" : "#000";

  div.innerHTML = `
    <strong style="color:${color}">${username}:</strong> ${message}
    <button data-id="${id}" class="delete-btn">🗑</button>
  `;

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

chat.addEventListener("click", async (e) => {
  if (!e.target.classList.contains("delete-btn")) return;

  const id = e.target.dataset.id;

  await fetch(`/messages/${id}`, { method: "DELETE" });

  const msg = document.querySelector(`[data-id='${id}']`);
  if (msg) msg.remove();
});

// =======================
// JOIN PROJECT
// =======================

// When dropdown changes
projectSelect.addEventListener("change", () => {
  currentProject = projectSelect.value;
  chat.innerHTML = "";
  socket.emit("join project", { project: currentProject });
});

// 🔥 When clicking "Rejoindre"
if (joinBtn) {
  joinBtn.addEventListener("click", () => {
    currentProject = projectSelect.value;
    chat.innerHTML = "";
    socket.emit("join project", { project: currentProject });
  });
}

// =======================
// SEND MESSAGE
// =======================

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const message = input.value.trim();
  const username = usernameInput.value.trim();

  if (!message || !username || !currentProject) return;

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
  if (data.project !== currentProject) return;

  addMessage(
    data.id,
    data.username,
    data.message,
    data.username === "Sensi" ? "assistant" : "user"
  );
});

// =======================
// HISTORY
// =======================

socket.on("chat history", (messages) => {
  chat.innerHTML = "";
  messages.forEach(msg => {
    addMessage(msg.id, msg.username, msg.content, msg.role);
  });
});

// =======================
// TYPING
// =======================

socket.on("typing", (data) => {
  if (data.project !== currentProject) return;

  if (!typingIndicator) {
    typingIndicator = document.createElement("div");
    typingIndicator.innerHTML = "<em>Sensi est en train d'écrire...</em>";
    chat.appendChild(typingIndicator);
  }
});

socket.on("stop typing", () => {
  if (typingIndicator) {
    typingIndicator.remove();
    typingIndicator = null;
  }
});
document.addEventListener("DOMContentLoaded", () => {

  const socket = io();

  let currentProject = null;

  const chat = document.getElementById("chat");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("message");
  const usernameInput = document.getElementById("username");
  const projectSelect = document.getElementById("project");

  if (!chat || !form || !input || !usernameInput || !projectSelect) {
    console.error("❌ DOM elements missing");
    return;
  }

  // 🔹 Affichage message
  function addMessage(username, message) {
    const div = document.createElement("div");
    div.innerHTML = `<strong>${username}:</strong> ${message}`;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // 🔹 Reconnexion automatique
  socket.on("connect", () => {
    console.log("🟢 Connected to server");

    socket.emit("getProjects");

    if (currentProject) {
      socket.emit("joinProject", currentProject);
    }
  });

  // 🔹 Liste projets
  socket.on("projectList", (projects) => {
    console.log("📂 Projects received:", projects);

    projectSelect.innerHTML = "";

    projects.forEach((p) => {
      const option = document.createElement("option");
      option.value = p.name;
      option.textContent = p.name;
      projectSelect.appendChild(option);
    });

    if (projects.length > 0 && !currentProject) {
      currentProject = projects[0].name;
      socket.emit("joinProject", currentProject);
    }
  });

  // 🔹 Changement projet
  projectSelect.addEventListener("change", () => {
    currentProject = projectSelect.value;
    chat.innerHTML = "";
    socket.emit("joinProject", currentProject);
  });

  // 🔹 Historique
  socket.on("projectHistory", (messages) => {
    console.log("📜 History received:", messages);

    chat.innerHTML = "";
    messages.forEach((msg) => {
      addMessage(msg.username, msg.message);
    });
  });

  // 🔹 Message live
  socket.on("chatMessage", (data) => {
    console.log("💬 Live message:", data);
    addMessage(data.username, data.message);
  });

  // 🔹 Envoi message
  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const username = usernameInput.value.trim();
    const message = input.value.trim();

    if (!username || !message || !currentProject) {
      console.warn("⚠ Missing data:", username, message, currentProject);
      return;
    }

    console.log("📤 Sending message:", { username, message, project: currentProject });

    socket.emit("chatMessage", {
      username,
      message,
      project: currentProject,
    });

    input.value = "";
  });

});
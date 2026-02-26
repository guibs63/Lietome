// guibs:/client.js
window.__SENSI_CLIENT_LOADED__ = "projects-ui-fix-v2-dedupe";

const socket = io();
let currentProject = null;

const chat = document.getElementById("chat");
const form = document.getElementById("chat-form");
const input = document.getElementById("message");
const usernameInput = document.getElementById("username");
const projectSelect = document.getElementById("project");

const newProjectInput = document.getElementById("new-project");
const createProjectBtn = document.getElementById("create-project");
const deleteProjectBtn = document.getElementById("delete-project");
const joinBtn = document.getElementById("join");

// ✅ anti-doublons (id DB)
const seenMessageIds = new Set();

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clearChat() {
  chat.innerHTML = "";
  seenMessageIds.clear();
}

function normalizeProjects(payload) {
  // endpoint peut renvoyer: ["test"] OU [{name:"test"}]
  if (!Array.isArray(payload) || payload.length === 0) return [];
  if (typeof payload[0] === "string") return payload.map(String).filter(Boolean);

  if (typeof payload[0] === "object" && payload[0] && "name" in payload[0]) {
    return payload.map((p) => String(p.name)).filter(Boolean);
  }
  return [];
}

function setProjectsInSelect(projectNames) {
  projectSelect.innerHTML = "";

  const list = Array.isArray(projectNames) ? projectNames : [];
  const finalList = list.length ? list : ["test"];

  for (const name of finalList) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    projectSelect.appendChild(opt);
  }

  currentProject = projectSelect.value;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${url} -> ${res.status} ${res.statusText} ${txt}`);
  }
  return res.json();
}

function normalizeMessagePayload(m) {
  // support "message" (nouveau) + "content" (ancien schéma)
  const id = m?.id;
  const username = m?.username ?? "Anonyme";
  const message = m?.message ?? m?.content ?? "";
  const project = m?.project ?? "";
  return { id, username, message, project };
}

function addMessageRow(raw) {
  const { id, username, message } = normalizeMessagePayload(raw);
  if (!id) return;

  // ✅ déduplication
  if (seenMessageIds.has(id)) return;
  seenMessageIds.add(id);

  const row = document.createElement("div");
  row.className = "msg";
  row.dataset.id = id;

  row.innerHTML = `
    <div class="msg-left">
      <strong>${escapeHtml(username)}:</strong> ${escapeHtml(message)}
    </div>
    <div class="msg-right">
      <button class="msg-del" title="Supprimer ce message">🗑</button>
    </div>
  `;

  row.querySelector(".msg-del").addEventListener("click", () => {
    if (!currentProject) return;
    socket.emit("deleteMessage", { id, project: currentProject });
  });

  chat.appendChild(row);
}

async function loadProjects() {
  console.log("[Sensi] loading projects…");
  const raw = await fetchJson("/projects");
  console.log("[Sensi] /projects raw:", raw);

  const list = normalizeProjects(raw);
  console.log("[Sensi] projects normalized:", list);

  setProjectsInSelect(list);
}

async function loadHistory(project) {
  if (!project) return;
  clearChat();

  const messages = await fetchJson(
    `/messages?project=${encodeURIComponent(project)}`
  );

  for (const m of messages) addMessageRow(m);
}

async function joinProject(project) {
  const p = String(project || "").trim();
  if (!p) return;

  // évite de recharger si on rejoint le même projet (optionnel)
  // si tu veux recharger quand même, commente ce bloc
  if (currentProject === p && seenMessageIds.size > 0) {
    socket.emit("joinProject", { project: p });
    return;
  }

  currentProject = p;
  socket.emit("joinProject", { project: p });
  await loadHistory(p);
}

joinBtn?.addEventListener("click", async () => {
  await joinProject(projectSelect.value);
});

projectSelect?.addEventListener("change", async () => {
  await joinProject(projectSelect.value);
});

createProjectBtn?.addEventListener("click", async () => {
  const name = String(newProjectInput.value || "").trim();
  if (!name) return;

  await fetchJson("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  newProjectInput.value = "";
  await loadProjects();

  projectSelect.value = name;
  await joinProject(name);
});

deleteProjectBtn?.addEventListener("click", async () => {
  const p = projectSelect.value;
  if (!p) return;

  await fetch(`/projects/${encodeURIComponent(p)}`, { method: "DELETE" });
  await loadProjects();
  await joinProject(projectSelect.value);
});

form?.addEventListener("submit", (e) => {
  e.preventDefault();

  const username = String(usernameInput.value || "").trim() || "Guibs";
  const message = String(input.value || "").trim();
  const project = String(currentProject || projectSelect.value || "").trim();
  if (!project || !message) return;

  socket.emit("chatMessage", { project, username, message });
  input.value = "";
});

socket.on("chatMessage", (raw) => {
  const msg = normalizeMessagePayload(raw);
  if (msg.project === currentProject) addMessageRow(msg);
});

socket.on("messageDeleted", ({ id }) => {
  if (!id) return;
  seenMessageIds.delete(id);

  const row = chat.querySelector(`.msg[data-id="${id}"]`);
  if (row) row.remove();
});

socket.on("errorMessage", ({ error }) => {
  console.warn("[Sensi] server error:", error);
});

socket.on("connect", () => {
  console.log("[Sensi] socket connected:", socket.id);
  // optionnel: rejoin project on reconnect
  if (currentProject) socket.emit("joinProject", { project: currentProject });
});

socket.on("disconnect", (reason) => {
  console.warn("[Sensi] socket disconnected:", reason);
});

(async function init() {
  if (!projectSelect) {
    console.error("[Sensi] #project not found in DOM");
    return;
  }

  await loadProjects();
  await joinProject(projectSelect.value);
})();
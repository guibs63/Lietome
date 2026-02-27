// guibs:/client.js (COMPLET) — ULTRA v2 (Railway-safe + no-cache server-side)
//
// ✅ Socket: websocket + polling fallback (prod safe)
// ✅ /projects: {ok:true, projects:[...]} OU [...]
// ✅ Pas besoin de version bump (?v=) si tu mets Cache-Control:no-store sur /client.js côté server
// ✅ Upload + delete message author-only + presence

const socket = io(window.location.origin, {
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 600,
  timeout: 20000,
});

/** =========================
 *  FLAGS
 *  ========================= */
const AUTO_JOIN = false; // mets true si tu veux auto-join dès que pseudo + projet dispo

/** =========================
 *  STATE
 *  ========================= */
let currentProject = null;
let currentUsername = null;

const seenMessageIds = new Set();
const messageNodes = new Map();

/** =========================
 *  STORAGE
 *  ========================= */
const LS_USER_ID = "sensi_user_id";
const LS_LAST_USERNAME = "sensi_last_username";
const LS_LAST_PROJECT = "sensi_last_project";

const myUserId = getOrCreateUserId();

/** =========================
 *  DOM
 *  ========================= */
const chat = document.getElementById("chat");
const form = document.getElementById("chat-form");
const input = document.getElementById("message");
const fileInput = document.getElementById("file");
const uploadState = document.getElementById("upload-state");

const usernameInput = document.getElementById("username");
const projectSelect = document.getElementById("project");
const joinBtn = document.getElementById("join-btn");

const newProjectInput = document.getElementById("new-project");
const createProjectBtn = document.getElementById("create-project-btn");
const deleteProjectBtn = document.getElementById("delete-project-btn");

const usersList = document.getElementById("users");
const usersCount = document.getElementById("users-count");
const currentProjectLabel = document.getElementById("current-project-label");

// Sécurité si HTML change
(function assertDom() {
  const required = [
    ["chat", chat],
    ["chat-form", form],
    ["message", input],
    ["username", usernameInput],
    ["project", projectSelect],
    ["join-btn", joinBtn],
  ];
  const missing = required.filter(([, el]) => !el).map(([id]) => id);
  if (missing.length) {
    console.error("DOM missing:", missing);
    alert("Erreur UI: éléments manquants dans index.html : " + missing.join(", "));
    throw new Error("UI DOM missing");
  }
})();

/** =========================
 *  UTILS
 *  ========================= */
function cleanStr(v) { return String(v ?? "").trim(); }

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(ts) {
  try {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function getOrCreateUserId() {
  try {
    const existing = localStorage.getItem(LS_USER_ID);
    if (existing && existing.length >= 8) return existing;

    const uid = (crypto?.randomUUID
      ? crypto.randomUUID()
      : `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`
    );

    localStorage.setItem(LS_USER_ID, uid);
    return uid;
  } catch {
    return `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function saveLastSession() {
  try {
    if (currentUsername) localStorage.setItem(LS_LAST_USERNAME, currentUsername);
    if (currentProject) localStorage.setItem(LS_LAST_PROJECT, currentProject);
  } catch {}
}

function restoreLastSession() {
  try {
    const u = cleanStr(localStorage.getItem(LS_LAST_USERNAME));
    const p = cleanStr(localStorage.getItem(LS_LAST_PROJECT));

    if (u && !cleanStr(usernameInput.value)) usernameInput.value = u;

    return { u, p };
  } catch {
    return { u: "", p: "" };
  }
}

function setProjectLabel(p) {
  if (!currentProjectLabel) return;
  currentProjectLabel.textContent = p || "—";
}

/** =========================
 *  UI
 *  ========================= */
function clearChat() {
  chat.innerHTML = "";
  seenMessageIds.clear();
  messageNodes.clear();
}

function addSystem(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.innerHTML = `<em>🛡️ ${escapeHtml(text)}</em>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function closeAllMenus() {
  document.querySelectorAll(".menu").forEach((m) => m.setAttribute("hidden", ""));
}
document.addEventListener("click", () => closeAllMenus());

function removeMessageFromUI(messageId) {
  const id = Number(messageId);
  if (!Number.isFinite(id)) return;

  const node = messageNodes.get(id);
  if (node && node.parentNode) node.parentNode.removeChild(node);

  messageNodes.delete(id);
  seenMessageIds.delete(id);
}

function renderAttachment(att) {
  if (!att?.url) return "";
  const name = escapeHtml(att.filename || "fichier");
  const url = escapeHtml(att.url);
  const isImg = String(att.mimetype || "").startsWith("image/");

  if (isImg) {
    return `
      <div style="margin-top:6px;">
        <a href="${url}" target="_blank" rel="noopener">🖼️ ${name}</a><br/>
        <img src="${url}" alt="${name}"
             style="max-width:260px; border:1px solid #ddd; border-radius:10px; margin-top:6px;" />
      </div>
    `;
  }

  return `<div style="margin-top:6px;"><a href="${url}" target="_blank" rel="noopener">📄 ${name}</a></div>`;
}

function addMessage({ id, ts, username, userId, message, attachment }) {
  const mid = Number(id);
  if (Number.isFinite(mid) && seenMessageIds.has(mid)) return;
  if (Number.isFinite(mid)) seenMessageIds.add(mid);

  const time = formatTime(ts);
  const isMine = cleanStr(userId) && cleanStr(userId) === cleanStr(myUserId);

  const row = document.createElement("div");
  row.className = "msg msg-row";
  if (Number.isFinite(mid)) row.dataset.mid = String(mid);

  row.innerHTML = `
    <div class="msg-main">
      <span class="time">${time ? `[${time}]` : ""}</span>
      <strong>${escapeHtml(username)}:</strong>
      <span class="text">${escapeHtml(message)}</span>
      ${attachment ? renderAttachment(attachment) : ""}
    </div>

    <div class="msg-actions">
      ${isMine ? `
        <button class="kebab" type="button" title="Options">⋮</button>
        <div class="menu" hidden>
          <button class="menu-item delete" type="button">🗑️ Supprimer</button>
        </div>
      ` : ""}
    </div>
  `;

  if (isMine) {
    const kebab = row.querySelector(".kebab");
    const menu = row.querySelector(".menu");
    const delBtn = row.querySelector(".menu-item.delete");

    kebab.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = menu.hasAttribute("hidden");
      closeAllMenus();
      if (isHidden) menu.removeAttribute("hidden");
    });

    delBtn.addEventListener("click", () => {
      if (!currentProject) return;
      if (!Number.isFinite(mid)) return;
      const ok = confirm("Supprimer ce message ?");
      if (!ok) return;
      socket.emit("deleteMessage", { project: currentProject, messageId: mid, userId: myUserId });
      menu.setAttribute("hidden", "");
    });
  }

  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  if (Number.isFinite(mid)) messageNodes.set(mid, row);
}

function renderUsers(users) {
  const arr = Array.isArray(users) ? users : [];
  if (usersList) usersList.innerHTML = "";
  if (usersCount) usersCount.textContent = String(arr.length);

  if (!usersList) return;

  if (arr.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<span style="color:#666;">Aucun user</span>`;
    usersList.appendChild(li);
    return;
  }

  for (const u of arr) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="userline">
        <span class="dot" title="en ligne"></span>
        <span class="uname">${escapeHtml(u)}</span>
      </span>
      <span style="color:#999;font-size:12px;">online</span>
    `;
    usersList.appendChild(li);
  }
}

function setProjectsOptions(projects, keepSelection = true) {
  const prev = keepSelection ? cleanStr(projectSelect.value) : "";
  projectSelect.innerHTML = "";

  for (const p of (projects || [])) {
    const name = cleanStr(p);
    if (!name) continue;
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    projectSelect.appendChild(opt);
  }

  if (keepSelection && prev) {
    const exists = Array.from(projectSelect.options).some((o) => o.value === prev);
    if (exists) projectSelect.value = prev;
  }

  if (!projectSelect.value && projectSelect.options.length > 0) {
    projectSelect.value = projectSelect.options[0].value;
  }
}

/** =========================
 *  JOIN
 *  ========================= */
function joinProject() {
  const username = cleanStr(usernameInput.value);
  const project = cleanStr(projectSelect.value);

  if (!username) return alert("Entre un pseudo 🙂");
  if (!project) return alert("Aucun projet disponible.");

  currentUsername = username;
  currentProject = project;
  saveLastSession();

  setProjectLabel(currentProject);
  clearChat();
  renderUsers([]);
  addSystem(`Connexion au projet "${currentProject}"...`);

  socket.emit("joinProject", { username: currentUsername, project: currentProject, userId: myUserId });
}

joinBtn.addEventListener("click", joinProject);
usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinProject();
});

/** =========================
 *  PROJECTS CRUD
 *  ========================= */
if (createProjectBtn && newProjectInput) {
  createProjectBtn.addEventListener("click", () => {
    const name = cleanStr(newProjectInput.value);
    if (!name) return;
    socket.emit("createProject", { name });
    newProjectInput.value = "";
  });

  newProjectInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const name = cleanStr(newProjectInput.value);
      if (!name) return;
      socket.emit("createProject", { name });
      newProjectInput.value = "";
    }
  });
}

if (deleteProjectBtn) {
  deleteProjectBtn.addEventListener("click", () => {
    const p = cleanStr(projectSelect.value);
    if (!p) return;
    const ok = confirm(`Supprimer le projet "${p}" ?\n\n⚠️ Cela supprime aussi son historique de messages.`);
    if (!ok) return;
    socket.emit("deleteProject", { project: p });
  });
}

/** =========================
 *  UPLOAD
 *  ========================= */
async function uploadFile(file) {
  if (!currentProject) throw new Error("Aucun projet rejoint.");
  const username = currentUsername || cleanStr(usernameInput.value) || "Anonyme";

  const fd = new FormData();
  fd.append("file", file);
  fd.append("project", currentProject);
  fd.append("username", username);
  fd.append("userId", myUserId);

  const res = await fetch("/upload", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

/** =========================
 *  SEND
 *  ========================= */
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!currentProject) return alert("Rejoins un projet d’abord 🙂");
  const username = cleanStr(usernameInput.value);
  if (!username) return alert("Entre un pseudo 🙂");

  const message = cleanStr(input.value);
  const file = fileInput?.files?.[0];
  const submitBtn = form.querySelector("button[type=submit]");

  try {
    if (file) {
      if (uploadState) uploadState.textContent = `Upload "${file.name}"...`;
      if (submitBtn) submitBtn.disabled = true;

      await uploadFile(file);

      if (uploadState) uploadState.textContent = "Upload OK ✅ (analyse Sensi en cours…)";
      if (fileInput) fileInput.value = "";
      input.value = "";
      input.focus();
      setTimeout(() => { if (uploadState) uploadState.textContent = ""; }, 2500);
      return;
    }

    if (!message) return;

    currentUsername = username;
    saveLastSession();

    socket.emit("chatMessage", {
      username,
      userId: myUserId,
      message,
      project: currentProject,
    });

    input.value = "";
    input.focus();
  } catch (err) {
    console.error(err);
    alert(`Erreur: ${err?.message || err}`);
    if (uploadState) uploadState.textContent = "";
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

/** =========================
 *  RECEIVE
 *  ========================= */
socket.on("chatHistory", (payload) => {
  const p = cleanStr(payload?.project);
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!currentProject || p !== currentProject) return;

  clearChat();
  if (msgs.length === 0) return addSystem(`Historique vide pour "${currentProject}".`);
  addSystem(`Historique chargé pour "${currentProject}" (${msgs.length} message(s)).`);

  for (const m of msgs) {
    addMessage({
      id: m.id,
      ts: m.ts,
      username: m.username,
      userId: m.userId,
      message: m.message,
      attachment: m.attachment,
    });
  }
});

socket.on("chatMessage", (data) => {
  const p = cleanStr(data?.project);
  if (currentProject && p && p !== currentProject) return;

  addMessage({
    id: data?.id,
    ts: data?.ts,
    username: data?.username,
    userId: data?.userId,
    message: data?.message,
    attachment: data?.attachment,
  });
});

socket.on("messageDeleted", (payload) => {
  const p = cleanStr(payload?.project);
  const mid = Number(payload?.messageId);
  if (currentProject && p && p !== currentProject) return;
  if (!Number.isFinite(mid)) return;
  removeMessageFromUI(mid);
});

socket.on("systemMessage", (msg) => {
  const p = cleanStr(msg?.project);
  if (currentProject && p && p !== currentProject) return;
  addSystem(msg?.text || "Message système");
});

socket.on("presenceUpdate", (payload) => {
  const p = cleanStr(payload?.project);
  if (!currentProject || !p || p !== currentProject) return;
  renderUsers(payload?.users);
});

socket.on("projectsUpdate", (payload) => {
  const list = Array.isArray(payload?.projects) ? payload.projects : [];
  setProjectsOptions(list, true);

  const want = cleanStr(localStorage.getItem(LS_LAST_PROJECT));
  if (want && list.includes(want)) projectSelect.value = want;

  if (currentProject && !list.includes(currentProject)) {
    currentProject = null;
    setProjectLabel("—");
    renderUsers([]);
    clearChat();
    addSystem("Le projet courant a été supprimé. Choisis un autre projet puis Rejoindre.");
  }
});

socket.on("projectDeleted", ({ project }) => {
  const p = cleanStr(project);
  if (currentProject && p === currentProject) {
    currentProject = null;
    setProjectLabel("—");
    renderUsers([]);
    clearChat();
    addSystem(`Le projet "${p}" a été supprimé.`);
  }
});

socket.on("projectError", (payload) => alert(payload?.message || "Erreur projet"));

/** =========================
 *  CONNECT BOOTSTRAP
 *  ========================= */
const last = restoreLastSession();
let projectsLoadedOnce = false;

async function loadProjectsOnce() {
  if (projectsLoadedOnce) return;
  projectsLoadedOnce = true;

  // 1) HTTP first (/projects => {ok:true, projects:[...]} ou [...])
  try {
    const res = await fetch("/projects");
    const data = await res.json().catch(() => ({}));

    const list =
      Array.isArray(data) ? data :
      Array.isArray(data?.projects) ? data.projects :
      [];

    if (list.length > 0) {
      setProjectsOptions(list, true);

      const want = cleanStr(last?.p);
      if (want && list.includes(want)) projectSelect.value = want;

      return;
    }
  } catch (_) {}

  // 2) fallback socket
  socket.emit("getProjects");
}

socket.on("connect", async () => {
  console.log("✅ Connecté Socket.io", socket.id);

  await loadProjectsOnce();

  if (AUTO_JOIN) {
    const u = cleanStr(usernameInput.value);
    const p = cleanStr(projectSelect.value);
    if (u && p && !currentProject) joinProject();
  }
});

socket.on("disconnect", () => addSystem("Déconnecté du serveur…"));
socket.on("connect_error", (err) => addSystem(`Erreur connexion: ${err.message}`));
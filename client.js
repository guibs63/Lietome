// guibs:/client.js (COMPLET) — ULTRA v3.4.1 CLIENT
// ✅ Aligné server ULTRA v3.4.1 (FIX create project + FIX /projects compat)
// ✅ /projects => tableau ["test", ...] (server v3.4.1)
// ✅ sockets: getProjects/projectsUpdate + createProject + deleteProject + joinProject
// ✅ Join project + chat history + presence
// ✅ Delete message (author-only) + suppression autorisée pour Sensi côté server
// ✅ Upload fichiers + audio via POST /upload
// ✅ VOICE "OVER" + FFT temps réel + MediaRecorder
// ✅ DEBUG: window.socket + logs + statusbar (#status-text si présent)

"use strict";

/** =========================
 *  SOCKET INIT (GLOBAL)
 *  ========================= */
const socket = io(window.location.origin, {
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 600,
  timeout: 20000,
});

// ✅ rendre accessible depuis console
window.socket = socket;

console.log("client.js loaded ✅", { ioType: typeof io });

/** =========================
 *  FLAGS
 *  ========================= */
const AUTO_JOIN = false;

// VOICE / AUDIO
const ENABLE_VOICE = true;
const VOICE_APPEND_TO_INPUT = true;

// 🔥 envoi auto quand "over" est prononcé
const VOICE_SEND_ON_OVER = true;
const VOICE_OVER_WORD = "over";

// FFT
const SHOW_FFT = true;
const FFT_FPS = 30;
const FFT_BINS = 64;
const FFT_SMOOTHING = 0.8;
const FFT_FFTSIZE = 2048;
const FFT_MIN_DB = -90;
const FFT_MAX_DB = -10;

// Upload audio + fichiers
const UPLOAD_ENDPOINT = "/upload";
const AUDIO_MIME_PREFERRED = "audio/webm;codecs=opus";
const AUDIO_MAX_SECONDS = 120;

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

// Optionnel: statusbar (#status-text)
const statusText = document.getElementById("status-text");

// VOICE UI (créée dynamiquement)
let voiceBar = null;
let btnVoice = null;
let btnRec = null;
let btnSendRec = null;
let voiceHint = null;
let fftCanvas = null;
let fftCtx = null;

/** =========================
 *  DOM ASSERT
 *  ========================= */
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
 *  STATUSBAR HELPERS
 *  ========================= */
function setStatusBar(txt) {
  if (!statusText) return;
  statusText.textContent = String(txt || "");
}

/** =========================
 *  SOCKET DEBUG / STATUS
 *  ========================= */
setStatusBar("socket: connecting…");

socket.on("connect", () => {
  console.log("✅ socket connected", socket.id);
  setStatusBar(`socket: connected (${socket.id})`);
});
socket.on("disconnect", (reason) => {
  console.log("⚠️ socket disconnected", reason);
  setStatusBar("socket: disconnected");
});
socket.on("connect_error", (err) => {
  console.log("❌ connect_error", err?.message || err);
  setStatusBar(`socket: error (${err?.message || "?"})`);
});

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

function isSupportedMime(mime) {
  try {
    return !!(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mime));
  } catch { return false; }
}

function pickAudioMime() {
  if (isSupportedMime(AUDIO_MIME_PREFERRED)) return AUDIO_MIME_PREFERRED;
  const fallbacks = ["audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];
  for (const m of fallbacks) if (isSupportedMime(m)) return m;
  return "";
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
  const isAudio = String(att.mimetype || "").startsWith("audio/");

  if (isImg) {
    return `
      <div style="margin-top:6px;">
        <a href="${url}" target="_blank" rel="noopener">🖼️ ${name}</a><br/>
        <img src="${url}" alt="${name}"
             style="max-width:260px; border:1px solid #ddd; border-radius:10px; margin-top:6px;" />
      </div>
    `;
  }

  if (isAudio) {
    return `
      <div style="margin-top:6px;">
        <a href="${url}" target="_blank" rel="noopener">🎙️ ${name}</a>
        <div style="margin-top:6px;">
          <audio controls preload="none" src="${url}" style="width:260px;"></audio>
        </div>
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
    // server v3.4.1 accepte {name} et "name"
    socket.emit("createProject", { name }, (ack) => {
      if (ack?.ok === false) console.warn("createProject ack:", ack);
    });
    newProjectInput.value = "";
  });

  newProjectInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const name = cleanStr(newProjectInput.value);
      if (!name) return;
      socket.emit("createProject", { name }, (ack) => {
        if (ack?.ok === false) console.warn("createProject ack:", ack);
      });
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

  const res = await fetch(UPLOAD_ENDPOINT, { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

/** =========================
 *  SEND
 *  ========================= */
function sendTextMessage(text) {
  if (!currentProject) return alert("Rejoins un projet d’abord 🙂");
  const username = cleanStr(usernameInput.value);
  if (!username) return alert("Entre un pseudo 🙂");

  const message = cleanStr(text);
  if (!message) return;

  currentUsername = username;
  saveLastSession();

  socket.emit("chatMessage", {
    username,
    userId: myUserId,
    message,
    project: currentProject,
  });
}

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
  if (!currentProject) return;
  const p = cleanStr(data?.project);
  if (p && p !== currentProject) return;

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
  if (!currentProject) return;
  const p = cleanStr(payload?.project);
  const mid = Number(payload?.messageId);
  if (p && p !== currentProject) return;
  if (!Number.isFinite(mid)) return;
  removeMessageFromUI(mid);
});

socket.on("systemMessage", (msg) => {
  if (!currentProject) return;
  const p = cleanStr(msg?.project);
  if (p && p !== currentProject) return;
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
 *  PROJECTS BOOTSTRAP (v3.4.1)
 *  ========================= */
const last = restoreLastSession();
let projectsLoadedOnce = false;

async function loadProjectsOnce() {
  if (projectsLoadedOnce) return;
  projectsLoadedOnce = true;

  // ✅ server v3.4.1 => /projects renvoie un TABLEAU
  try {
    const res = await fetch("/projects", { cache: "no-store" });
    const data = await res.json().catch(() => null);

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
  } catch (e) {
    console.warn("loadProjectsOnce /projects failed:", e?.message || e);
  }

  // fallback socket
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

/** =========================
 *  VOICE + FFT (OVER => SEND)
 *  ========================= */
let recognition = null;
let isListening = false;

let mediaStream = null;
let audioCtx = null;
let analyser = null;
let fftData = null;
let fftAnim = null;
let lastFftTs = 0;

let recorder = null;
let recChunks = [];
let recBlob = null;
let recStopTimer = null;

function ensureVoiceUI() {
  if (voiceBar) return;

  voiceBar = document.createElement("div");
  voiceBar.id = "voice-bar";
  voiceBar.style.cssText = `
    margin-top:10px; padding:10px;
    border:1px solid rgba(0,0,0,.12);
    border-radius:12px;
    display:flex; gap:10px; align-items:center; flex-wrap:wrap;
  `;

  btnVoice = document.createElement("button");
  btnVoice.type = "button";
  btnVoice.textContent = "🎧 Écouter";
  btnVoice.style.cssText = "padding:8px 10px; border-radius:10px;";

  btnRec = document.createElement("button");
  btnRec.type = "button";
  btnRec.textContent = "⏺️ Enregistrer";
  btnRec.style.cssText = "padding:8px 10px; border-radius:10px;";

  btnSendRec = document.createElement("button");
  btnSendRec.type = "button";
  btnSendRec.textContent = "📤 Envoyer audio";
  btnSendRec.disabled = true;
  btnSendRec.style.cssText = "padding:8px 10px; border-radius:10px;";

  voiceHint = document.createElement("span");
  voiceHint.style.cssText = "color:#666;font-size:12px;";
  voiceHint.textContent = `Dites “… ${VOICE_OVER_WORD}” pour envoyer.`;

  fftCanvas = document.createElement("canvas");
  fftCanvas.width = 360;
  fftCanvas.height = 60;
  fftCanvas.style.cssText = `
    width:360px; height:60px;
    border-radius:10px; border:1px solid rgba(0,0,0,.10);
  `;
  fftCtx = fftCanvas.getContext("2d");

  voiceBar.appendChild(btnVoice);
  voiceBar.appendChild(btnRec);
  voiceBar.appendChild(btnSendRec);
  voiceBar.appendChild(voiceHint);
  if (SHOW_FFT) voiceBar.appendChild(fftCanvas);

  form.parentNode.insertBefore(voiceBar, form.nextSibling);

  btnVoice.addEventListener("click", async () => {
    if (!ENABLE_VOICE) return;
    if (isListening) stopListening();
    else await startListening();
  });

  btnRec.addEventListener("click", async () => {
    if (!ENABLE_VOICE) return;
    if (recorder && recorder.state === "recording") stopRecording();
    else await startRecording();
  });

  btnSendRec.addEventListener("click", async () => {
    try {
      if (!recBlob) return;
      btnSendRec.disabled = true;
      if (uploadState) uploadState.textContent = "Upload audio…";

      const ext = guessExtFromMime(recBlob.type) || "webm";
      const file = new File([recBlob], `audio_${Date.now()}.${ext}`, { type: recBlob.type || "audio/webm" });
      await uploadFile(file);

      recBlob = null;
      if (uploadState) uploadState.textContent = "Audio envoyé ✅";
      setTimeout(() => { if (uploadState) uploadState.textContent = ""; }, 2000);
    } catch (e) {
      console.error(e);
      alert(`Erreur upload audio: ${e?.message || e}`);
      if (uploadState) uploadState.textContent = "";
    } finally {
      btnSendRec.disabled = !recBlob;
    }
  });
}

function guessExtFromMime(mime) {
  const m = String(mime || "");
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("webm")) return "webm";
  return "";
}

function setVoiceButtonState() {
  if (!btnVoice) return;
  btnVoice.textContent = isListening ? "🛑 Stop écoute" : "🎧 Écouter";
}

async function ensureMicStream() {
  if (mediaStream) return mediaStream;
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return mediaStream;
}

async function ensureAnalyser() {
  if (analyser && audioCtx) return;
  await ensureMicStream();

  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(mediaStream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_FFTSIZE;
  analyser.smoothingTimeConstant = FFT_SMOOTHING;
  analyser.minDecibels = FFT_MIN_DB;
  analyser.maxDecibels = FFT_MAX_DB;

  src.connect(analyser);
  fftData = new Uint8Array(analyser.frequencyBinCount);
}

function stopFft() {
  if (fftAnim) cancelAnimationFrame(fftAnim);
  fftAnim = null;
  lastFftTs = 0;
  if (fftCtx && fftCanvas) fftCtx.clearRect(0, 0, fftCanvas.width, fftCanvas.height);
}

function startFft() {
  if (!SHOW_FFT || !fftCanvas || !fftCtx) return;
  if (!analyser || !fftData) return;
  if (fftAnim) return;

  const stepMs = 1000 / Math.max(10, FFT_FPS);

  const draw = (t) => {
    fftAnim = requestAnimationFrame(draw);
    if (!analyser) return;

    if (!lastFftTs) lastFftTs = t;
    if (t - lastFftTs < stepMs) return;
    lastFftTs = t;

    analyser.getByteFrequencyData(fftData);

    const w = fftCanvas.width;
    const h = fftCanvas.height;

    fftCtx.clearRect(0, 0, w, h);

    const bins = Math.min(FFT_BINS, fftData.length);
    const barW = w / bins;

    for (let i = 0; i < bins; i++) {
      const v = fftData[i] / 255;
      const barH = Math.max(1, v * h);

      const c = Math.floor(40 + v * 160);
      fftCtx.fillStyle = `rgb(${c}, ${c + 20}, ${Math.min(255, c + 80)})`;
      fftCtx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
    }
  };

  fftAnim = requestAnimationFrame(draw);
}

function normalizeTranscript(s) {
  return cleanStr(s)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitOnOver(transcript) {
  const norm = normalizeTranscript(transcript);
  const over = normalizeTranscript(VOICE_OVER_WORD);

  if (!norm) return { hasOver: false, cleanedText: "" };

  if (norm === over) return { hasOver: true, cleanedText: "" };
  if (norm.endsWith(" " + over)) {
    const cleaned = norm.slice(0, -(over.length + 1)).trim();
    return { hasOver: true, cleanedText: cleaned };
  }

  const token = " " + over + " ";
  const idx = norm.indexOf(token);
  if (idx >= 0) {
    const cleaned = norm.slice(0, idx).trim();
    return { hasOver: true, cleanedText: cleaned };
  }

  return { hasOver: false, cleanedText: transcript };
}

async function startListening() {
  ensureVoiceUI();

  if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
    alert("Reconnaissance vocale non supportée sur ce navigateur.");
    return;
  }

  try {
    await ensureMicStream();
    await ensureAnalyser();
    startFft();
  } catch (e) {
    console.error(e);
    alert("Micro refusé / indisponible.");
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = recognition || new SR();

  // ⚠️ ton "OVER" est en anglais -> garder en-US
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    setVoiceButtonState();
    if (voiceHint) voiceHint.textContent = `🎧 Écoute… dites “… ${VOICE_OVER_WORD}” pour envoyer.`;
  };

  recognition.onerror = (e) => {
    console.warn("Speech error:", e?.error);
    addSystem(`Voice error: ${e?.error || "unknown"}`);
  };

  recognition.onend = () => {
    if (isListening) {
      try { recognition.start(); } catch {}
    } else {
      stopFft();
    }
  };

  recognition.onresult = (event) => {
    let interim = "";
    let final = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      const txt = r[0]?.transcript || "";
      if (r.isFinal) final += txt + " ";
      else interim += txt + " ";
    }

    const display = cleanStr(final || interim);
    if (!display) return;

    if (voiceHint) voiceHint.textContent = `🗣️ ${display.slice(0, 80)}${display.length > 80 ? "…" : ""}`;

    if (cleanStr(final)) {
      const { hasOver, cleanedText } = splitOnOver(final);

      if (VOICE_APPEND_TO_INPUT && cleanedText) {
        const cur = cleanStr(input.value);
        input.value = cur ? `${cur} ${cleanedText}` : cleanedText;
      }

      if (VOICE_SEND_ON_OVER && hasOver) {
        const toSend = cleanStr(input.value) || cleanStr(cleanedText);
        if (toSend) {
          sendTextMessage(toSend);
          input.value = "";
          input.focus();
        }
      }
    }
  };

  try { recognition.start(); }
  catch (e) {
    console.error(e);
    addSystem("Voice start failed.");
  }
}

function stopListening() {
  isListening = false;
  setVoiceButtonState();
  if (voiceHint) voiceHint.textContent = `⏸️ Écoute stoppée.`;
  try { recognition && recognition.stop(); } catch {}
  stopFft();
}

async function startRecording() {
  ensureVoiceUI();

  if (!currentProject) return alert("Rejoins un projet d’abord 🙂");
  const username = cleanStr(usernameInput.value);
  if (!username) return alert("Entre un pseudo 🙂");

  try {
    await ensureMicStream();
    await ensureAnalyser();
    startFft();
  } catch (e) {
    console.error(e);
    alert("Micro refusé / indisponible.");
    return;
  }

  const mime = pickAudioMime();
  recChunks = [];
  recBlob = null;
  btnSendRec.disabled = true;

  try {
    recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    console.error(e);
    alert("Enregistrement non supporté sur ce navigateur.");
    return;
  }

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
  };

  recorder.onstop = () => {
    stopFft();
    const type = recorder?.mimeType || mime || "audio/webm";
    recBlob = new Blob(recChunks, { type });
    btnSendRec.disabled = !recBlob;
    btnRec.textContent = "⏺️ Enregistrer";
    if (voiceHint) voiceHint.textContent = "🎙️ Audio prêt. Clique « Envoyer audio ».";
  };

  recorder.start(250);
  btnRec.textContent = "⏹️ Stop rec";
  if (voiceHint) voiceHint.textContent = "🎙️ Enregistrement…";

  clearTimeout(recStopTimer);
  recStopTimer = setTimeout(() => {
    if (recorder && recorder.state === "recording") stopRecording();
  }, AUDIO_MAX_SECONDS * 1000);
}

function stopRecording() {
  clearTimeout(recStopTimer);
  recStopTimer = null;
  try { if (recorder && recorder.state === "recording") recorder.stop(); } catch {}
}

/** =========================
 *  INIT VOICE UI
 *  ========================= */
(function initVoice() {
  if (!ENABLE_VOICE) return;
  ensureVoiceUI();
  setVoiceButtonState();
})();

/** =========================
 *  BONUS: stop mic tracks on unload
 *  ========================= */
window.addEventListener("beforeunload", () => {
  try { stopListening(); } catch {}
  try { stopRecording(); } catch {}
  try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch {}
  try { if (audioCtx && audioCtx.state !== "closed") audioCtx.close(); } catch {}
});
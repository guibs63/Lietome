

// guibs:/client.js (COMPLET) — ULTRA v3.4.3 CLIENT (Fix "over" send + Firefox audio UX) ✅
"use strict";

const socket = io(window.location.origin, {
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 600,
  timeout: 20000,
});
window.socket = socket;

const AUTO_JOIN = false;

// VOICE / AUDIO
const ENABLE_VOICE = true;
const VOICE_APPEND_TO_INPUT = true;
const VOICE_SEND_ON_OVER = true;
const VOICE_OVER_WORD = "over";


// Firefox/fr-FR peut transcrire "over" en "ouvre" / "terminé"
const VOICE_TRIGGERS = ["over", "ouvre", "terminé", "termine", "terminée", "terminee"];
// Firefox: éviter blocage autoplay / permissions
const FIREFOX_FORCE_USER_GESTURE_BEFORE_AUDIOCTX = true;

// FFT
const SHOW_FFT = true;
const FFT_FPS = 30;
const FFT_BINS = 64;
const FFT_SMOOTHING = 0.8;
const FFT_FFTSIZE = 2048;
const FFT_MIN_DB = -90;
const FFT_MAX_DB = -10;

// Upload
const UPLOAD_ENDPOINT = "/upload";
const AUDIO_MIME_PREFERRED = "audio/webm;codecs=opus";
const AUDIO_MAX_SECONDS = 120;

let currentProject = null;
let currentUsername = null;

const seenMessageIds = new Set();
const messageNodes = new Map();

const LS_USER_ID = "sensi_user_id";
const LS_LAST_USERNAME = "sensi_last_username";
const LS_LAST_PROJECT = "sensi_last_project";
const myUserId = getOrCreateUserId();

// DOM
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
const statusText = document.getElementById("status-text");

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

function setStatusBar(txt) {
  if (!statusText) return;
  statusText.textContent = String(txt || "");
}

// socket status
setStatusBar("socket: connecting…");
socket.on("connect", () => setStatusBar(`socket: connected (${socket.id})`));
socket.on("disconnect", () => setStatusBar("socket: disconnected"));
socket.on("connect_error", (err) => setStatusBar(`socket: error (${err?.message || "?"})`));

// utils
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
  } catch { return ""; }
}

function getOrCreateUserId() {
  try {
    const existing = localStorage.getItem(LS_USER_ID);
    if (existing && existing.length >= 8) return existing;
    const uid = (crypto?.randomUUID ? crypto.randomUUID() : `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`);
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

// UI
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

// messages
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
  `;

  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  if (Number.isFinite(mid)) messageNodes.set(mid, row);
}

// projects list
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

// join
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
  addSystem(`Connexion au projet "${currentProject}"...`);

  socket.emit("joinProject", { username: currentUsername, project: currentProject, userId: myUserId });
}

joinBtn.addEventListener("click", joinProject);
usernameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinProject(); });

// create/delete project
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

// upload
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

// send text
function sendTextMessage(text) {
  if (!currentProject) return alert("Rejoins un projet d’abord 🙂");
  const username = cleanStr(usernameInput.value);
  if (!username) return alert("Entre un pseudo 🙂");

  const message = cleanStr(text);
  if (!message) return;

  currentUsername = username;
  saveLastSession();

  socket.emit("chatMessage", { username, userId: myUserId, message, project: currentProject });
}

// form submit
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

      if (uploadState) uploadState.textContent = "Upload OK ✅";
      if (fileInput) fileInput.value = "";
      input.value = "";
      input.focus();
      setTimeout(() => { if (uploadState) uploadState.textContent = ""; }, 2000);
      return;
    }

    if (!message) return;

    sendTextMessage(message);
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

// receive
socket.on("chatHistory", (payload) => {
  const p = cleanStr(payload?.project);
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!currentProject || p !== currentProject) return;

  clearChat();
  if (msgs.length === 0) return addSystem(`Historique vide pour "${currentProject}".`);
  addSystem(`Historique chargé pour "${currentProject}" (${msgs.length} message(s)).`);

  for (const m of msgs) addMessage(m);
});

socket.on("chatMessage", (data) => {
  if (!currentProject) return;
  const p = cleanStr(data?.project);
  if (p && p !== currentProject) return;
  addMessage(data);
});

socket.on("systemMessage", (msg) => {
  if (!currentProject) return;
  const p = cleanStr(msg?.project);
  if (p && p !== currentProject) return;
  addSystem(msg?.text || "Message système");
});

socket.on("presenceUpdate", (payload) => {
  // optional in this minimal client: ignore if you want
});

socket.on("projectsUpdate", (payload) => {
  const list = Array.isArray(payload?.projects) ? payload.projects : [];
  setProjectsOptions(list, true);

  const want = cleanStr(localStorage.getItem(LS_LAST_PROJECT));
  if (want && list.includes(want)) projectSelect.value = want;

  if (currentProject && !list.includes(currentProject)) {
    currentProject = null;
    setProjectLabel("—");
    clearChat();
    addSystem("Le projet courant a été supprimé. Choisis un autre projet puis Rejoindre.");
  }
});

socket.on("projectDeleted", ({ project }) => {
  const p = cleanStr(project);
  if (currentProject && p === currentProject) {
    currentProject = null;
    setProjectLabel("—");
    clearChat();
    addSystem(`Le projet "${p}" a été supprimé.`);
  }
});

socket.on("projectError", (payload) => alert(payload?.message || "Erreur projet"));

// bootstrap projects
const last = restoreLastSession();
let projectsLoadedOnce = false;

async function loadProjectsOnce() {
  if (projectsLoadedOnce) return;
  projectsLoadedOnce = true;

  try {
    const res = await fetch("/projects", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));

    // compat: /projects may return array
    const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : [];
    if (list.length > 0) {
      setProjectsOptions(list, true);
      const want = cleanStr(last?.p);
      if (want && list.includes(want)) projectSelect.value = want;
      return;
    }
  } catch (_) {}

  socket.emit("getProjects");
}

socket.on("connect", async () => {
  await loadProjectsOnce();
  if (AUTO_JOIN) {
    const u = cleanStr(usernameInput.value);
    const p = cleanStr(projectSelect.value);
    if (u && p && !currentProject) joinProject();
  }
});

// =========================
// VOICE + FFT (Fix "over")
// =========================
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

// UI injected
let voiceBar = null;
let btnVoice = null;
let btnRec = null;
let btnSendRec = null;
let voiceHint = null;
let fftCanvas = null;
let fftCtx = null;

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

function ensureVoiceUI() {
  if (voiceBar) return;
  voiceBar = document.createElement("div");
  voiceBar.id = "voice-bar";

  btnVoice = document.createElement("button");
  btnVoice.type = "button";
  btnVoice.textContent = "🎧 Écouter";

  btnRec = document.createElement("button");
  btnRec.type = "button";
  btnRec.textContent = "⏺️ Enregistrer";

  btnSendRec = document.createElement("button");
  btnSendRec.type = "button";
  btnSendRec.textContent = "📤 Envoyer audio";
  btnSendRec.disabled = true;

  voiceHint = document.createElement("span");
  voiceHint.style.cssText = "color:#666;font-size:12px;";
  voiceHint.textContent = `Dites “… ${VOICE_OVER_WORD}” pour envoyer.`;

  fftCanvas = document.createElement("canvas");
  fftCanvas.width = 360;
  fftCanvas.height = 60;
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

  // Firefox: AudioContext parfois bloqué sans geste user
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (FIREFOX_FORCE_USER_GESTURE_BEFORE_AUDIOCTX && audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch {}
    }
  }

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

// Key fix: detect "over" reliably even if recognition gives punctuation/casing
function normalizeTranscript(s) {
  return cleanStr(s)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns { hasOver, withoutOver, trigger }
function hasOverWord(transcript) {
  const norm = normalizeTranscript(transcript);
  if (!norm) return { hasOver: false, withoutOver: transcript, trigger: "" };

  // Try each trigger (over / ouvre / terminé …)
  for (const t of VOICE_TRIGGERS) {
    const trig = normalizeTranscript(t);
    if (!trig) continue;

    // exact
    if (norm === trig) return { hasOver: true, withoutOver: "", trigger: trig };

    // at end
    if (norm.endsWith(" " + trig)) {
      const without = norm.slice(0, -(trig.length + 1)).trim();
      return { hasOver: true, withoutOver: without, trigger: trig };
    }

    // token somewhere (rare but ok)
    const token = " " + trig + " ";
    const idx = (" " + norm + " ").indexOf(token);
    if (idx >= 0) {
      const cleaned = (" " + norm + " ").slice(0, idx).trim();
      return { hasOver: true, withoutOver: cleaned, trigger: trig };
    }
  }

  return { hasOver: false, withoutOver: transcript, trigger: "" };
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

  // Important: "over" en anglais => en-US
  recognition.lang = "fr-FR"; // Firefox FR (trigger: over/ouvre/terminé) // dictée FR (on garde le trigger "over"/"ouvre"/"terminé")
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    setVoiceButtonState();
    if (voiceHint) voiceHint.textContent = `🎧 Écoute… dis “… ${VOICE_OVER_WORD}” pour envoyer.`;
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

  // Fix: on envoie sur FINAL seulement, en utilisant la détection robuste de "over"
  recognition.onresult = (event) => {
    // Buffer des segments finalisés (Firefox peut laisser "over" en interim)
    window.__sensiVoiceFinalBuffer = window.__sensiVoiceFinalBuffer || "";

    let interim = "";
    let finalChunk = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      const txt = r[0]?.transcript || "";
      if (r.isFinal) finalChunk += txt + " ";
      else interim += txt + " ";
    }

    // Accumule uniquement les final pour éviter les répétitions
    if (cleanStr(finalChunk)) {
      window.__sensiVoiceFinalBuffer = cleanStr(
        window.__sensiVoiceFinalBuffer + " " + finalChunk
      );
    }

    const combined = cleanStr(window.__sensiVoiceFinalBuffer + " " + interim);
    if (!combined) return;

    if (voiceHint) {
      voiceHint.textContent = `🗣️ ${combined.slice(0, 80)}${combined.length > 80 ? "…" : ""}`;
    }

    // 🔥 Déclencheur "over" (et variantes FR) sur combined (interim + final)
    const { hasOver, withoutOver, trigger } = hasOverWord(combined);

    if (!hasOver) return;

    // Message à envoyer : ce que l'utilisateur a dicté, sans le trigger
    const messageToSend = cleanStr(withoutOver);
    if (!messageToSend) return;

    // Anti double-envoi (Firefox peut répéter la fin)
    window.__sensiLastOverSendTs = window.__sensiLastOverSendTs || 0;
    const now = Date.now();
    if (now - window.__sensiLastOverSendTs < 1200) return;
    window.__sensiLastOverSendTs = now;

    sendTextMessage(messageToSend);

    // Reset buffers/UI
    window.__sensiVoiceFinalBuffer = "";
    input.value = "";
    input.focus();
    if (voiceHint) voiceHint.textContent = `✅ Envoyé (${trigger || "over"})`;
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

// Recording
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

  recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) recChunks.push(ev.data); };

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

// init voice bar
(function initVoice() {
  if (!ENABLE_VOICE) return;
  ensureVoiceUI();
  setVoiceButtonState();
})();

window.addEventListener("beforeunload", () => {
  try { stopListening(); } catch {}
  try { stopRecording(); } catch {}
  try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch {}
  try { if (audioCtx && audioCtx.state !== "closed") audioCtx.close(); } catch {}
});
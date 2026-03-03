// guibs:/client.js (COMPLET) — ULTRA v3.4.5 CLIENT (Railway + socket fallback safe) ✅
// VOICE fix: "over / au revoir" = triggers d’envoi, mais JAMAIS ajoutés au texte final.
"use strict";

/* ======================================================
   SAFE SOCKET.IO INIT (wait for window.io)
   ====================================================== */

const IO_WAIT_MS = 7000;
const IO_POLL_MS = 60;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForIo() {
  const start = Date.now();
  while (Date.now() - start < IO_WAIT_MS) {
    if (typeof window.io === "function") return window.io;
    await sleep(IO_POLL_MS);
  }
  return null;
}

function cleanStr(v) { return String(v ?? "").trim(); }

/* ======================================================
   DOM
   ====================================================== */

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

// index.html utilise #status-text pour /health. On évite d’écraser : on ajoute un sous-status socket.
const statusText = document.getElementById("status-text");
let socketStatusSpan = null;

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

function ensureSocketStatusSlot() {
  if (!statusText) return null;
  if (socketStatusSpan) return socketStatusSpan;

  // Si l’index a déjà mis du HTML (OK | version | AI...), on ajoute à la fin.
  socketStatusSpan = document.createElement("span");
  socketStatusSpan.id = "socket-status";
  socketStatusSpan.style.marginLeft = "10px";
  socketStatusSpan.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  socketStatusSpan.style.fontSize = "12px";
  socketStatusSpan.textContent = "socket: …";
  statusText.appendChild(socketStatusSpan);
  return socketStatusSpan;
}

function setSocketStatus(txt) {
  const slot = ensureSocketStatusSlot();
  if (!slot) return;
  slot.textContent = `socket: ${String(txt || "")}`;
}

/* ======================================================
   LOCAL STORAGE / IDs
   ====================================================== */

const AUTO_JOIN = false;

const LS_USER_ID = "sensi_user_id";
const LS_LAST_USERNAME = "sensi_last_username";
const LS_LAST_PROJECT = "sensi_last_project";

function getOrCreateUserId() {
  try {
    const existing = localStorage.getItem(LS_USER_ID);
    if (existing && existing.length >= 8) return existing;
    const uid =
      (crypto?.randomUUID
        ? crypto.randomUUID()
        : `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    localStorage.setItem(LS_USER_ID, uid);
    return uid;
  } catch {
    return `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

const myUserId = getOrCreateUserId();

let currentProject = null;
let currentUsername = null;

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

/* ======================================================
   UI helpers
   ====================================================== */

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

function setProjectLabel(p) {
  if (!currentProjectLabel) return;
  currentProjectLabel.textContent = p || "—";
}

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

/* ======================================================
   Messages rendering + delete support
   ====================================================== */

const seenMessageIds = new Set();
const messageNodes = new Map();

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

  // Bouton delete uniquement pour MES messages
  const canDelete = cleanStr(userId) && cleanStr(userId) === cleanStr(myUserId);

  row.innerHTML = `
    <div class="msg-main" style="display:flex; gap:10px; align-items:flex-start;">
      <div style="flex:1;">
        <span class="time">${time ? `[${time}]` : ""}</span>
        <strong>${escapeHtml(username)}:</strong>
        <span class="text">${escapeHtml(message)}</span>
        ${attachment ? renderAttachment(attachment) : ""}
      </div>
      ${canDelete && Number.isFinite(mid) ? `
        <button type="button"
          data-del="1"
          data-mid="${String(mid)}"
          title="Supprimer mon message"
          style="border:1px solid #f2b8b5;background:#fff5f5;border-radius:10px;padding:4px 8px;cursor:pointer;">
          🗑️
        </button>
      ` : ""}
    </div>
  `;

  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;

  if (Number.isFinite(mid)) messageNodes.set(mid, row);
}

function removeMessageNode(messageId) {
  const mid = Number(messageId);
  const node = messageNodes.get(mid);
  if (node && node.parentNode) node.parentNode.removeChild(node);
  messageNodes.delete(mid);
  seenMessageIds.delete(mid);
}

// delegate delete clicks
chat.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-del='1']");
  if (!btn) return;
  const mid = Number(btn.getAttribute("data-mid"));
  if (!Number.isFinite(mid)) return;
  if (!currentProject) return;

  const ok = confirm("Supprimer ce message ?");
  if (!ok) return;

  if (!socket) return alert("Socket non prêt.");
  socket.emit("deleteMessage", { project: currentProject, messageId: mid }, (resp) => {
    if (!resp?.ok) {
      alert("Suppression impossible: " + (resp?.error || "unknown"));
      return;
    }
    // le serveur broadcast aussi messageDeleted, mais on peut retirer tout de suite
    removeMessageNode(mid);
  });
});

/* ======================================================
   Projects list
   ====================================================== */

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

/* ======================================================
   Presence rendering
   ====================================================== */

function renderPresence(users) {
  if (!usersList || !usersCount) return;

  const arr = Array.isArray(users) ? users : [];
  usersCount.textContent = String(arr.length);

  usersList.innerHTML = "";
  for (const u of arr) {
    const li = document.createElement("li");
    const name = cleanStr(u?.username) || "—";
    const uid = cleanStr(u?.userId);

    li.innerHTML = `
      <span>${escapeHtml(name)}</span>
      <span style="opacity:.55;font-size:11px;">${uid ? escapeHtml(uid.slice(0, 6)) : ""}</span>
    `;
    usersList.appendChild(li);
  }
}

/* ======================================================
   Upload / send message
   ====================================================== */

const UPLOAD_ENDPOINT = "/upload";

async function uploadFile(file) {
  if (!currentProject) throw new Error("Aucun projet rejoint.");
  const username = currentUsername || cleanStr(usernameInput.value) || "Anonyme";

  const fd = new FormData();
  fd.append("file", file);
  fd.append("project", currentProject);
  fd.append("username", username);
  fd.append("userId", myUserId);

  const res = await fetch(UPLOAD_ENDPOINT, { method: "POST", body: fd, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

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

/* ======================================================
   VOICE / AUDIO / FFT (your logic preserved, minor safety)
   ====================================================== */

const ENABLE_VOICE = true;
const VOICE_APPEND_TO_INPUT = true;
const VOICE_SEND_ON_OVER = true;
const VOICE_OVER_WORD = "over";

const VOICE_TRIGGERS = [
  "over",
  "ouvre",
  "terminé",
  "termine",
  "terminée",
  "terminee",
  "terminer",
  "au revoir",
  "au-revoir",
  "aurevoir",
];

const FIREFOX_FORCE_USER_GESTURE_BEFORE_AUDIOCTX = true;

// FFT
const SHOW_FFT = true;
const FFT_FPS = 30;
const FFT_BINS = 64;
const FFT_SMOOTHING = 0.8;
const FFT_FFTSIZE = 2048;
const FFT_MIN_DB = -90;
const FFT_MAX_DB = -10;

// Audio record
const AUDIO_MIME_PREFERRED = "audio/webm;codecs=opus";
const AUDIO_MAX_SECONDS = 120;

function requireReadyForVoice() {
  if (!cleanStr(usernameInput?.value)) {
    alert("Entre un pseudo puis clique Rejoindre avant d'activer la voix 🙂");
    return false;
  }
  if (!cleanStr(currentProject)) {
    alert("Rejoins un projet avant d'activer la reconnaissance vocale 🙂");
    return false;
  }
  return true;
}

function buildTriggerEndRegex() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = VOICE_TRIGGERS
    .map((t) => cleanStr(t))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(esc);

  return new RegExp(`(?:${parts.join("|")})\\s*[\\.!\\?,;:\\u2026]*\\s*$`, "i");
}
const TRIGGER_END_RE = buildTriggerEndRegex();

function hasVoiceTriggerAtEnd(text) {
  const t = cleanStr(text);
  if (!t) return false;
  return TRIGGER_END_RE.test(t);
}
function stripVoiceTriggerAtEnd(text) {
  const t = cleanStr(text);
  if (!t) return "";
  return cleanStr(t.replace(TRIGGER_END_RE, ""));
}

function guessExtFromMime(mime) {
  const m = String(mime || "");
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("webm")) return "webm";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "";
}

async function transcribeAudioBlob(blob) {
  const fd = new FormData();
  const ext = guessExtFromMime(blob.type) || "webm";
  fd.append("audio", new File([blob], `voice_${Date.now()}.${ext}`, { type: blob.type || "audio/webm" }));

  const res = await fetch("/transcribe", { method: "POST", body: fd, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.error || `Transcription failed (${res.status})`);
  return cleanStr(data.text || "");
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

// Voice state
let recognition = null;
let isListening = false;
let voiceMode = null; // "speech" | "segment"

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

// Firefox rolling segments
let segRecorder = null;
let segChunks = [];
let segTimer = null;
let segInFlight = false;
let segAccumulatedText = "";
let segQueue = Promise.resolve();

// UI injected
let voiceBar = null;
let btnVoice = null;
let btnRec = null;
let btnSendRec = null;
let voiceHint = null;
let fftCanvas = null;
let fftCtx = null;

function updateVoiceUiGate() {
  if (!btnVoice || !btnRec || !btnSendRec) return;
  const ok = Boolean(cleanStr(currentProject) && cleanStr(usernameInput?.value));
  btnVoice.disabled = !ok;
  btnRec.disabled = !ok;
  btnSendRec.disabled = !ok || !recBlob;
  if (!ok && voiceHint) voiceHint.textContent = "🔒 Rejoins un projet pour activer la voix.";
}

function ensureVoiceUI() {
  if (voiceBar) return;

  voiceBar = document.createElement("div");
  voiceBar.id = "voice-bar";
  voiceBar.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 0;";

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
  fftCanvas.style.cssText = "border:1px solid #eee;border-radius:10px;";
  fftCtx = fftCanvas.getContext("2d");

  voiceBar.appendChild(btnVoice);
  voiceBar.appendChild(btnRec);
  voiceBar.appendChild(btnSendRec);
  voiceBar.appendChild(voiceHint);
  if (SHOW_FFT) voiceBar.appendChild(fftCanvas);

  form.parentNode.insertBefore(voiceBar, form.nextSibling);

  updateVoiceUiGate();
  setVoiceButtonState();

  btnVoice.addEventListener("click", async () => {
    if (!ENABLE_VOICE) return;
    if (!requireReadyForVoice()) return;
    if (isListening) stopListening();
    else await startListening();
  });

  btnRec.addEventListener("click", async () => {
    if (!ENABLE_VOICE) return;
    if (!requireReadyForVoice()) return;
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
      updateVoiceUiGate();
    }
  });
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

async function startListening() {
  if (!requireReadyForVoice()) return;
  ensureVoiceUI();

  try {
    await ensureMicStream();
    await ensureAnalyser();
    startFft();
  } catch (e) {
    console.error(e);
    alert("Micro refusé / indisponible.");
    return;
  }

  // Chrome/Edge SpeechRecognition
  if (("webkitSpeechRecognition" in window) || ("SpeechRecognition" in window)) {
    voiceMode = "speech";
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "fr-FR";

    recognition.onerror = (e) => {
      console.warn("SpeechRecognition error", e);
      if (voiceHint) voiceHint.textContent = `⚠️ Voice: ${e?.error || "error"}`;
    };

    recognition.onend = () => {
      if (isListening) {
        try { recognition.start(); } catch {}
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

      const combinedRaw = cleanStr(final || interim);
      if (!combinedRaw) return;

      const combinedPreview = stripVoiceTriggerAtEnd(combinedRaw);
      if (voiceHint) voiceHint.textContent = `🗣️ ${combinedPreview.slice(0, 80)}${combinedPreview.length > 80 ? "…" : ""}`;

      if (VOICE_APPEND_TO_INPUT) {
        const cur = cleanStr(input.value);
        const add = stripVoiceTriggerAtEnd(combinedRaw);
        if (add) input.value = cur ? `${cur} ${add}` : add;
      }

      if (VOICE_SEND_ON_OVER && hasVoiceTriggerAtEnd(combinedRaw)) {
        const msg = cleanStr(stripVoiceTriggerAtEnd(combinedRaw) || stripVoiceTriggerAtEnd(input.value));
        if (msg) {
          sendTextMessage(msg);
          input.value = "";
          input.focus();
          if (voiceHint) voiceHint.textContent = "✅ Envoyé (voice)";
        }
      }
    };

    isListening = true;
    setVoiceButtonState();
    if (voiceHint) voiceHint.textContent = `🎧 Écoute (SpeechRecognition) : dis "${VOICE_OVER_WORD}" (ou "ouvre"/"terminé"/"au revoir") pour envoyer.`;
    try { recognition.start(); } catch {}
    return;
  }

  // Firefox segment mode -> /transcribe
  voiceMode = "segment";
  segAccumulatedText = "";
  if (voiceHint) voiceHint.textContent = `🎧 Dictée Firefox : parle, puis dis "${VOICE_OVER_WORD}" / "ouvre" / "terminé" / "au revoir" pour envoyer.`;

  const SEG_MS = 4000;

  const startOneSegment = () => {
    if (!isListening) return;

    try {
      segChunks = [];
      const prefer = pickAudioMime();

      try {
        segRecorder = new MediaRecorder(mediaStream, prefer ? { mimeType: prefer } : undefined);
      } catch {
        segRecorder = new MediaRecorder(mediaStream);
      }

      segRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) segChunks.push(ev.data);
      };

      segRecorder.onstop = () => {
        if (!isListening) return;

        const blob = new Blob(segChunks, { type: segRecorder?.mimeType || (segChunks[0]?.type || "audio/webm") });
        segChunks = [];

        segQueue = segQueue.then(async () => {
          if (segInFlight) return;
          segInFlight = true;

          try {
            if (!blob || blob.size < 10 * 1024) return;

            const text = await transcribeAudioBlob(blob);
            if (!text) return;

            segAccumulatedText = cleanStr((segAccumulatedText + " " + text).slice(-2500));

            const preview = stripVoiceTriggerAtEnd(segAccumulatedText);
            if (voiceHint) {
              const p = preview.slice(0, 90);
              voiceHint.textContent = `🗣️ ${p}${preview.length > 90 ? "…" : ""}`;
            }

            if (VOICE_APPEND_TO_INPUT) {
              if (preview) input.value = preview;
            }

            if (VOICE_SEND_ON_OVER && hasVoiceTriggerAtEnd(segAccumulatedText)) {
              const msg = cleanStr(stripVoiceTriggerAtEnd(segAccumulatedText));
              if (msg) sendTextMessage(msg);
              input.value = "";
              input.focus();
              segAccumulatedText = "";
              stopListening();
              return;
            }
          } catch (err) {
            console.warn("transcribe segment failed", err);
          } finally {
            segInFlight = false;
          }
        }).finally(() => {
          if (isListening) startOneSegment();
        });
      };

      segRecorder.start();
      clearTimeout(segTimer);
      segTimer = setTimeout(() => {
        try { if (segRecorder && segRecorder.state === "recording") segRecorder.stop(); } catch {}
      }, SEG_MS);
    } catch (e) {
      console.error(e);
      if (voiceHint) voiceHint.textContent = "⚠️ Dictée Firefox: enregistrement impossible.";
    }
  };

  isListening = true;
  setVoiceButtonState();
  startOneSegment();
}

function stopListening() {
  isListening = false;
  setVoiceButtonState();
  if (voiceHint) voiceHint.textContent = `⏸️ Écoute stoppée.`;

  try { recognition && recognition.stop(); } catch {}
  recognition = null;

  try { if (segTimer) clearTimeout(segTimer); } catch {}
  segTimer = null;
  try { if (segRecorder && segRecorder.state === "recording") segRecorder.stop(); } catch {}
  segRecorder = null;
  segChunks = [];
  segInFlight = false;
  segAccumulatedText = "";
  voiceMode = null;

  stopFft();
}

async function startRecording() {
  if (!requireReadyForVoice()) return;
  ensureVoiceUI();

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
    updateVoiceUiGate();
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

/* ======================================================
   FORM submit (text or file)
   ====================================================== */

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

/* ======================================================
   JOIN / CREATE / DELETE project
   ====================================================== */

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

  updateVoiceUiGate();
}

joinBtn.addEventListener("click", joinProject);
usernameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinProject(); });
usernameInput.addEventListener("input", () => updateVoiceUiGate());

function isValidProjectName(name) {
  return /^[a-zA-Z0-9 _.\-]{2,50}$/.test(cleanStr(name));
}

if (createProjectBtn && newProjectInput) {
  const requestCreateProject = (nameRaw) => {
    const name = cleanStr(nameRaw);
    if (!name) return;
    if (!isValidProjectName(name)) return alert("Nom invalide (2-50, lettres/chiffres/espaces/_-.)");

    socket.emit("createProject", { name }, (resp) => {
      if (!resp || resp.ok !== true) {
        alert(resp?.message || "Erreur création projet");
        return;
      }

      const list = Array.isArray(resp.projects) ? resp.projects : [];
      if (list.length > 0) setProjectsOptions(list, false);
      if (resp.project) projectSelect.value = resp.project;

      addSystem(`✅ Projet créé: "${resp.project}"`);
    });
  };

  createProjectBtn.addEventListener("click", () => {
    requestCreateProject(newProjectInput.value);
    newProjectInput.value = "";
    newProjectInput.focus();
  });

  newProjectInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      requestCreateProject(newProjectInput.value);
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

/* ======================================================
   BOOTSTRAP projects
   ====================================================== */

const last = restoreLastSession();
let projectsLoadedOnce = false;

async function loadProjectsOnce() {
  if (projectsLoadedOnce) return;
  projectsLoadedOnce = true;

  try {
    const res = await fetch("/projects", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));

    const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : [];
    if (list.length > 0) {
      setProjectsOptions(list, true);
      const want = cleanStr(last?.p);
      if (want && list.includes(want)) projectSelect.value = want;
      updateVoiceUiGate();
      return;
    }
  } catch (_) {}

  socket.emit("getProjects");
}

/* ======================================================
   SOCKET + EVENTS (initialized after io ready)
   ====================================================== */

let socket = null;

async function initSocket() {
  setSocketStatus("connecting…");

  const ioFn = await waitForIo();
  if (!ioFn) {
    setSocketStatus("ERROR (io not loaded)");
    alert("Socket.IO n’a pas pu se charger (io is undefined). Vérifie /socket.io/socket.io.js ou le CDN.");
    return null;
  }

  socket = ioFn(window.location.origin, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 600,
    timeout: 20000,
  });

  window.socket = socket;

  socket.on("connect", () => setSocketStatus(`connected (${socket.id})`));
  socket.on("disconnect", () => setSocketStatus("disconnected"));
  socket.on("connect_error", (err) => setSocketStatus(`error (${err?.message || "?"})`));

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
    if (!currentProject) return;
    const p = cleanStr(payload?.project);
    if (p && p !== currentProject) return;
    renderPresence(payload?.users);
  });

  socket.on("messageDeleted", ({ project, messageId }) => {
    const p = cleanStr(project);
    if (currentProject && p && p !== currentProject) return;
    removeMessageNode(messageId);
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
      renderPresence([]);
    }

    updateVoiceUiGate();
  });

  socket.on("projectDeleted", ({ project }) => {
    const p = cleanStr(project);
    if (currentProject && p === currentProject) {
      currentProject = null;
      setProjectLabel("—");
      clearChat();
      addSystem(`Le projet "${p}" a été supprimé.`);
      renderPresence([]);
    }
  });

  socket.on("projectError", (payload) => alert(payload?.message || "Erreur projet"));

  socket.on("connect", async () => {
    await loadProjectsOnce();
    if (AUTO_JOIN) {
      const u = cleanStr(usernameInput.value);
      const p = cleanStr(projectSelect.value);
      if (u && p && !currentProject) joinProject();
    }
  });

  // initial fetch in case socket is slow
  await loadProjectsOnce();

  return socket;
}

/* ======================================================
   INIT VOICE BAR
   ====================================================== */

(function initVoice() {
  if (!ENABLE_VOICE) return;
  ensureVoiceUI();
  updateVoiceUiGate();
})();

/* ======================================================
   CLEANUP
   ====================================================== */

window.addEventListener("beforeunload", () => {
  try { stopListening(); } catch {}
  try { stopRecording(); } catch {}
  try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (audioCtx && audioCtx.state !== "closed") audioCtx.close(); } catch {}
});

/* ======================================================
   START
   ====================================================== */

initSocket().catch((e) => {
  console.error("initSocket failed", e);
  setSocketStatus("ERROR (init failed)");
});
// guibs:/client.js (COMPLET) — ULTRA v3.8.2 CLIENT — compatible server v3.8.2
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

const statusText = document.getElementById("status-text");
const socketStatusHost = document.getElementById("socket-status-host") || statusText;

let socketStatusSpan = null;
let healthStatusSpan = null;
let aiStatusSpan = null;
let sensiBar = null;
let sensiHint = null;
let sensiQuickInput = null;
let sensiLastHealth = null;
let shareProjectWrap = null;
let shareProjectEmailInput = null;
let shareProjectSendBtn = null;

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
  if (!socketStatusHost) return null;
  if (socketStatusSpan && socketStatusSpan.isConnected) return socketStatusSpan;

  socketStatusSpan = document.createElement("span");
  socketStatusSpan.id = "socket-status";
  socketStatusSpan.style.marginLeft = "10px";
  socketStatusSpan.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  socketStatusSpan.style.fontSize = "12px";
  socketStatusSpan.textContent = "socket: démarrage…";
  socketStatusHost.appendChild(socketStatusSpan);
  return socketStatusSpan;
}

function ensureHealthStatusSlot() {
  if (!socketStatusHost) return null;
  if (healthStatusSpan && healthStatusSpan.isConnected) return healthStatusSpan;

  healthStatusSpan = document.createElement("span");
  healthStatusSpan.id = "health-status";
  healthStatusSpan.style.marginLeft = "10px";
  healthStatusSpan.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  healthStatusSpan.style.fontSize = "12px";
  healthStatusSpan.textContent = "health: …";
  socketStatusHost.appendChild(healthStatusSpan);
  return healthStatusSpan;
}

function ensureAiStatusSlot() {
  if (!socketStatusHost) return null;
  if (aiStatusSpan && aiStatusSpan.isConnected) return aiStatusSpan;

  aiStatusSpan = document.createElement("span");
  aiStatusSpan.id = "ai-status";
  aiStatusSpan.style.marginLeft = "10px";
  aiStatusSpan.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  aiStatusSpan.style.fontSize = "12px";
  aiStatusSpan.textContent = "ai: …";
  socketStatusHost.appendChild(aiStatusSpan);
  return aiStatusSpan;
}

function setSocketStatus(txt) {
  const slot = ensureSocketStatusSlot();
  if (!slot) return;
  slot.textContent = `socket: ${String(txt || "")}`;
}

function setHealthStatus(txt) {
  const slot = ensureHealthStatusSlot();
  if (!slot) return;
  slot.textContent = `health: ${String(txt || "")}`;
}

function setAiStatus(txt) {
  const slot = ensureAiStatusSlot();
  if (!slot) return;
  slot.textContent = `ai: ${String(txt || "")}`;
}

/* ======================================================
   LOCAL STORAGE / IDs
   ====================================================== */

const AUTO_JOIN = false;

const LS_USER_ID = "sensi_user_id";
const LS_LAST_USERNAME = "sensi_last_username";
const LS_LAST_PROJECT = "sensi_last_project";
const LS_LAST_HEALTH = "sensi_last_health";

const SEND_DEDUP_MS = 1500;
let lastSentSignature = "";
let lastSentAt = 0;
let voiceInputBase = "";
let voiceAutoSending = false;

function normalizedMessageSignature(project, username, text) {
  return [
    cleanStr(project).toLowerCase(),
    cleanStr(username).toLowerCase(),
    cleanStr(text).replace(/\s+/g, " ").toLowerCase()
  ].join("|");
}

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
const DEFAULT_PROJECT = "global";

let currentProject = null;
let currentUsername = null;
let socket = null;
let socketReady = false;
let pendingJoinRequested = false;
let lastUploadedFileInfo = null;
let lastDetectedAiEnabled = null;

function setSocketUiReady(ready, detail = "") {
  socketReady = Boolean(ready);

  if (joinBtn) {
    joinBtn.disabled = !socketReady;
    joinBtn.title = socketReady ? "Rejoindre le projet sélectionné" : (detail || "Chargement du socket...");
  }

  if (createProjectBtn) {
    createProjectBtn.disabled = !socketReady;
    createProjectBtn.title = socketReady ? "Créer un nouveau projet" : (detail || "Chargement du socket...");
  }

  refreshDeleteProjectState();
  refreshSensiBarState(detail);
}

function queueJoinUntilSocketReady() {
  pendingJoinRequested = true;
  setSocketUiReady(false, "Socket en cours d'initialisation...");
  addSystem("⏳ Socket en cours de chargement... la connexion au projet partira automatiquement dès qu'il sera prêt.");
}

function flushPendingJoinIfNeeded() {
  if (!pendingJoinRequested || !socket || !socket.connected) return;
  pendingJoinRequested = false;
  setTimeout(() => joinProject({ silentIfPending: true }), 50);
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

function renderRichText(str) {
  const safe = escapeHtml(str).replace(/\r?\n/g, "<br/>");
  return safe.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
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

function setUploadState(text) {
  if (!uploadState) return;
  uploadState.textContent = cleanStr(text);
}

function detectIsSensiMessage(username) {
  const u = cleanStr(username).toLowerCase();
  return u === "sensi" || u === "✨ sensi";
}

function insertTextAtCursor(el, text) {
  if (!el) return;
  const value = String(el.value || "");
  const start = typeof el.selectionStart === "number" ? el.selectionStart : value.length;
  const end = typeof el.selectionEnd === "number" ? el.selectionEnd : value.length;
  const before = value.slice(0, start);
  const after = value.slice(end);
  el.value = before + text + after;
  const pos = start + text.length;
  try {
    el.setSelectionRange(pos, pos);
  } catch {}
  el.focus();
}

function putPromptInInput(text, opts = {}) {
  const replace = Boolean(opts.replace);
  const prompt = cleanStr(text);
  if (!prompt) return;
  if (replace || !cleanStr(input.value)) {
    input.value = prompt;
  } else {
    const cur = cleanStr(input.value);
    input.value = cur ? `${cur} ${prompt}` : prompt;
  }
  input.focus();
}

function sendAssistantPrompt(text) {
  const prompt = cleanStr(text);
  if (!prompt) return;
  sendTextMessage(prompt);
}

function inferNaturalAnalyzePrompt() {
  if (lastUploadedFileInfo?.filename) {
    const mime = String(lastUploadedFileInfo.mimetype || "");
    if (mime.startsWith("image/")) return "Sensi analyse cette image envoyée";
    if (mime.startsWith("audio/")) return "Sensi analyse cet audio envoyé et fais une synthèse";
    return "Sensi analyse ce fichier envoyé";
  }
  return "Sensi analyse le dernier fichier du projet";
}

function inferNaturalSummaryPrompt() {
  if (lastUploadedFileInfo?.filename) return "Sensi résume ce document envoyé";
  return "Sensi fais une synthèse de la discussion récente";
}

function inferNaturalWebPrompt() {
  return "Sensi cherche sur le web les dernières infos utiles sur ";
}

function inferNaturalDocxPrompt() {
  return "/docx brief à compléter";
}

function inferNaturalXlsxPrompt() {
  return "/xlsx brief à compléter";
}

function inferNaturalPptxPrompt() {
  return "/pptx brief à compléter";
}

function inferNaturalImagePrompt() {
  return "/image brief à compléter";
}

/* ======================================================
   PROJECT ACTIONS: delete sensi / export / share
   ====================================================== */

function triggerDeleteSensiMessages() {
  if (!currentProject) {
    alert("Rejoins un projet d’abord 🙂");
    return;
  }
  if (!socket || !socketReady) {
    alert("Socket non prêt.");
    return;
  }

  const ok = confirm(`Effacer tous les messages de Sensi du projet "${currentProject}" ?`);
  if (!ok) return;

  const payload = { project: currentProject };

  socket.emit("deleteSensiMessages", payload, (resp) => {
    if (resp?.ok) {
      const ids = Array.isArray(resp.messageIds) ? resp.messageIds : [];
      if (ids.length) ids.forEach((id) => removeMessageNode(id));
      if (!ids.length) removeAllVisibleSensiMessages();
      addSystem("Messages de Sensi supprimés ✅");
      return;
    }

    socket.emit("deleteSensi", payload, (legacyResp) => {
      if (legacyResp?.ok) {
        removeAllVisibleSensiMessages();
        addSystem("Messages de Sensi supprimés ✅");
        return;
      }

      removeAllVisibleSensiMessages();
      addSystem("Suppression locale des messages Sensi effectuée (serveur non confirmatif).");
    });
  });
}

function removeAllVisibleSensiMessages() {
  const rows = Array.from(chat.querySelectorAll(".msg-row"));
  for (const row of rows) {
    const strong = row.querySelector("strong");
    const txt = cleanStr(strong?.textContent || "").toLowerCase();
    if (txt.includes("sensi")) {
      const mid = Number(row.dataset.mid);
      if (Number.isFinite(mid)) {
        removeMessageNode(mid);
      } else {
        row.remove();
      }
    }
  }
}

function triggerProjectExport() {
  if (!currentProject) {
    alert("Rejoins un projet d’abord 🙂");
    return;
  }
  if (!socket || !socketReady) {
    alert("Socket non prêt.");
    return;
  }

  socket.emit("exportProject", { project: currentProject }, (resp) => {
    if (resp?.ok && resp?.url) {
      window.open(resp.url, "_blank", "noopener");
      addSystem(`Export projet prêt ✅ (${currentProject})`);
      return;
    }

    if (resp?.ok && resp?.content) {
      const blob = new Blob([resp.content], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${currentProject}_export.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      addSystem(`Export projet téléchargé ✅ (${currentProject})`);
      return;
    }

    alert("Export impossible pour le moment.");
  });
}

function toggleShareProjectUi() {
  if (!shareProjectWrap) return;
  const isHidden = shareProjectWrap.style.display === "none" || !shareProjectWrap.style.display;
  shareProjectWrap.style.display = isHidden ? "flex" : "none";
  if (isHidden) shareProjectEmailInput?.focus();
}

function buildMailtoForProjectShare(project, email) {
  const subject = encodeURIComponent(`Partage du projet ${project}`);
  const body = encodeURIComponent(
    `Bonjour,\n\nJe partage avec vous le projet "${project}" depuis Sensi Collaboration.\n\n`
  );
  return `mailto:${email}?subject=${subject}&body=${body}`;
}

function triggerProjectShare() {
  if (!currentProject) {
    alert("Rejoins un projet d’abord 🙂");
    return;
  }

  const email = cleanStr(shareProjectEmailInput?.value);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    alert("Entre une adresse mail valide.");
    return;
  }

  if (socket && socketReady) {
    socket.emit("shareProject", { project: currentProject, email }, (resp) => {
      if (resp?.ok) {
        window.location.href = buildMailtoForProjectShare(currentProject, email);
        addSystem(`Partage prêt ✅ (${currentProject} → ${email})`);
        return;
      }
      window.location.href = buildMailtoForProjectShare(currentProject, email);
    });
    return;
  }

  window.location.href = buildMailtoForProjectShare(currentProject, email);
}

/* ======================================================
   Sensi bar / copilot UX
   ====================================================== */

function ensureSensiBar() {
  if (sensiBar || !form || !form.parentNode) return;

  sensiBar = document.createElement("div");
  sensiBar.id = "sensi-bar";
  sensiBar.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "margin:10px 0 0",
    "padding:10px",
    "border:1px solid #e8e8e8",
    "border-radius:12px",
    "background:#fafafa",
  ].join(";");

  const top = document.createElement("div");
  top.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;";

  const title = document.createElement("strong");
  title.textContent = "✨ Sensi";
  title.style.cssText = "font-size:14px;";

  sensiHint = document.createElement("span");
  sensiHint.style.cssText = "font-size:12px;color:#666;";
  sensiHint.textContent = "Copilot prêt.";

  top.appendChild(title);
  top.appendChild(sensiHint);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;";

  const buttons = [
    { label: "Analyser fichier", action: "analyze-latest" },
    { label: "Résumer", action: "summarize" },
    { label: "Web", action: "web" },
    { label: "Word", action: "docx" },
    { label: "Excel", action: "xlsx" },
    { label: "PPT", action: "pptx" },
    { label: "Image", action: "image" },
    { label: "Effacer Sensi", action: "delete-sensi" },
    { label: "Export projet", action: "export-project" },
    { label: "Share project", action: "toggle-share-project" },
    { label: "Aide", action: "help" },
  ];

  for (const item of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
    btn.dataset.sensiAction = item.action;
    btn.style.cssText = [
      "border:1px solid #ddd",
      "background:white",
      "border-radius:999px",
      "padding:6px 10px",
      "cursor:pointer",
      "font-size:12px",
    ].join(";");
    actions.appendChild(btn);
  }

  const quick = document.createElement("div");
  quick.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";

  sensiQuickInput = document.createElement("input");
  sensiQuickInput.type = "text";
  sensiQuickInput.placeholder = "Prompt rapide Sensi…";
  sensiQuickInput.style.cssText = [
    "flex:1",
    "min-width:240px",
    "border:1px solid #ddd",
    "border-radius:10px",
    "padding:8px 10px",
    "font-size:13px",
  ].join(";");

  const fillBtn = document.createElement("button");
  fillBtn.type = "button";
  fillBtn.textContent = "Mettre dans le message";
  fillBtn.dataset.sensiAction = "fill-input";
  fillBtn.style.cssText = [
    "border:1px solid #ddd",
    "background:white",
    "border-radius:10px",
    "padding:8px 10px",
    "cursor:pointer",
    "font-size:12px",
  ].join(";");

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.textContent = "Envoyer à Sensi";
  sendBtn.dataset.sensiAction = "send-quick";
  sendBtn.style.cssText = [
    "border:1px solid #d8c8ff",
    "background:#f7f2ff",
    "border-radius:10px",
    "padding:8px 10px",
    "cursor:pointer",
    "font-size:12px",
  ].join(";");

  quick.appendChild(sensiQuickInput);
  quick.appendChild(fillBtn);
  quick.appendChild(sendBtn);

  shareProjectWrap = document.createElement("div");
  shareProjectWrap.style.cssText = "display:none;gap:8px;align-items:center;flex-wrap:wrap;";

  const shareLabel = document.createElement("span");
  shareLabel.textContent = "Email :";
  shareLabel.style.cssText = "font-size:12px;color:#555;";

  shareProjectEmailInput = document.createElement("input");
  shareProjectEmailInput.type = "email";
  shareProjectEmailInput.placeholder = "destinataire@exemple.com";
  shareProjectEmailInput.style.cssText = [
    "flex:1",
    "min-width:240px",
    "border:1px solid #ddd",
    "border-radius:10px",
    "padding:8px 10px",
    "font-size:13px",
  ].join(";");

  shareProjectSendBtn = document.createElement("button");
  shareProjectSendBtn.type = "button";
  shareProjectSendBtn.textContent = "Préparer le partage";
  shareProjectSendBtn.dataset.sensiAction = "send-share-project";
  shareProjectSendBtn.style.cssText = [
    "border:1px solid #ddd",
    "background:white",
    "border-radius:10px",
    "padding:8px 10px",
    "cursor:pointer",
    "font-size:12px",
  ].join(";");

  shareProjectWrap.appendChild(shareLabel);
  shareProjectWrap.appendChild(shareProjectEmailInput);
  shareProjectWrap.appendChild(shareProjectSendBtn);

  const examples = document.createElement("div");
  examples.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;";

  const chips = [
    "Sensi analyse ce fichier envoyé",
    "Sensi résume ce document",
    "Sensi fais une synthèse de la discussion",
    "Sensi cherche sur le web les dernières infos sur EverCell",
    "mémorise ça : Mel est mon épouse",
    "tu peux me tutoyer",
    "*flowers*",
  ];

  for (const txt of chips) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.sensiChip = txt;
    chip.textContent = txt;
    chip.style.cssText = [
      "border:1px dashed #ddd",
      "background:#fff",
      "border-radius:999px",
      "padding:5px 9px",
      "cursor:pointer",
      "font-size:11px",
      "color:#555",
    ].join(";");
    examples.appendChild(chip);
  }

  sensiBar.appendChild(top);
  sensiBar.appendChild(actions);
  sensiBar.appendChild(quick);
  sensiBar.appendChild(shareProjectWrap);
  sensiBar.appendChild(examples);

  form.parentNode.insertBefore(sensiBar, form);

  sensiBar.addEventListener("click", (e) => {
    const actionBtn = e.target?.closest?.("[data-sensi-action]");
    const chipBtn = e.target?.closest?.("[data-sensi-chip]");

    if (chipBtn) {
      putPromptInInput(chipBtn.getAttribute("data-sensi-chip"), { replace: true });
      return;
    }

    if (!actionBtn) return;
    const action = cleanStr(actionBtn.getAttribute("data-sensi-action"));

    if (action === "analyze-latest") return putPromptInInput(inferNaturalAnalyzePrompt(), { replace: true });
    if (action === "summarize") return putPromptInInput(inferNaturalSummaryPrompt(), { replace: true });
    if (action === "web") return putPromptInInput(inferNaturalWebPrompt(), { replace: true });
    if (action === "docx") return putPromptInInput(inferNaturalDocxPrompt(), { replace: true });
    if (action === "xlsx") return putPromptInInput(inferNaturalXlsxPrompt(), { replace: true });
    if (action === "pptx") return putPromptInInput(inferNaturalPptxPrompt(), { replace: true });
    if (action === "image") return putPromptInInput(inferNaturalImagePrompt(), { replace: true });
    if (action === "delete-sensi") return triggerDeleteSensiMessages();
    if (action === "export-project") return triggerProjectExport();
    if (action === "toggle-share-project") return toggleShareProjectUi();
    if (action === "send-share-project") return triggerProjectShare();
    if (action === "help") return sendAssistantPrompt("/help");

    if (action === "fill-input") {
      const txt = cleanStr(sensiQuickInput?.value);
      if (!txt) return;
      putPromptInInput(txt, { replace: true });
      return;
    }

    if (action === "send-quick") {
      const txt = cleanStr(sensiQuickInput?.value);
      if (!txt) return;
      sendAssistantPrompt(txt);
      sensiQuickInput.value = "";
    }
  });

  sensiQuickInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const txt = cleanStr(sensiQuickInput.value);
      if (!txt) return;
      sendAssistantPrompt(txt);
      sensiQuickInput.value = "";
    }
  });

  shareProjectEmailInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerProjectShare();
    }
  });

  refreshSensiBarState();
}

function refreshSensiBarState(detail = "") {
  ensureSensiBar();
  if (!sensiHint) return;

  if (!socketReady) {
    sensiHint.textContent = detail || "Copilot en attente du socket.";
    return;
  }

  if (!cleanStr(currentProject)) {
    sensiHint.textContent = "Choisis puis rejoins un projet pour utiliser Sensi.";
    return;
  }

  if (lastDetectedAiEnabled === false) {
    sensiHint.textContent = "Serveur OK mais IA désactivée côté backend.";
    return;
  }

  if (lastUploadedFileInfo?.filename) {
    sensiHint.textContent = `Dernier fichier: ${lastUploadedFileInfo.filename}`;
    return;
  }

  sensiHint.textContent = `Projet courant: ${currentProject}`;
}

/* ======================================================
   Health check
   ====================================================== */

async function refreshHealth() {
  try {
    const res = await fetch("/health", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    sensiLastHealth = data || null;

    try { localStorage.setItem(LS_LAST_HEALTH, JSON.stringify(data || {})); } catch {}

    if (!res.ok || !data?.ok) {
      setHealthStatus("error");
      setAiStatus("unknown");
      lastDetectedAiEnabled = null;
      refreshSensiBarState("Serveur /health indisponible.");
      return;
    }

    const version = cleanStr(data.version || "unknown");
    const ai = cleanStr(data.ai || "");
    const model = cleanStr(data.ai_model_text || "");
    const autoAnalyze = Boolean(data?.features?.file_analysis);

    setHealthStatus(`ok (${version})`);
    setAiStatus(ai === "enabled" ? `enabled (${model || "model?"})` : "disabled");

    lastDetectedAiEnabled = ai === "enabled";

    if (uploadState && autoAnalyze && cleanStr(uploadState.textContent) === "") {
      // no-op volontaire
    }

    refreshSensiBarState();
  } catch {
    setHealthStatus("offline?");
    setAiStatus("unknown");
    lastDetectedAiEnabled = null;
    refreshSensiBarState("Impossible de lire /health.");
  }
}

function restoreLastHealthHint() {
  try {
    const raw = localStorage.getItem(LS_LAST_HEALTH);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data?.version) setHealthStatus(`cached (${data.version})`);
    if (data?.ai) setAiStatus(`cached (${data.ai})`);
  } catch {}
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

  const actionButtons = `
    <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
      <button type="button"
        data-ai-quick="analyze-latest"
        title="Demander à Sensi d’analyser le dernier fichier"
        style="border:1px solid #ddd;background:#fff;border-radius:999px;padding:4px 8px;cursor:pointer;font-size:11px;">
        ✨ Analyser
      </button>
      <button type="button"
        data-ai-quick="summarize-latest"
        title="Demander un résumé du dernier fichier"
        style="border:1px solid #ddd;background:#fff;border-radius:999px;padding:4px 8px;cursor:pointer;font-size:11px;">
        📝 Résumer
      </button>
    </div>
  `;

  if (isImg) {
    return `
      <div style="margin-top:6px;">
        <a href="${url}" target="_blank" rel="noopener">🖼️ ${name}</a><br/>
        <img src="${url}" alt="${name}"
             style="max-width:260px; border:1px solid #ddd; border-radius:10px; margin-top:6px;" />
        ${actionButtons}
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
        ${actionButtons}
      </div>
    `;
  }

  return `
    <div style="margin-top:6px;">
      <a href="${url}" target="_blank" rel="noopener">📄 ${name}</a>
      ${actionButtons}
    </div>
  `;
}

function addMessage({ id, ts, username, userId, message, attachment }) {
  const mid = Number(id);
  if (Number.isFinite(mid) && seenMessageIds.has(mid)) return;
  if (Number.isFinite(mid)) seenMessageIds.add(mid);

  const time = formatTime(ts);
  const row = document.createElement("div");
  row.className = "msg msg-row";
  if (Number.isFinite(mid)) row.dataset.mid = String(mid);

  const isSensi = detectIsSensiMessage(username);
  const canDelete =
    (cleanStr(userId) && cleanStr(userId) === cleanStr(myUserId)) ||
    isSensi;

  row.innerHTML = `
    <div class="msg-main" style="display:flex; gap:10px; align-items:flex-start;">
      <div style="flex:1;">
        <span class="time">${time ? `[${time}]` : ""}</span>
        <strong>${isSensi ? "✨ " : ""}${escapeHtml(username)}:</strong>
        <span class="text">${renderRichText(message)}</span>
        ${attachment ? renderAttachment(attachment) : ""}
      </div>
      ${canDelete && Number.isFinite(mid) ? `
        <button type="button"
          data-del="1"
          data-mid="${String(mid)}"
          title="Supprimer ce message"
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

chat.addEventListener("click", (e) => {
  const delBtn = e.target?.closest?.("button[data-del='1']");
  if (delBtn) {
    const mid = Number(delBtn.getAttribute("data-mid"));
    if (!Number.isFinite(mid)) return;
    if (!currentProject) return;

    const ok = confirm("Supprimer ce message ?");
    if (!ok) return;

    if (!socket) return alert("Socket non prêt.");

    socket.emit("deleteMessage", { project: currentProject, messageId: mid }, (resp) => {
      if (resp?.ok) {
        removeMessageNode(mid);
        return;
      }

      socket.emit("deleteMessage", mid, (legacyResp) => {
        if (legacyResp?.ok) {
          removeMessageNode(mid);
          return;
        }
        alert("Suppression impossible: " + (resp?.error || legacyResp?.error || "unknown"));
      });
    });
    return;
  }

  const aiBtn = e.target?.closest?.("[data-ai-quick]");
  if (!aiBtn) return;

  const action = cleanStr(aiBtn.getAttribute("data-ai-quick"));
  if (action === "analyze-latest") {
    sendAssistantPrompt(inferNaturalAnalyzePrompt());
    return;
  }
  if (action === "summarize-latest") {
    sendAssistantPrompt("Sensi résume ce fichier envoyé");
  }
});

/* ======================================================
   Projects list
   ====================================================== */

function getProjectListFromSelect() {
  return Array.from(projectSelect?.options || []).map((o) => cleanStr(o.value)).filter(Boolean);
}

function refreshDeleteProjectState() {
  if (!deleteProjectBtn || !projectSelect) return;

  const selected = cleanStr(projectSelect.value);
  const list = getProjectListFromSelect();
  const protectedProject = !selected || selected === DEFAULT_PROJECT || list.length <= 1;
  const blocked = !socketReady || protectedProject;

  deleteProjectBtn.disabled = blocked;
  if (!socketReady) {
    deleteProjectBtn.title = "Chargement du socket...";
    return;
  }

  deleteProjectBtn.title = protectedProject
    ? 'Le projet "global" et le dernier projet restant ne peuvent pas être supprimés.'
    : "Supprimer le projet sélectionné";
}

function setProjectsOptions(projects, keepSelection = true) {
  const prev = keepSelection ? cleanStr(projectSelect.value) : "";
  const normalized = [];
  for (const p of (projects || [])) {
    const name = cleanStr(p);
    if (name && !normalized.includes(name)) normalized.push(name);
  }
  if (!normalized.includes(DEFAULT_PROJECT)) normalized.unshift(DEFAULT_PROJECT);

  projectSelect.innerHTML = "";

  for (const name of normalized) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    projectSelect.appendChild(opt);
  }

  if (keepSelection && prev) {
    const exists = normalized.includes(prev);
    if (exists) projectSelect.value = prev;
  }

  if (!projectSelect.value && projectSelect.options.length > 0) {
    projectSelect.value = projectSelect.options[0].value;
  }

  refreshDeleteProjectState();
}

/* ======================================================
   Presence rendering (tolerant)
   ====================================================== */

function renderPresence(users) {
  if (!usersList || !usersCount) return;

  const arr = Array.isArray(users) ? users : [];
  usersCount.textContent = String(arr.length);

  usersList.innerHTML = "";
  for (const u of arr) {
    const li = document.createElement("li");

    const name = cleanStr(u?.username || u?.name || u?.user || u?.displayName) || "—";
    const uid = cleanStr(u?.userId || u?.id || "");

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

function sendTextMessage(text, options = {}) {
  if (!currentProject) {
    alert("Rejoins un projet d’abord 🙂");
    return false;
  }

  const username = cleanStr(usernameInput.value);
  if (!username) {
    alert("Entre un pseudo 🙂");
    return false;
  }

  const message = cleanStr(text);
  if (!message) return false;

  if (!socket || !socket.connected) {
    alert("Socket non connecté.");
    return false;
  }

  const now = Date.now();
  const sig = normalizedMessageSignature(currentProject, username, message);
  const bypassDedupe = Boolean(options?.bypassDedupe);

  if (!bypassDedupe && sig && sig === lastSentSignature && now - lastSentAt < SEND_DEDUP_MS) {
    console.warn("Duplicate message blocked:", sig);
    if (voiceHint) voiceHint.textContent = "⚠️ Envoi doublon bloqué.";
    return false;
  }

  lastSentSignature = sig;
  lastSentAt = now;

  currentUsername = username;
  saveLastSession();

  socket.emit("chatMessage", { username, userId: myUserId, message, project: currentProject });
  return true;
}

/* ======================================================
   VOICE / AUDIO / FFT
   ====================================================== */

const ENABLE_VOICE = true;
const VOICE_APPEND_TO_INPUT = true;
const VOICE_SEND_ON_OVER = true;
const VOICE_OVER_WORD = "over";

const VOICE_TRIGGERS = [
  "over",
  "hover",
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

function normalizeVoiceText(text) {
  return cleanStr(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "'")
    .replace(/[^a-zA-Z0-9\s'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildTriggerEndRegex() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const aliases = Array.from(new Set([
    ...VOICE_TRIGGERS,
    "hover",
    "au vert",
    "ouvert",
    "ovaire",
    "haut vert",
  ].map((t) => normalizeVoiceText(t)).filter(Boolean)));

  const parts = aliases
    .sort((a, b) => b.length - a.length)
    .map((t) => t.split(/\s+/).map(esc).join("\\s+"));

  return new RegExp(`(?:${parts.join("|")})\\s*[\\.!\\?,;:\\u2026]*\\s*$`, "i");
}
const TRIGGER_END_RE = buildTriggerEndRegex();

function hasVoiceTriggerAtEnd(text) {
  const t = normalizeVoiceText(text);
  if (!t) return false;
  return TRIGGER_END_RE.test(t);
}

function stripVoiceTriggerAtEnd(text) {
  const original = cleanStr(text);
  if (!original) return "";
  const normalized = normalizeVoiceText(original);
  if (!normalized) return original;
  if (!TRIGGER_END_RE.test(normalized)) return original;

  const without = cleanStr(normalized.replace(TRIGGER_END_RE, ""));
  if (!without) return "";

  const originalWords = original.split(/\s+/).filter(Boolean);
  const normalizedWords = normalized.split(/\s+/).filter(Boolean);
  const keepCount = without.split(/\s+/).filter(Boolean).length;
  return cleanStr(originalWords.slice(0, Math.min(keepCount, normalizedWords.length)).join(" "));
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
  } catch {
    return false;
  }
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
let voiceMode = null;

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

let segRecorder = null;
let segChunks = [];
let segTimer = null;
let segInFlight = false;
let segAccumulatedText = "";
let segQueue = Promise.resolve();

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
      setUploadState("Upload audio…");
      const ext = guessExtFromMime(recBlob.type) || "webm";
      const file = new File([recBlob], `audio_${Date.now()}.${ext}`, { type: recBlob.type || "audio/webm" });
      const data = await uploadFile(file);
      recBlob = null;
      lastUploadedFileInfo = data || null;
      setUploadState(data?.auto_analyze ? "Audio envoyé ✅ analyse automatique en cours…" : "Audio envoyé ✅");
      setTimeout(() => { setUploadState(""); }, 2500);
      refreshSensiBarState();
    } catch (e) {
      console.error(e);
      alert(`Erreur upload audio: ${e?.message || e}`);
      setUploadState("");
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

function composeVoiceInput(previewText) {
  const base = cleanStr(voiceInputBase);
  const preview = cleanStr(previewText);
  return cleanStr([base, preview].filter(Boolean).join(" "));
}

function sendVoiceMessageOnce(text) {
  if (voiceAutoSending) return false;
  voiceAutoSending = true;
  const ok = sendTextMessage(text);
  setTimeout(() => { voiceAutoSending = false; }, SEND_DEDUP_MS);
  return ok;
}

async function ensureMicStream() {
  if (mediaStream) return mediaStream;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    },
  });
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
  voiceInputBase = cleanStr(input.value);
  voiceAutoSending = false;

  try {
    await ensureMicStream();
    await ensureAnalyser();
    startFft();
  } catch (e) {
    console.error(e);
    alert("Micro refusé / indisponible.");
    return;
  }

  if (("webkitSpeechRecognition" in window) || ("SpeechRecognition" in window)) {
    voiceMode = "speech";
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "fr-FR";

    recognition.onerror = (e) => {
      console.warn("SpeechRecognition error", e);
      const code = cleanStr(e?.error || "error");
      const label =
        code === "no-speech" ? "aucune voix détectée" :
        code === "audio-capture" ? "micro indisponible" :
        code === "not-allowed" ? "micro refusé" :
        code;
      if (voiceHint) voiceHint.textContent = `⚠️ Voice: ${label}`;
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
        input.value = composeVoiceInput(combinedPreview);
      }

      if (VOICE_SEND_ON_OVER && hasVoiceTriggerAtEnd(combinedRaw)) {
        const msg = cleanStr(composeVoiceInput(stripVoiceTriggerAtEnd(combinedRaw)));
        if (msg) {
          const sent = sendVoiceMessageOnce(msg);
          if (sent) {
            input.value = "";
            input.focus();
            if (voiceHint) voiceHint.textContent = "✅ Envoyé (voice)";
            stopListening();
          }
        }
      }
    };

    isListening = true;
    setVoiceButtonState();
    if (voiceHint) voiceHint.textContent = `🎧 Écoute : dis "${VOICE_OVER_WORD}" (ou "hover"/"ouvre"/"terminé"/"au revoir") pour envoyer.`;
    try { recognition.start(); } catch {}
    return;
  }

  voiceMode = "segment";
  segAccumulatedText = "";
  if (voiceHint) voiceHint.textContent = `🎧 Dictée Firefox : parle, puis dis "${VOICE_OVER_WORD}" / "hover" / "ouvre" / "terminé" / "au revoir" pour envoyer.`;

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
              input.value = composeVoiceInput(preview);
            }

            if (VOICE_SEND_ON_OVER && hasVoiceTriggerAtEnd(segAccumulatedText)) {
              const msg = cleanStr(composeVoiceInput(stripVoiceTriggerAtEnd(segAccumulatedText)));
              if (msg) {
                const sent = sendVoiceMessageOnce(msg);
                if (sent) {
                  input.value = "";
                  input.focus();
                }
              }
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
  if (voiceHint) voiceHint.textContent = "⏸️ Écoute stoppée.";

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
  voiceInputBase = "";

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
   FORM submit
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
      setUploadState(`Upload "${file.name}"...`);
      if (submitBtn) submitBtn.disabled = true;

      const data = await uploadFile(file);
      lastUploadedFileInfo = {
        filename: cleanStr(data?.filename || file.name),
        mimetype: cleanStr(data?.mimetype || file.type),
        size: Number(data?.size || file.size || 0),
        url: cleanStr(data?.url),
        auto_analyze: Boolean(data?.auto_analyze),
      };

      setUploadState(data?.auto_analyze ? "Upload OK ✅ analyse automatique en cours…" : "Upload OK ✅");
      if (fileInput) fileInput.value = "";
      input.value = "";
      input.focus();
      refreshSensiBarState();
      setTimeout(() => { setUploadState(""); }, 2500);
      return;
    }

    if (!message) return;

    const sent = sendTextMessage(message);
    if (sent) {
      input.value = "";
      input.focus();
    }
  } catch (err) {
    console.error(err);
    alert(`Erreur: ${err?.message || err}`);
    setUploadState("");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

/* ======================================================
   JOIN / CREATE / DELETE project
   ====================================================== */

function joinProject(options = {}) {
  const username = cleanStr(usernameInput.value);
  const project = cleanStr(projectSelect.value) || DEFAULT_PROJECT;
  const silentIfPending = Boolean(options?.silentIfPending);

  if (!username) return alert("Entre un pseudo 🙂");
  if (!project) return alert("Aucun projet disponible.");

  currentUsername = username;
  currentProject = project;
  saveLastSession();
  setProjectLabel(currentProject);

  if (!socket || !socketReady) {
    if (!silentIfPending) queueJoinUntilSocketReady();
    return;
  }

  if (!socket.connected) {
    pendingJoinRequested = true;
    if (!silentIfPending) addSystem("⏳ Socket pas encore connecté... la connexion sera rejouée automatiquement.");
    return;
  }

  pendingJoinRequested = false;

  renderPresence([]);
  clearChat();
  addSystem(`Connexion au projet "${currentProject}"...`);

  socket.emit("joinProject", { username: currentUsername, project: currentProject, userId: myUserId });
  socket.emit("getProjects");

  updateVoiceUiGate();
  refreshSensiBarState();
}

joinBtn.addEventListener("click", joinProject);
usernameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinProject(); });
usernameInput.addEventListener("input", () => {
  updateVoiceUiGate();
  refreshSensiBarState();
});
projectSelect.addEventListener("change", () => {
  refreshDeleteProjectState();
  refreshSensiBarState();
});
refreshDeleteProjectState();

function isValidProjectName(name) {
  return /^[a-zA-Z0-9 _.\-]{2,50}$/.test(cleanStr(name));
}

if (createProjectBtn && newProjectInput) {
  const requestCreateProject = (nameRaw) => {
    const name = cleanStr(nameRaw);
    if (!name) return;
    if (!isValidProjectName(name)) return alert("Nom invalide (2-50, lettres/chiffres/espaces/_-.)");
    if (!socket || !socketReady) return alert("Socket en cours de chargement... réessaie dans un instant.");

    socket.emit("createProject", { name }, (resp) => {
      if (!resp || resp.ok !== true) {
        alert(resp?.message || "Erreur création projet");
        return;
      }

      const list = Array.isArray(resp.projects) ? resp.projects : [];
      if (list.length > 0) setProjectsOptions(list, false);
      if (resp.project) projectSelect.value = resp.project;

      refreshDeleteProjectState();
      addSystem(`✅ Projet créé: "${resp.project}"`);
      refreshSensiBarState();
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
    if (!socket || !socketReady) return alert("Socket en cours de chargement... réessaie dans un instant.");
    socket.emit("deleteProject", { project: p }, (resp) => {
      if (resp?.ok !== true) {
        alert(resp?.message || "Suppression impossible.");
        return;
      }
      addSystem(`🗑️ Projet supprimé: "${p}"`);
    });
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
    setProjectsOptions(list, true);

    const want = cleanStr(last?.p);
    if (want && getProjectListFromSelect().includes(want)) projectSelect.value = want;

    refreshDeleteProjectState();
    updateVoiceUiGate();
    refreshSensiBarState();
    return;
  } catch (_) {}

  setProjectsOptions([DEFAULT_PROJECT], true);
  refreshDeleteProjectState();
  refreshSensiBarState();
  if (socket) socket.emit("getProjects");
}

/* ======================================================
   SOCKET + EVENTS
   ====================================================== */

async function initSocket() {
  setSocketUiReady(false, "Chargement du socket...");
  setSocketStatus("connecting…");

  const ioFn = await waitForIo();
  if (!ioFn) {
    setSocketStatus("ERROR (io not loaded)");
    setSocketUiReady(false, "Socket.IO indisponible");
    alert("Socket.IO n’a pas pu se charger (io is undefined). Vérifie le CDN ou le chargement du script.");
    return null;
  }

  socket = ioFn(window.location.origin, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 600,
    timeout: 20000,
  });

  window.socket = socket;

  socket.on("connect", () => {
    setSocketStatus(`connected (${socket.id})`);
    setSocketUiReady(true);
    flushPendingJoinIfNeeded();
  });

  socket.on("disconnect", () => {
    setSocketStatus("disconnected");
    setSocketUiReady(false, "Socket déconnecté... reconnexion en cours.");
  });

  socket.on("connect_error", (err) => {
    setSocketStatus(`error (${err?.message || "?"})`);
    setSocketUiReady(false, "Erreur de connexion socket");
  });

  socket.on("chatHistory", (payload) => {
    const p = cleanStr(payload?.project);
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!currentProject || p !== currentProject) return;

    clearChat();
    if (msgs.length === 0) return addSystem(`Historique vide pour "${currentProject}".`);
    addSystem(`Historique chargé pour "${currentProject}" (${msgs.length} message(s)).`);

    for (const m of msgs) {
      addMessage(m);
      if (m?.attachment?.filename) {
        lastUploadedFileInfo = {
          filename: cleanStr(m.attachment.filename),
          mimetype: cleanStr(m.attachment.mimetype),
          size: Number(m.attachment.size || 0),
          url: cleanStr(m.attachment.url),
        };
      }
    }
    refreshSensiBarState();
  });

  socket.on("chatMessage", (data) => {
    if (!currentProject) return;
    const p = cleanStr(data?.project);
    if (p && p !== currentProject) return;

    addMessage(data);

    if (data?.attachment?.filename) {
      lastUploadedFileInfo = {
        filename: cleanStr(data.attachment.filename),
        mimetype: cleanStr(data.attachment.mimetype),
        size: Number(data.attachment.size || 0),
        url: cleanStr(data.attachment.url),
      };
      refreshSensiBarState();
    }

    if (detectIsSensiMessage(data?.username)) {
      setUploadState("");
      refreshSensiBarState();
    }
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

  socket.on("bulkMessagesDeleted", ({ project, messageIds }) => {
    const p = cleanStr(project);
    if (currentProject && p && p !== currentProject) return;
    for (const messageId of Array.isArray(messageIds) ? messageIds : []) {
      removeMessageNode(messageId);
    }
  });

  socket.on("deleteSensiMessagesDone", ({ project, messageIds }) => {
    const p = cleanStr(project);
    if (currentProject && p && p !== currentProject) return;
    if (Array.isArray(messageIds) && messageIds.length) {
      for (const messageId of messageIds) removeMessageNode(messageId);
    } else {
      removeAllVisibleSensiMessages();
    }
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
    refreshSensiBarState();
  });

  socket.on("projectDeleted", ({ project, fallbackProject }) => {
    const p = cleanStr(project);
    const fallback = cleanStr(fallbackProject) || DEFAULT_PROJECT;

    if (currentProject && p === currentProject) {
      currentProject = fallback;
      projectSelect.value = fallback;
      setProjectLabel(fallback);
      clearChat();
      addSystem(`Le projet "${p}" a été supprimé. Bascule automatique vers "${fallback}".`);
      renderPresence([]);
      pendingJoinRequested = true;
      flushPendingJoinIfNeeded();
      refreshSensiBarState();
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

  await loadProjectsOnce();
  return socket;
}

/* ======================================================
   INIT
   ====================================================== */

setSocketUiReady(false, "Chargement du socket...");
restoreLastHealthHint();

(function initVoice() {
  if (!ENABLE_VOICE) return;
  ensureVoiceUI();
  updateVoiceUiGate();
})();

(function initSensi() {
  ensureSensiBar();
  refreshSensiBarState();
})();

setProjectsOptions([DEFAULT_PROJECT], false);
setProjectLabel(DEFAULT_PROJECT);

refreshHealth().catch(() => {});
setInterval(() => {
  refreshHealth().catch(() => {});
}, 20000);

initSocket().catch((err) => {
  console.error("initSocket failed", err);
  setSocketStatus(`fatal (${err?.message || "?"})`);
  setSocketUiReady(false, "Initialisation socket impossible");
  addSystem("⚠️ Initialisation du socket impossible. Recharge la page ou vérifie le serveur.");
});

window.addEventListener("beforeunload", () => {
  try { stopListening(); } catch {}
  try { stopRecording(); } catch {}
  try {
    if (socket && socket.connected) {
      socket.emit("leaveProject");
      socket.disconnect();
    }
  } catch {}
});
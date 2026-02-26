// guibs:/client.js
"use strict";

// anti double-load (sinon tu vois tout en double)
if (window.__SENSI_ALREADY_INIT__) {
  console.warn("[Sensi] client.js déjà initialisé — stop.");
} else {
  window.__SENSI_ALREADY_INIT__ = true;

  const socket = io();

  // Projet "hors projet"
  const GLOBAL_PROJECT = "__GLOBAL__";
  const GLOBAL_LABEL = "Global (hors projet)";

  let currentProject = null;

  // DOM
  const chat = document.getElementById("chat");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("message");
  const usernameInput = document.getElementById("username");
  const projectSelect = document.getElementById("project");

  const newProjectInput = document.getElementById("new-project");
  const createProjectBtn = document.getElementById("create-project");
  const deleteProjectBtn = document.getElementById("delete-project");
  const joinBtn = document.getElementById("join");

  const attachBtn = document.getElementById("attach");
  const fileInput = document.getElementById("file");
  const filesBox = document.getElementById("files");

  const micBtn = document.getElementById("mic");

  const viz = document.getElementById("viz");
  const vizLabel = document.getElementById("viz-label");

  const usersBox = document.getElementById("users");
  const usersCount = document.getElementById("users-count");
  const activeProjectLabel = document.getElementById("active-project-label");

  const seenMessageIds = new Set();
  let filesPollTimer = null;

  // ============== Utils ==============
  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getUsername() {
    return String(usernameInput?.value || "").trim() || "Guibs";
  }

  function clearChat() {
    chat.innerHTML = "";
    seenMessageIds.clear();
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${url} -> ${res.status} ${res.statusText} ${txt}`);
    }
    return res.json();
  }

  function normalizeProjects(payload) {
    if (!Array.isArray(payload)) return [];
    return payload.map(String).filter(Boolean);
  }

  function setProjectsInSelect(projectNames) {
    projectSelect.innerHTML = "";

    // inject "Global"
    const optGlobal = document.createElement("option");
    optGlobal.value = GLOBAL_PROJECT;
    optGlobal.textContent = GLOBAL_LABEL;
    projectSelect.appendChild(optGlobal);

    // projets normaux
    const list = Array.isArray(projectNames) ? projectNames : [];
    const finalList = list.length ? list : ["test"];

    for (const name of finalList) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      projectSelect.appendChild(opt);
    }

    // default : si currentProject déjà set, garde-le
    if (currentProject) projectSelect.value = currentProject;
    currentProject = projectSelect.value;
  }

  function normalizeMessage(m) {
    return {
      id: m?.id,
      project: m?.project ?? "",
      username: m?.username ?? "Anonyme",
      message: m?.message ?? m?.content ?? "",
      role: m?.role ?? null,
      is_system: Boolean(m?.is_system),
    };
  }

  function addMessageRow(raw) {
    const m = normalizeMessage(raw);
    if (!m.id) return;

    // éviter les doublons (très important)
    if (seenMessageIds.has(m.id)) return;
    seenMessageIds.add(m.id);

    const row = document.createElement("div");
    row.className = "msg";
    row.dataset.id = m.id;

    const leftClass = m.is_system ? "msg-left sys" : "msg-left";

    row.innerHTML = `
      <div class="${leftClass}">
        ${m.is_system ? escapeHtml(m.message) : `<strong>${escapeHtml(m.username)}:</strong> ${escapeHtml(m.message)}`}
      </div>
      <div class="msg-right">
        ${m.is_system ? "" : `<button class="msg-del" title="Supprimer ce message">🗑</button>`}
      </div>
    `;

    const delBtn = row.querySelector(".msg-del");
    if (delBtn) {
      delBtn.addEventListener("click", () => {
        if (!currentProject) return;
        socket.emit("deleteMessage", { id: m.id, project: currentProject });
      });
    }

    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  }

  function setVizLabel(t) {
    if (vizLabel) vizLabel.textContent = t;
  }

  // ============== Presence sidebar ==============
  function renderUsers(project, users) {
    if (activeProjectLabel) {
      activeProjectLabel.textContent = project === GLOBAL_PROJECT ? GLOBAL_LABEL : project;
    }
    const list = Array.isArray(users) ? users : [];
    if (usersCount) usersCount.textContent = String(list.length);

    if (!usersBox) return;
    usersBox.innerHTML = "";

    if (list.length === 0) {
      usersBox.innerHTML = `<div class="muted" style="margin-top:8px;">Personne n'est connecté.</div>`;
      return;
    }

    for (const u of list) {
      const div = document.createElement("div");
      div.className = "user";
      div.textContent = u;
      usersBox.appendChild(div);
    }
  }

  // ============== Files (optionnel) ==============
  function formatBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
    return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function stopFilesPolling() {
    if (filesPollTimer) clearInterval(filesPollTimer);
    filesPollTimer = null;
  }

  function startFilesPolling(project) {
    stopFilesPolling();
    filesPollTimer = setInterval(async () => {
      if (!currentProject || currentProject !== project) return;
      try {
        const hasPending = await loadFiles(project);
        if (!hasPending) stopFilesPolling();
      } catch (e) {
        console.warn("[Sensi] files polling error:", e?.message || e);
      }
    }, 2000);
  }

  async function loadFiles(project) {
    if (!filesBox) return false;
    if (!project || project === GLOBAL_PROJECT) {
      filesBox.innerHTML = `<div class="muted">Fichiers désactivés en Global.</div>`;
      return false;
    }

    // si ton serveur n'a pas /files -> ça tombera en erreur (et c'est ok)
    const files = await fetchJson(`/files?project=${encodeURIComponent(project)}`);
    if (!Array.isArray(files) || files.length === 0) {
      filesBox.innerHTML = `<div class="muted">Aucun fichier pour ce projet.</div>`;
      return false;
    }

    filesBox.innerHTML = "";
    let hasPending = false;

    for (const f of files) {
      const analyzed = Boolean(f.analyzed_at);
      if (!analyzed) hasPending = true;

      const item = document.createElement("div");
      item.className = "file";
      item.innerHTML = `
        <div>
          <div class="file-name">${analyzed ? "✅" : "⏳"} ${escapeHtml(f.filename)}</div>
          <div class="file-meta">${escapeHtml(f.mime_type || "?")} • ${formatBytes(f.size_bytes)} • ${analyzed ? "analysé" : "analyse…"}</div>
        </div>
        <div class="file-actions">
          <button class="file-del" title="Supprimer">🗑</button>
        </div>
      `;

      item.querySelector(".file-del").addEventListener("click", async () => {
        await fetch(`/files/${encodeURIComponent(f.id)}`, { method: "DELETE" });
        const pending = await loadFiles(currentProject);
        if (!pending) stopFilesPolling();
      });

      filesBox.appendChild(item);
    }

    return hasPending;
  }

  // ============== Projects + history ==============
  async function loadProjects() {
    const list = normalizeProjects(await fetchJson("/projects"));
    setProjectsInSelect(list);
  }

  async function loadHistory(project) {
    if (!project) return;
    clearChat();

    const messages = await fetchJson(`/messages?project=${encodeURIComponent(project)}`);
    for (const m of messages) addMessageRow(m);
  }

  async function joinProject(project) {
    const p = String(project || "").trim();
    if (!p) return;

    currentProject = p;
    projectSelect.value = p;

    // join socket room + broadcast presence
    socket.emit("joinProject", { project: p, username: getUsername() });

    await loadHistory(p);

    // files (optionnel)
    try {
      const hasPending = await loadFiles(p);
      if (hasPending) startFilesPolling(p);
      else stopFilesPolling();
    } catch {
      // serveur sans /files -> ignore
      if (filesBox) filesBox.innerHTML = `<div class="muted">Module fichiers non activé.</div>`;
      stopFilesPolling();
    }
  }

  // ============== Send message + auto "over" ==============
  function stripDictationTag(s) {
    return String(s || "").replace(/\s*\[dictée:.*\]$/, "").trim();
  }

  function shouldSendOnOver(text) {
    const t = String(text || "").toLowerCase();
    return /\bover\b/.test(t);
  }

  function removeOver(text) {
    return String(text || "")
      .replace(/\bover\b[.!?]*/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sendCurrentMessage() {
    const username = getUsername();
    const message = String(input.value || "").trim();
    const project = String(currentProject || projectSelect.value || "").trim();
    if (!project || !message) return;

    socket.emit("chatMessage", { project, username, message });
    input.value = "";
  }

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    input.value = stripDictationTag(input.value);
    sendCurrentMessage();
  });

  // ============== Upload file (optionnel) ==============
  attachBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const username = getUsername();
    const project = String(currentProject || projectSelect.value || "").trim();
    if (!project || project === GLOBAL_PROJECT) return;

    const fd = new FormData();
    fd.append("file", file);
    fd.append("project", project);
    fd.append("username", username);

    await fetch("/upload", { method: "POST", body: fd });
    fileInput.value = "";

    const hasPending = await loadFiles(project);
    if (hasPending) startFilesPolling(project);
  });

  // ============== Speech-to-text + visualizer ==============
  let recognition = null;
  let recognizing = false;

  let audioCtx = null;
  let analyser = null;
  let mediaStream = null;
  let rafId = null;

  function stopVisualizer() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    analyser = null;
    setVizLabel("Micro : prêt");
    if (viz) {
      const ctx = viz.getContext("2d");
      ctx.clearRect(0, 0, viz.width, viz.height);
    }
  }

  function drawLoop() {
    if (!analyser || !viz) return;

    const ctx = viz.getContext("2d");
    const W = viz.width;
    const H = viz.height;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, W, H);

    const bars = 64;
    const step = Math.max(1, Math.floor(data.length / bars));
    const barW = W / bars;

    for (let i = 0; i < bars; i++) {
      const v = data[i * step] || 0;
      const h = (v / 255) * H;

      ctx.fillStyle = "rgba(24,165,88,0.55)";
      ctx.fillRect(i * barW, H - h, barW - 2, h);
    }

    rafId = requestAnimationFrame(drawLoop);
  }

  async function startVisualizer() {
    if (!viz) return;
    try {
      if (!mediaStream) mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      const source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      setVizLabel("Micro : écoute + visualisation…");
      if (!rafId) drawLoop();
    } catch (e) {
      console.warn("[Sensi] visualizer error:", e);
      setVizLabel("Micro : permission refusée / indisponible");
    }
  }

  function setupSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtn?.setAttribute("disabled", "disabled");
      if (micBtn) micBtn.title = "Dictée vocale non supportée sur ce navigateur";
      return;
    }

    recognition = new SR();
    recognition.lang = "fr-FR";
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.onresult = (event) => {
      let finalText = "";
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t;
        else interim += t;
      }

      const base = stripDictationTag(input.value || "");

      if (interim) input.value = `${base} [dictée: ${interim}]`;

      if (finalText) {
        const next = `${base} ${finalText}`.replace(/\s+/g, " ").trim();

        if (shouldSendOnOver(next)) {
          input.value = removeOver(next);
          input.value = stripDictationTag(input.value);
          sendCurrentMessage();
        } else {
          input.value = next;
        }
      }
    };

    recognition.onerror = () => {
      recognizing = false;
      micBtn?.classList.remove("mic-on");
      stopVisualizer();
    };

    recognition.onend = () => {
      recognizing = false;
      micBtn?.classList.remove("mic-on");
      stopVisualizer();
    };
  }

  micBtn?.addEventListener("click", async () => {
    if (!recognition) return;

    if (!recognizing) {
      recognizing = true;
      micBtn.classList.add("mic-on");
      await startVisualizer();
      recognition.start();
    } else {
      recognizing = false;
      micBtn.classList.remove("mic-on");
      recognition.stop();
      stopVisualizer();
      input.value = stripDictationTag(input.value);
    }
  });

  // ============== UI events ==============
  joinBtn?.addEventListener("click", async () => joinProject(projectSelect.value));
  projectSelect?.addEventListener("change", async () => joinProject(projectSelect.value));

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
    if (!p || p === GLOBAL_PROJECT) return;

    await fetch(`/projects/${encodeURIComponent(p)}`, { method: "DELETE" });
    await loadProjects();
    await joinProject(projectSelect.value);
  });

  // ============== Socket listeners ==============
  socket.on("chatMessage", (raw) => {
    const msg = normalizeMessage(raw);
    if (msg.project === currentProject) addMessageRow(msg);
  });

  socket.on("systemMessage", (payload) => {
    // message système affiché dans le chat du projet courant
    if (payload?.project !== currentProject) return;
    addMessageRow({
      id: payload.id,
      project: payload.project,
      is_system: true,
      message: payload.text,
    });
  });

  socket.on("messageDeleted", ({ id }) => {
    const row = chat.querySelector(`.msg[data-id="${id}"]`);
    if (row) row.remove();
  });

  socket.on("presenceUpdate", ({ project, users }) => {
    // sidebar = projet actif seulement
    if (!project || project !== currentProject) return;
    renderUsers(project, users);
  });

  socket.on("connect", () => {
    if (currentProject) socket.emit("joinProject", { project: currentProject, username: getUsername() });
  });

  // ============== Init ==============
  (async function init() {
    if (!projectSelect) {
      console.error("[Sensi] #project not found in DOM");
      return;
    }
    setupSpeechRecognition();
    setVizLabel("Micro : prêt");

    await loadProjects();
    await joinProject(projectSelect.value);

    // sidebar label init
    renderUsers(currentProject, []);
  })();
}
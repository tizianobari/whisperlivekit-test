// Caption-only view for conference screens. Audio capture and transport follow
// live_transcription.js; rendering shows only the latest rows of text.

let isRecording = false;
let websocket = null;
let recorder = null;
let chunkDuration = 100;
let websocketUrl = "ws://localhost:8000/asr";
let userClosing = false;
let wakeLock = null;
let startTime = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let workletNode = null;
let recorderWorker = null;
let levelFrame = null;
let levelBuffer = null;
let waitingForStop = false;
let lastReceivedData = null;
let availableMicrophones = [];
let selectedMicrophoneId = null;
let serverUseAudioWorklet = null;
let configReadyResolve;
const configReady = new Promise((r) => (configReadyResolve = r));

// Auto-reconnect on unexpected WebSocket loss (same policy as the main page).
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shouldReconnect = false;
let mediaStream = null;

// Only the tail of the transcript is put in the DOM; the CSS row clip hides
// everything above the configured number of rows anyway.
const MAX_CAPTION_CHARS = 1500;
const FADE_DURATION_MS = 600;
const IDLE_DELAY_MS = 3000;
const RATE_WINDOW_MS = 5000;
const LAG_WARN_S = 1;
const LAG_BAD_S = 3;

const SETTINGS_KEY = "subtitleSettings";
const DEFAULT_SETTINGS = {
  rows: 2,
  fontSize: 56,
  lineHeight: 1.25,
  maxWidth: 90,
  margin: 5,
  position: "bottom",
  align: "center",
  fontFamily: "system",
  fontWeight: "600",
  textColor: "#ffffff",
  effect: "none",
  effectColor: "#000000",
  uppercase: false,
  dimPending: true,
  bgColor: "#000000",
  transparentBg: false,
  boxColor: "#000000",
  boxOpacity: 0,
  clearAfter: 0,
  showStats: true,
  statsCorner: "top-left",
};
const FONT_STACKS = {
  system: 'ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  arial: "Arial, Helvetica, sans-serif",
  verdana: "Verdana, Geneva, sans-serif",
  tahoma: "Tahoma, Verdana, sans-serif",
  trebuchet: '"Trebuchet MS", Helvetica, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  times: '"Times New Roman", Times, serif',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace',
};
const POSITION_JUSTIFY = { top: "flex-start", center: "center", bottom: "flex-end" };

const rootStyle = document.documentElement.style;
const statusText = document.getElementById("status");
const recordButton = document.getElementById("recordButton");
const fullscreenButton = document.getElementById("fullscreenButton");
const settingsToggle = document.getElementById("settingsToggle");
const settingsClose = document.getElementById("settingsClose");
const settingsPanel = document.getElementById("settingsPanel");
const websocketInput = document.getElementById("websocketInput");
const microphoneSelect = document.getElementById("microphoneSelect");
const clearButton = document.getElementById("clearButton");
const resetButton = document.getElementById("resetButton");
const captionBox = document.getElementById("captionBox");
const captionText = document.getElementById("captionText");
const captionCommitted = document.getElementById("captionCommitted");
const captionPending = document.getElementById("captionPending");
const statsPanel = document.getElementById("statsPanel");
const statConnection = document.getElementById("statConnection");
const statInput = document.getElementById("statInput");
const statTimer = document.getElementById("statTimer");
const statCompute = document.getElementById("statCompute");
const statPolicy = document.getElementById("statPolicy");
const statDiarization = document.getElementById("statDiarization");
const statRate = document.getElementById("statRate");
const statStatus = document.getElementById("statStatus");
const statLevel = document.getElementById("statLevel");
const statError = document.getElementById("statError");
const settingInputs = settingsPanel.querySelectorAll("[data-setting]");

function setStatus(text) {
  statusText.textContent = text || "";
  statusText.hidden = !text;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
  const merged = { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (saved && typeof saved[key] === typeof DEFAULT_SETTINGS[key]) {
        merged[key] = saved[key];
      }
    }
  } catch (e) {
    console.warn("Could not load subtitle settings:", e);
  }
  return merged;
}

let settings = loadSettings();

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("Could not save subtitle settings:", e);
  }
}

function hexToRgba(hex, alpha) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!match) return "transparent";
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatSetting(key, value) {
  switch (key) {
    case "fontSize":
      return `${value}px`;
    case "lineHeight":
      return Number(value).toFixed(2);
    case "maxWidth":
    case "boxOpacity":
      return `${value}%`;
    case "margin":
      return `${value}vh`;
    case "clearAfter":
      return value > 0 ? `${value}s` : "off";
    default:
      return String(value);
  }
}

function syncInputs() {
  settingInputs.forEach((input) => {
    const value = settings[input.dataset.setting];
    if (input.type === "checkbox") {
      input.checked = !!value;
    } else {
      input.value = value;
    }
  });
}

function readInput(input) {
  if (input.type === "checkbox") return input.checked;
  if (input.type === "range" || input.type === "number") return Number(input.value);
  return input.value;
}

function applySettings() {
  const effectColor = settings.effectColor;
  rootStyle.setProperty("--sub-rows", settings.rows);
  rootStyle.setProperty("--sub-font-size", `${settings.fontSize}px`);
  rootStyle.setProperty("--sub-line-height", settings.lineHeight);
  rootStyle.setProperty("--sub-max-width", `${settings.maxWidth}%`);
  rootStyle.setProperty("--sub-margin", `${settings.margin}vh`);
  rootStyle.setProperty("--sub-justify", POSITION_JUSTIFY[settings.position] || "flex-end");
  rootStyle.setProperty("--sub-align", settings.align);
  rootStyle.setProperty("--sub-font", FONT_STACKS[settings.fontFamily] || FONT_STACKS.system);
  rootStyle.setProperty("--sub-weight", settings.fontWeight);
  rootStyle.setProperty("--sub-color", settings.textColor);
  rootStyle.setProperty("--sub-transform", settings.uppercase ? "uppercase" : "none");
  rootStyle.setProperty("--sub-pending-opacity", settings.dimPending ? "0.6" : "1");
  rootStyle.setProperty(
    "--sub-shadow",
    settings.effect === "shadow" ? `0 0.04em 0.12em ${effectColor}, 0 0 0.3em ${effectColor}` : "none"
  );
  rootStyle.setProperty("--sub-stroke-width", settings.effect === "outline" ? "0.1em" : "0");
  rootStyle.setProperty("--sub-effect-color", effectColor);
  rootStyle.setProperty("--sub-bg", settings.transparentBg ? "transparent" : settings.bgColor);
  rootStyle.setProperty("--sub-box-bg", hexToRgba(settings.boxColor, settings.boxOpacity / 100));

  statsPanel.hidden = !settings.showStats;
  statsPanel.dataset.corner = settings.statsCorner;
  document.body.dataset.statsCorner = settings.showStats ? settings.statsCorner : "";
  updateStatsReserve();

  settingsPanel.querySelectorAll("output[data-for]").forEach((output) => {
    output.textContent = formatSetting(output.dataset.for, settings[output.dataset.for]);
  });
}

// Keep the caption stage clear of the stats panel so the two never overlap.
function updateStatsReserve() {
  const reserve = settings.showStats ? statsPanel.offsetHeight + 24 : 0;
  const onTop = settings.statsCorner.startsWith("top");
  rootStyle.setProperty("--stats-top", `${onTop ? reserve : 0}px`);
  rootStyle.setProperty("--stats-bottom", `${onTop ? 0 : reserve}px`);
}

settingInputs.forEach((input) => {
  input.addEventListener("input", () => {
    settings[input.dataset.setting] = readInput(input);
    applySettings();
    saveSettings();
  });
});

resetButton.addEventListener("click", () => {
  settings = { ...DEFAULT_SETTINGS };
  syncInputs();
  applySettings();
  saveSettings();
});

if ("ResizeObserver" in window) {
  new ResizeObserver(updateStatsReserve).observe(statsPanel);
}

syncInputs();
applySettings();

// ---------------------------------------------------------------------------
// Caption rendering
// ---------------------------------------------------------------------------

let clearedOffset = 0; // characters of the session text hidden by a clear
let lastCaptionKey = null;
let lastCommitted = "";
let lastPending = "";
let lastTextChange = 0;
let fadeTimer = null;

function joinText(parts) {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function renderCaption(data, isFinalizing = false) {
  let committed = joinText((data.lines || []).filter((line) => line.speaker !== -2).map((line) => line.text));
  let pending = joinText([data.buffer_diarization, data.buffer_transcription]);
  if (isFinalizing) {
    committed = joinText([committed, pending]);
    pending = "";
  }
  showCaption(committed, pending);
}

function showCaption(committed, pending) {
  lastCommitted = committed;
  lastPending = pending;
  const full = joinText([committed, pending]);
  if (full.length < clearedOffset) {
    clearedOffset = 0; // the server session restarted
  }

  let start = Math.max(clearedOffset, full.length - MAX_CAPTION_CHARS);
  if (start > 0 && start < full.length && full[start - 1] !== " ") {
    // Never start mid-word: earlier text may have been revised since the cut.
    const nextSpace = full.indexOf(" ", start);
    start = nextSpace === -1 ? full.length : nextSpace + 1;
  }
  const pendingOffset = full.length - pending.length;
  const committedPart = committed.slice(Math.min(start, committed.length)).trim();
  const pendingPart = pending.slice(Math.max(0, start - pendingOffset)).trim();

  const key = `${committedPart} ${pendingPart}`;
  if (key === lastCaptionKey) return;
  lastCaptionKey = key;

  captionCommitted.textContent = committedPart;
  captionPending.textContent = (committedPart && pendingPart ? " " : "") + pendingPart;
  captionBox.classList.toggle("empty", !committedPart && !pendingPart);

  lastTextChange = Date.now();
  if (fadeTimer) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
    captionText.classList.remove("fading");
  }
}

function clearCaption() {
  if (fadeTimer) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
  }
  captionText.classList.remove("fading");
  clearedOffset = joinText([lastCommitted, lastPending]).length;
  lastCaptionKey = null;
  showCaption(lastCommitted, lastPending);
}

setInterval(() => {
  if (!settings.clearAfter || fadeTimer || captionBox.classList.contains("empty")) return;
  if (Date.now() - lastTextChange < settings.clearAfter * 1000) return;
  captionText.classList.add("fading");
  fadeTimer = setTimeout(clearCaption, FADE_DURATION_MS);
}, 500);

clearButton.addEventListener("click", clearCaption);

// ---------------------------------------------------------------------------
// Technical stats
// ---------------------------------------------------------------------------

const messageTimes = [];

function setConnection(text) {
  statConnection.textContent = text;
}

function setLag(element, value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) {
    element.textContent = "–";
    element.className = "";
    return;
  }
  element.textContent = `${n.toFixed(1)} s`;
  element.className = n > LAG_BAD_S ? "stat-bad" : n > LAG_WARN_S ? "stat-warn" : "";
}

function setError(text) {
  statError.textContent = text || "";
  statError.hidden = !text;
}

function renderStats(data) {
  setLag(statCompute, data.remaining_time_transcription_processing ?? data.remaining_time_transcription);
  setLag(statPolicy, data.remaining_time_transcription_policy);
  setLag(statDiarization, data.remaining_time_diarization);
  statStatus.textContent = data.status || "–";
  setError(data.error || data.translation_error);
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

setInterval(() => {
  const now = Date.now();
  while (messageTimes.length && now - messageTimes[0] > RATE_WINDOW_MS) {
    messageTimes.shift();
  }
  statRate.textContent = isRecording ? (messageTimes.length / (RATE_WINDOW_MS / 1000)).toFixed(1) : "–";
  if (startTime) {
    statTimer.textContent = formatDuration(Math.floor((now - startTime) / 1000));
  }
}, 1000);

function drawLevel() {
  levelFrame = null;
  if (!analyser) {
    statLevel.style.width = "0%";
    return;
  }
  if (!statsPanel.hidden) {
    if (!levelBuffer || levelBuffer.length !== analyser.fftSize) {
      levelBuffer = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(levelBuffer);
    let sum = 0;
    for (let i = 0; i < levelBuffer.length; i++) {
      const v = (levelBuffer[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / levelBuffer.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const level = Math.max(0, Math.min(1, (db + 60) / 60));
    statLevel.style.width = `${Math.round(level * 100)}%`;
  }
  levelFrame = requestAnimationFrame(drawLevel);
}

// ---------------------------------------------------------------------------
// Microphones
// ---------------------------------------------------------------------------

async function enumerateMicrophones() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    availableMicrophones = devices.filter(device => device.kind === 'audioinput');

    populateMicrophoneSelect();
    console.log(`Found ${availableMicrophones.length} microphone(s)`);
  } catch (error) {
    console.error('Error enumerating microphones:', error);
    setStatus("Error accessing microphones. Please grant permission.");
  }
}

function populateMicrophoneSelect() {
  if (!microphoneSelect) return;

  microphoneSelect.innerHTML = '<option value="">Default Microphone</option>';

  availableMicrophones.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    microphoneSelect.appendChild(option);
  });

  const savedMicId = localStorage.getItem('selectedMicrophone');
  if (savedMicId && availableMicrophones.some(mic => mic.deviceId === savedMicId)) {
    microphoneSelect.value = savedMicId;
    selectedMicrophoneId = savedMicId;
  }
}

function handleMicrophoneChange() {
  selectedMicrophoneId = microphoneSelect.value || null;
  localStorage.setItem('selectedMicrophone', selectedMicrophoneId || '');

  const selectedDevice = availableMicrophones.find(mic => mic.deviceId === selectedMicrophoneId);
  const deviceName = selectedDevice ? selectedDevice.label : 'Default Microphone';

  console.log(`Selected microphone: ${deviceName}`);
  setStatus(`Microphone changed to: ${deviceName}`);

  if (isRecording) {
    setStatus("Switching microphone... Please wait.");
    stopRecording().then(() => {
      setTimeout(() => {
        toggleRecording();
      }, 1000);
    });
  }
}

// ---------------------------------------------------------------------------
// WebSocket transport
// ---------------------------------------------------------------------------

const host = window.location.hostname || "localhost";
const port = window.location.port;
const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const defaultWebSocketUrl = `${protocol}://${host}${port ? ":" + port : ""}/asr`;

websocketInput.value = defaultWebSocketUrl;
websocketUrl = defaultWebSocketUrl;

websocketInput.addEventListener("change", () => {
  const urlValue = websocketInput.value.trim();
  if (!urlValue.startsWith("ws://") && !urlValue.startsWith("wss://")) {
    setStatus("Invalid WebSocket URL (must start with ws:// or wss://)");
    return;
  }
  websocketUrl = urlValue;
  setStatus("WebSocket URL updated. Ready to connect.");
});

function setupWebSocket() {
  return new Promise((resolve, reject) => {
    try {
      websocket = new WebSocket(websocketUrl);
    } catch (error) {
      setStatus("Invalid WebSocket URL. Please check and try again.");
      reject(error);
      return;
    }
    setConnection("Connecting…");

    websocket.onopen = () => {
      setStatus("Connected to server.");
      setConnection("Connected");
      setError("");
      clearedOffset = 0; // a new server session starts with empty text
      resolve();
    };

    websocket.onclose = () => {
      const wasUserClosing = userClosing;
      if (userClosing) {
        if (waitingForStop) {
          setStatus("Processing finalized or connection closed.");
          if (lastReceivedData) {
            renderCaption(lastReceivedData, true);
          }
        }
      } else if (shouldReconnect && isRecording) {
        // Unexpected close during an active session: keep the capture
        // pipeline and the displayed text, and retry with backoff.
        websocket = null;
        scheduleReconnect();
        return;
      } else {
        setStatus("Disconnected from the WebSocket server. (Check logs if model is loading.)");
        if (isRecording) {
          stopRecording();
        }
      }
      isRecording = false;
      waitingForStop = false;
      userClosing = false;
      lastReceivedData = null;
      websocket = null;
      setConnection(wasUserClosing ? "Stopped" : "Disconnected");
      updateUI();
    };

    websocket.onerror = () => {
      setStatus("Error connecting to WebSocket.");
      reject(new Error("Error connecting to WebSocket"));
    };

    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "config") {
        serverUseAudioWorklet = !!data.useAudioWorklet;
        statInput.textContent = serverUseAudioWorklet ? "PCM (AudioWorklet)" : "WebM (MediaRecorder)";
        if (configReadyResolve) configReadyResolve();
        return;
      }

      // The subtitle view uses full-state mode, like the main page.
      if (data.type === "diff" || data.type === "snapshot") {
        console.warn("Received diff-protocol message but frontend is in full mode; ignoring.", data.type);
        return;
      }

      if (data.type === "error") {
        setError(data.error);
        setStatus(data.error || "Server error.");
        return;
      }

      if (data.type === "ready_to_stop") {
        console.log("Ready to stop received, finalizing display and closing WebSocket.");
        waitingForStop = false;
        if (lastReceivedData) {
          renderCaption(lastReceivedData, true);
        }
        setStatus("Finished processing audio.");
        setConnection("Stopped");
        recordButton.disabled = false;
        if (websocket) {
          websocket.close();
        }
        return;
      }

      lastReceivedData = data;
      messageTimes.push(Date.now());
      renderStats(data);
      if (data.status !== "no_audio_detected") {
        renderCaption(data);
      }
    };
  });
}

function startMediaRecorder(stream) {
  try {
    recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  } catch (e) {
    recorder = new MediaRecorder(stream);
  }
  recorder.ondataavailable = (e) => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      if (e.data && e.data.size > 0) {
        websocket.send(e.data);
      }
    }
  };
  recorder.start(chunkDuration);
}

function scheduleReconnect() {
  if (!shouldReconnect || reconnectTimer) return;
  const backoff = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_DELAY_MS
  );
  const delay = backoff + Math.random() * 250;
  reconnectAttempts++;
  console.log(`WebSocket lost, reconnect attempt ${reconnectAttempts} in ${Math.round(delay)} ms`);
  setStatus("Reconnecting…");
  setConnection(`Reconnecting (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!shouldReconnect) return;
    try {
      await setupWebSocket();
      reconnectAttempts = 0;
      lastCaptionKey = null; // force a re-render on the next server message
      // PCM chunks resume on their own once the socket is OPEN again, but a
      // MediaRecorder WebM stream must restart so the new server session
      // receives fresh container headers.
      if (!serverUseAudioWorklet && mediaStream) {
        if (recorder) {
          try {
            recorder.stop();
          } catch (e) {}
        }
        startMediaRecorder(mediaStream);
      }
    } catch (err) {
      console.error("Reconnect attempt failed:", err);
      scheduleReconnect();
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Recording lifecycle
// ---------------------------------------------------------------------------

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    console.log("Error acquiring wake lock.");
  }
}

async function startRecording() {
  try {
    await requestWakeLock();

    const audioConstraints = selectedMicrophoneId
      ? { audio: { deviceId: { exact: selectedMicrophoneId } } }
      : { audio: true };
    const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);

    mediaStream = stream;
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);

    if (serverUseAudioWorklet) {
      if (!audioContext.audioWorklet) {
        throw new Error("AudioWorklet is not supported in this browser");
      }
      await audioContext.audioWorklet.addModule("/web/pcm_worklet.js");
      workletNode = new AudioWorkletNode(audioContext, "pcm-forwarder", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      microphone.connect(workletNode);

      recorderWorker = new Worker("/web/recorder_worker.js");
      recorderWorker.postMessage({
        command: "init",
        config: {
          sampleRate: audioContext.sampleRate,
        },
      });

      recorderWorker.onmessage = (e) => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(e.data.buffer);
        }
      };

      workletNode.port.onmessage = (e) => {
        const data = e.data;
        const ab = data instanceof ArrayBuffer ? data : data.buffer;
        recorderWorker.postMessage(
          {
            command: "record",
            buffer: ab,
          },
          [ab]
        );
      };
    } else {
      startMediaRecorder(stream);
    }

    startTime = Date.now();
    statTimer.textContent = "00:00";
    drawLevel();

    isRecording = true;
    shouldReconnect = true;
    updateUI();
  } catch (err) {
    if (window.location.hostname === "0.0.0.0") {
      setStatus("Error accessing microphone. Browsers may block microphone access on 0.0.0.0. Try using localhost:8000 instead.");
    } else {
      setStatus("Error accessing microphone. Please allow microphone access.");
    }
    console.error(err);
  }
}

async function stopRecording() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (e) {
      // ignore
    }
    wakeLock = null;
  }

  // A deliberate stop must never trigger auto-reconnect.
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;

  userClosing = true;
  waitingForStop = true;

  if (websocket && websocket.readyState === WebSocket.OPEN) {
    const emptyBlob = new Blob([], { type: "audio/webm" });
    websocket.send(emptyBlob);
    setStatus("Recording stopped. Processing final audio...");
    setConnection("Finalizing…");
  } else {
    // Stopped while disconnected (e.g. during a reconnect backoff): there is
    // no live server session to finalize, so skip the finalization wait.
    waitingForStop = false;
    userClosing = false;
    setConnection("Stopped");
    if (websocket) {
      try {
        websocket.close();
      } catch (e) {}
      websocket = null;
    }
  }

  if (recorder) {
    try {
      recorder.stop();
    } catch (e) {
    }
    recorder = null;
  }

  if (recorderWorker) {
    recorderWorker.terminate();
    recorderWorker = null;
  }

  if (workletNode) {
    try {
      workletNode.port.onmessage = null;
    } catch (e) {}
    try {
      workletNode.disconnect();
    } catch (e) {}
    workletNode = null;
  }

  if (microphone) {
    microphone.disconnect();
    microphone = null;
  }
  mediaStream = null;

  if (analyser) {
    analyser = null;
  }

  if (audioContext && audioContext.state !== "closed") {
    try {
      await audioContext.close();
    } catch (e) {
      console.warn("Could not close audio context:", e);
    }
    audioContext = null;
  }

  if (levelFrame) {
    cancelAnimationFrame(levelFrame);
    levelFrame = null;
  }
  statLevel.style.width = "0%";
  startTime = null;

  isRecording = false;
  updateUI();
}

async function toggleRecording() {
  if (!isRecording) {
    if (waitingForStop) {
      console.log("Waiting for stop, early return");
      return;
    }
    console.log("Connecting to WebSocket");
    try {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        await configReady;
        await startRecording();
      } else {
        await setupWebSocket();
        await configReady;
        await startRecording();
      }
    } catch (err) {
      setStatus("Could not connect to WebSocket or access mic. Aborted.");
      setConnection("Disconnected");
      console.error(err);
    }
  } else {
    console.log("Stopping recording");
    stopRecording();
  }
}

function updateUI() {
  recordButton.classList.toggle("recording", isRecording);
  recordButton.textContent = isRecording ? "Stop" : "Start";
  recordButton.disabled = waitingForStop;

  if (waitingForStop) {
    if (statusText.textContent !== "Recording stopped. Processing final audio...") {
      setStatus("Please wait for processing to complete...");
    }
  } else if (isRecording) {
    setStatus("");
  } else if (
    statusText.textContent !== "Finished processing audio." &&
    statusText.textContent !== "Processing finalized or connection closed."
  ) {
    setStatus("Press Start (or Space) to begin");
  }
}

recordButton.addEventListener("click", toggleRecording);

if (microphoneSelect) {
  microphoneSelect.addEventListener("change", handleMicrophoneChange);
}
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await enumerateMicrophones();
  } catch (error) {
    console.log("Could not enumerate microphones on load:", error);
  }
});
navigator.mediaDevices.addEventListener('devicechange', async () => {
  console.log('Device change detected, re-enumerating microphones');
  try {
    await enumerateMicrophones();
  } catch (error) {
    console.log("Error re-enumerating microphones:", error);
  }
});

// The browser drops the screen wake lock when the tab is hidden.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isRecording && !wakeLock) {
    void requestWakeLock();
  }
});

// ---------------------------------------------------------------------------
// Operator controls: settings panel, fullscreen, auto-hide, shortcuts
// ---------------------------------------------------------------------------

let idleTimer = null;

function markActive() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (settingsPanel.hidden) {
      document.body.classList.add("idle");
    }
  }, IDLE_DELAY_MS);
}

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  settingsToggle.classList.toggle("active", open);
  markActive();
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch((err) => {
      setStatus(`Fullscreen not available: ${err.message}`);
    });
  }
}

settingsToggle.addEventListener("click", () => setSettingsOpen(settingsPanel.hidden));
settingsClose.addEventListener("click", () => setSettingsOpen(false));
fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  fullscreenButton.classList.toggle("active", !!document.fullscreenElement);
});

["mousemove", "mousedown", "touchstart", "wheel"].forEach((eventName) => {
  document.addEventListener(eventName, markActive, { passive: true });
});

document.addEventListener("keydown", (e) => {
  markActive();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape") {
    if (!settingsPanel.hidden) setSettingsOpen(false);
    return;
  }
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  switch (e.key.toLowerCase()) {
    case " ":
      if (tag === "BUTTON") return; // the focused button handles Space itself
      e.preventDefault();
      if (!recordButton.disabled) toggleRecording();
      break;
    case "f":
      toggleFullscreen();
      break;
    case "s":
      setSettingsOpen(settingsPanel.hidden);
      break;
    case "t":
      settings.showStats = !settings.showStats;
      syncInputs();
      applySettings();
      saveSettings();
      break;
    case "c":
      clearCaption();
      break;
  }
});

updateUI();
markActive();

const startBtn = document.getElementById("startBtn");
const nextBtn = document.getElementById("nextBtn");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const fileInput = document.getElementById("fileInput");

let ws = null;
let peerConnection = null;
let localStream = null;
let connected = false;

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function updateStatus(state, text) {
  statusText.textContent = text;
  statusDot.classList.remove("waiting", "connected", "disconnected");
  statusDot.classList.add(state);
}

function appendMessage(kind, text, media = null) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg ${kind}`;

  const label = kind === "you" ? "You" : kind === "stranger" ? "Stranger" : "System";
  const labelNode = document.createElement("strong");
  labelNode.textContent = `${label}: `;
  wrapper.appendChild(labelNode);
  wrapper.appendChild(document.createTextNode(text || ""));

  if (media) {
    if (media.mimeType.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = media.dataUrl;
      img.alt = "Shared image";
      wrapper.appendChild(img);
    }
    if (media.mimeType.startsWith("video/")) {
      const vid = document.createElement("video");
      vid.src = media.dataUrl;
      vid.controls = true;
      wrapper.appendChild(vid);
    }
  }

  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function ensureLocalMedia() {
  if (localStream) {
    return;
  }

  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
}

async function createPeerConnection() {
  closePeerConnection();
  peerConnection = new RTCPeerConnection(RTC_CONFIG);

  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendWs({ type: "ice_candidate", payload: event.candidate });
    }
  };

  peerConnection.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      remoteVideo.srcObject = stream;
    }
  };
}

function sendWs(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function handleMatched(isInitiator) {
  connected = true;
  nextBtn.disabled = false;
  updateStatus("connected", "Connected");
  appendMessage("system", "You are now connected to a stranger.");

  await createPeerConnection();

  if (isInitiator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendWs({ type: "offer", payload: offer });
  }
}

function resetForWaiting(msg = "Waiting for a stranger...") {
  connected = false;
  closePeerConnection();
  updateStatus("waiting", msg);
}

async function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

  ws.onopen = () => {
    updateStatus("waiting", "Waiting for a stranger...");
    appendMessage("system", "Socket connected. Matchmaking started.");
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case "connected":
        break;
      case "status":
        resetForWaiting(data.message || "Waiting for a stranger...");
        break;
      case "matched":
        await handleMatched(Boolean(data.isInitiator));
        break;
      case "offer":
        if (!peerConnection) {
          await createPeerConnection();
        }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        sendWs({ type: "answer", payload: answer });
        break;
      case "answer":
        if (peerConnection) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
        }
        break;
      case "ice_candidate":
        if (peerConnection && data.payload) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(data.payload));
        }
        break;
      case "chat":
        appendMessage("stranger", data.payload?.text || "");
        break;
      case "media":
        appendMessage("stranger", data.payload?.text || "Shared a file", {
          mimeType: data.payload?.mimeType || "application/octet-stream",
          dataUrl: data.payload?.dataUrl || "",
        });
        break;
      case "partner_disconnected":
        appendMessage("system", data.message || "Stranger disconnected.");
        resetForWaiting("Waiting for a stranger...");
        break;
      case "error":
        appendMessage("system", data.message || "Server error.");
        break;
      default:
        break;
    }
  };

  ws.onclose = () => {
    connected = false;
    nextBtn.disabled = true;
    closePeerConnection();
    updateStatus("disconnected", "Disconnected");
    appendMessage("system", "Socket disconnected.");
  };
}

async function sendTextMessage(event) {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !connected) {
    return;
  }

  sendWs({ type: "chat", payload: { text } });
  appendMessage("you", text);
  chatInput.value = "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function sendFileMessage() {
  const file = fileInput.files[0];
  if (!file || !connected) {
    return;
  }

  // MVP guardrail to avoid very large base64 payloads.
  const maxSize = 8 * 1024 * 1024;
  if (file.size > maxSize) {
    appendMessage("system", "File too large. Max allowed is 8MB for MVP.");
    fileInput.value = "";
    return;
  }

  const dataUrl = await fileToDataUrl(file);
  const payload = {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    dataUrl,
    text: `Shared ${file.name}`,
  };

  sendWs({ type: "media", payload });
  appendMessage("you", payload.text, { mimeType: payload.mimeType, dataUrl: payload.dataUrl });
  fileInput.value = "";
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    await ensureLocalMedia();
    await connectWebSocket();
    nextBtn.disabled = false;
    appendMessage("system", "Camera and microphone enabled.");
  } catch (error) {
    console.error(error);
    startBtn.disabled = false;
    updateStatus("disconnected", "Permissions required");
    appendMessage("system", "Could not access camera/microphone.");
  }
});

nextBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  appendMessage("system", "Searching for a new stranger...");
  resetForWaiting("Waiting for a stranger...");
  sendWs({ type: "next" });
});

chatForm.addEventListener("submit", sendTextMessage);
fileInput.addEventListener("change", sendFileMessage);

window.addEventListener("beforeunload", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
});

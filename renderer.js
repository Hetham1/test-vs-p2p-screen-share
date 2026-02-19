const { ipcRenderer, clipboard } = require("electron");
const { Peer } = require("peerjs");

const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const myPeerIdEl = document.getElementById("myPeerId");
const copyIdBtn = document.getElementById("copyIdBtn");
const reconnectSignalBtn = document.getElementById("reconnectSignalBtn");
const friendIdInput = document.getElementById("friendIdInput");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const connectionInfo = document.getElementById("connectionInfo");
const startShareBtn = document.getElementById("startShareBtn");
const stopShareBtn = document.getElementById("stopShareBtn");
const liveTag = document.getElementById("liveTag");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const localPlaceholder = document.getElementById("localPlaceholder");
const remotePlaceholder = document.getElementById("remotePlaceholder");
const toast = document.getElementById("toast");

const PEER_OPTIONS = {
  secure: true,
  debug: 1
};

let peer = null;
let peerReady = false;
let myPeerId = "";
let dataConn = null;
let localStream = null;
let remoteStream = null;
let outgoingCall = null;
let incomingCall = null;
let isStoppingShare = false;
let cloudErrorNotified = false;
let toastTimer = null;

initialize();

function initialize() {
  bindUiEvents();
  initPeer();
  updateControls();
}

function bindUiEvents() {
  copyIdBtn.addEventListener("click", () => {
    if (!myPeerId) return;
    clipboard.writeText(myPeerId);
    showToast("Peer ID copied.");
  });

  reconnectSignalBtn.addEventListener("click", async () => {
    await reconnectSignal();
  });

  connectBtn.addEventListener("click", () => {
    connectToFriend();
  });

  disconnectBtn.addEventListener("click", async () => {
    await disconnectSession();
  });

  friendIdInput.addEventListener("input", () => {
    updateControls();
  });

  friendIdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      connectToFriend();
    }
  });

  startShareBtn.addEventListener("click", async () => {
    await startSharing();
  });

  stopShareBtn.addEventListener("click", async () => {
    await stopSharing({ restoreWindow: true, reason: "Stopped by user." });
  });

  window.addEventListener("beforeunload", () => {
    cleanupAllState({ restoreWindow: false, destroyPeer: true });
  });
}

function initPeer() {
  setStatus("Connecting to PeerJS cloud...", "warning");
  myPeerIdEl.textContent = "Connecting to PeerJS cloud...";
  copyIdBtn.disabled = true;
  peerReady = false;
  updateControls();

  const activePeer = new Peer(undefined, PEER_OPTIONS);
  peer = activePeer;

  activePeer.on("open", (id) => {
    if (peer !== activePeer) return;
    myPeerId = id;
    peerReady = true;
    cloudErrorNotified = false;
    myPeerIdEl.textContent = id;
    copyIdBtn.disabled = false;
    setStatus("Waiting for connection...", "idle");
    updateControls();
  });

  activePeer.on("connection", (conn) => {
    if (peer !== activePeer) return;
    if (dataConn && dataConn.open && dataConn.peer !== conn.peer) {
      conn.close();
      setStatus("Rejected extra incoming connection from another peer.", "warning");
      return;
    }
    attachDataConnection(conn);
  });

  activePeer.on("call", (call) => {
    if (peer !== activePeer) return;
    handleIncomingCall(call);
  });

  activePeer.on("disconnected", () => {
    if (peer !== activePeer) return;
    peerReady = false;
    setStatus("Signal disconnected. Attempting reconnect...", "warning");
    if (!activePeer.destroyed) {
      activePeer.reconnect();
    }
    updateControls();
  });

  activePeer.on("close", () => {
    if (peer !== activePeer) return;
    peerReady = false;
    setStatus("Peer closed. Click Reconnect Signal.", "error");
    updateControls();
  });

  activePeer.on("error", (error) => {
    if (peer !== activePeer) return;
    handlePeerError(error);
  });
}

function connectToFriend() {
  if (!peer || !peerReady) {
    showToast("Peer is not ready yet.");
    return;
  }

  const targetId = friendIdInput.value.trim();
  if (!targetId) {
    showToast("Enter your friend's peer ID.");
    return;
  }

  if (targetId === myPeerId) {
    showToast("Use a different peer ID.");
    return;
  }

  if (dataConn && dataConn.open && dataConn.peer === targetId) {
    setStatus("Already connected to this peer.", "ok");
    return;
  }

  setStatus(`Connecting to ${targetId}...`, "warning");
  setConnectionInfo(`Dialing ${targetId}...`);

  try {
    const conn = peer.connect(targetId, {
      reliable: true,
      serialization: "json"
    });
    attachDataConnection(conn);
  } catch (error) {
    setStatus(`Failed to open connection: ${error.message || "unknown error"}`, "error");
  }
}

function attachDataConnection(conn) {
  if (dataConn && dataConn !== conn) {
    dataConn.close();
  }

  dataConn = conn;
  friendIdInput.value = conn.peer;
  updateControls();

  conn.on("open", () => {
    friendIdInput.value = conn.peer;
    setStatus(`Connected to ${conn.peer}`, "ok");
    setConnectionInfo(`Data channel open with ${conn.peer}`);
    sendControl({ type: "presence", sharing: Boolean(localStream) });
    if (localStream && !outgoingCall) {
      placeOutgoingCall();
    }
    updateControls();
  });

  conn.on("data", (message) => {
    onDataMessage(message);
  });

  conn.on("close", async () => {
    if (dataConn !== conn) return;
    dataConn = null;
    setConnectionInfo("Waiting for connection...");
    closeIncomingCall();
    closeOutgoingCall();
    clearRemoteStream("No remote stream");
    if (localStream) {
      await stopSharing({ restoreWindow: true, reason: "Connection lost. Sharing stopped." });
    }
    setStatus("Waiting for connection...", "idle");
    updateControls();
  });

  conn.on("error", (error) => {
    setStatus(`Data connection error: ${error.message || "unknown error"}`, "error");
  });
}

function handleIncomingCall(call) {
  const isConnected = Boolean(dataConn && dataConn.open && dataConn.peer === call.peer);
  if (!isConnected) {
    setStatus(`Blocked call from ${call.peer}: no active trusted data connection.`, "warning");
    call.close();
    return;
  }

  if (incomingCall && incomingCall !== call) {
    incomingCall.close();
  }

  incomingCall = call;
  try {
    call.answer(localStream || undefined);
  } catch (error) {
    setStatus(`Failed to answer incoming call: ${error.message || "unknown error"}`, "error");
    call.close();
    return;
  }

  attachMediaCallHandlers(call, "incoming");
}

function placeOutgoingCall() {
  if (!peer || !peerReady || !dataConn || !dataConn.open || !localStream) return;

  closeOutgoingCall();
  setConnectionInfo(`Calling ${dataConn.peer} with your stream...`);

  try {
    outgoingCall = peer.call(dataConn.peer, localStream, {
      metadata: { kind: "screen-share" }
    });
    attachMediaCallHandlers(outgoingCall, "outgoing");
  } catch (error) {
    setStatus(`Failed to place media call: ${error.message || "unknown error"}`, "error");
  }
}

function attachMediaCallHandlers(call, direction) {
  call.on("stream", (stream) => {
    setRemoteStream(stream, call.peer);
    if (localStream) {
      setStatus("Streaming live and receiving remote stream.", "ok");
      setConnectionInfo(`Two-way media active with ${call.peer}`);
    } else {
      setStatus("Receiving remote stream.", "ok");
      setConnectionInfo(`Receiving ${call.peer}'s stream`);
    }
  });

  call.on("close", () => {
    if (direction === "incoming" && incomingCall === call) {
      incomingCall = null;
      clearRemoteStream("No remote stream");
      if (dataConn && dataConn.open) {
        setStatus(localStream ? "Streaming live." : "Connected. Waiting for friend stream.", "warning");
      }
    }

    if (direction === "outgoing" && outgoingCall === call) {
      outgoingCall = null;
      if (localStream) {
        setConnectionInfo(`Connected to ${dataConn ? dataConn.peer : "peer"} (stream sent)`);
      }
    }

    updateControls();
  });

  call.on("error", (error) => {
    setStatus(`Media call error: ${error.message || "unknown error"}`, "error");
    if (direction === "incoming" && incomingCall === call) {
      incomingCall = null;
      clearRemoteStream("No remote stream");
    }
    if (direction === "outgoing" && outgoingCall === call) {
      outgoingCall = null;
    }
    updateControls();
  });
}

async function startSharing() {
  if (!dataConn || !dataConn.open) {
    alert("Connect to a friend before starting screen share.");
    return;
  }

  if (localStream) {
    showToast("You are already sharing.");
    return;
  }

  setStatus("Waiting for screen selection...", "warning");

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 }
      },
      audio: {
        systemAudio: "include"
      }
    });
  } catch (error) {
    handleDisplayMediaError(error);
    return;
  }

  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop());
    alert("You forgot to check 'Share System Audio'. Please try again.");
    setStatus("Share canceled: system audio was not enabled.", "warning");
    return;
  }

  localStream = stream;
  localVideo.srcObject = stream;
  togglePlaceholder(localPlaceholder, false);
  await tryPlayVideo(localVideo);
  hookLocalTrackEndHandlers(stream);

  setLiveTag(true);
  setStatus("Streaming Live", "ok");
  setConnectionInfo(`Connected to ${dataConn.peer}. Stream is live.`);
  sendControl({ type: "sharing-started" });
  updateControls();

  await ipcRenderer.invoke("window:minimize");
  placeOutgoingCall();
}

async function stopSharing(options = {}) {
  if (isStoppingShare) return;
  if (!localStream) {
    if (options.restoreWindow) {
      await ipcRenderer.invoke("window:restore");
    }
    return;
  }

  isStoppingShare = true;
  try {
    const streamToStop = localStream;
    localStream = null;
    streamToStop.getTracks().forEach((track) => track.stop());
    localVideo.srcObject = null;
    togglePlaceholder(localPlaceholder, true, "No local stream");
    closeOutgoingCall();
    setLiveTag(false);
    sendControl({ type: "sharing-stopped", reason: options.reason || "Share stopped." });

    if (dataConn && dataConn.open) {
      setStatus(remoteStream ? "Connected. Local stream stopped." : "Connected. Not sharing.", "warning");
      setConnectionInfo(`Connected to ${dataConn.peer}`);
    } else {
      setStatus("Waiting for connection...", "idle");
      setConnectionInfo("Waiting for connection...");
    }
  } finally {
    isStoppingShare = false;
    updateControls();
    if (options.restoreWindow !== false) {
      await ipcRenderer.invoke("window:restore");
    }
  }
}

function hookLocalTrackEndHandlers(stream) {
  stream.getTracks().forEach((track) => {
    track.addEventListener(
      "ended",
      async () => {
        if (localStream === stream && !isStoppingShare) {
          await stopSharing({
            restoreWindow: true,
            reason: "Capture ended by user from picker."
          });
        }
      },
      { once: true }
    );
  });
}

function setRemoteStream(stream, peerId) {
  remoteStream = stream;
  remoteVideo.srcObject = stream;
  remoteVideo.muted = false;
  togglePlaceholder(remotePlaceholder, false);
  tryPlayVideo(remoteVideo);
  hookRemoteTrackEndHandlers(stream);
  setConnectionInfo(`Receiving ${peerId}'s stream`);
}

function clearRemoteStream(text) {
  remoteStream = null;
  remoteVideo.srcObject = null;
  togglePlaceholder(remotePlaceholder, true, text || "No remote stream");
}

function hookRemoteTrackEndHandlers(stream) {
  stream.getTracks().forEach((track) => {
    track.addEventListener(
      "ended",
      () => {
        if (remoteStream !== stream) return;
        clearRemoteStream("No remote stream");
        if (dataConn && dataConn.open) {
          setStatus(localStream ? "Streaming Live" : "Connected. Waiting for friend stream.", localStream ? "ok" : "warning");
        }
      },
      { once: true }
    );
  });
}

function closeOutgoingCall() {
  if (!outgoingCall) return;
  const call = outgoingCall;
  outgoingCall = null;
  call.close();
}

function closeIncomingCall() {
  if (!incomingCall) return;
  const call = incomingCall;
  incomingCall = null;
  call.close();
}

function onDataMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "sharing-started") {
    setStatus("Friend started sharing. Waiting for stream...", "warning");
  }

  if (message.type === "sharing-stopped" && !remoteStream) {
    setStatus(localStream ? "Streaming Live" : "Connected. Not sharing.", localStream ? "ok" : "warning");
  }
}

function sendControl(payload) {
  if (!dataConn || !dataConn.open) return;
  dataConn.send({
    app: "p2p-screen-share",
    at: Date.now(),
    ...payload
  });
}

function handlePeerError(error) {
  const type = error && error.type ? error.type : "unknown";
  const message = error && error.message ? error.message : String(error);

  if (type === "peer-unavailable") {
    setStatus("Friend ID not found or currently offline.", "error");
    setConnectionInfo("Check the friend's peer ID and try again.");
    return;
  }

  if (type === "server-error" || type === "socket-error" || type === "network") {
    setStatus("PeerJS cloud server unreachable. Check internet/firewall, then reconnect.", "error");
    setConnectionInfo("Signaling server unreachable.");
    if (!cloudErrorNotified) {
      cloudErrorNotified = true;
      alert("PeerJS cloud server is unreachable right now. Check your network, then click 'Reconnect Signal'.");
    }
    return;
  }

  setStatus(`Peer error (${type}): ${message}`, "error");
}

function handleDisplayMediaError(error) {
  if (!error) {
    setStatus("Screen share failed.", "error");
    return;
  }

  if (error.name === "NotAllowedError") {
    setStatus("Screen share was canceled or blocked by permissions.", "warning");
    return;
  }

  if (error.name === "NotFoundError") {
    setStatus("No screen/audio source found.", "error");
    return;
  }

  setStatus(`Failed to start screen share: ${error.message || error.name}`, "error");
}

async function disconnectSession() {
  if (localStream) {
    await stopSharing({ restoreWindow: true, reason: "Disconnected by user." });
  }

  closeIncomingCall();
  closeOutgoingCall();
  clearRemoteStream("No remote stream");

  if (dataConn) {
    const conn = dataConn;
    dataConn = null;
    conn.close();
  }

  setConnectionInfo("Waiting for connection...");
  setStatus("Disconnected. Waiting for connection...", "idle");
  updateControls();
}

async function reconnectSignal() {
  cleanupAllState({ restoreWindow: true, destroyPeer: true });
  myPeerId = "";
  peerReady = false;
  myPeerIdEl.textContent = "Reconnecting to PeerJS cloud...";
  copyIdBtn.disabled = true;
  setConnectionInfo("Waiting for connection...");
  setStatus("Reconnecting signal server...", "warning");
  updateControls();
  initPeer();
}

function cleanupAllState(options = {}) {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  togglePlaceholder(localPlaceholder, true, "No local stream");
  setLiveTag(false);

  closeOutgoingCall();
  closeIncomingCall();
  clearRemoteStream("No remote stream");

  if (dataConn) {
    const conn = dataConn;
    dataConn = null;
    conn.close();
  }

  if (options.destroyPeer && peer && !peer.destroyed) {
    peer.destroy();
  }

  if (options.restoreWindow) {
    ipcRenderer.invoke("window:restore");
  }
}

function updateControls() {
  const friendId = friendIdInput.value.trim();
  const connected = Boolean(dataConn && dataConn.open);

  copyIdBtn.disabled = !myPeerId;
  connectBtn.disabled = !peerReady || !friendId || connected;
  disconnectBtn.disabled = !(connected || localStream || remoteStream || incomingCall || outgoingCall);
  startShareBtn.disabled = !(connected && !localStream);
  stopShareBtn.disabled = !localStream;
}

function setStatus(text, state = "idle") {
  statusText.textContent = text;
  statusPill.classList.remove("idle", "ok", "warning", "error");
  statusPill.classList.add(state);
}

function setConnectionInfo(text) {
  connectionInfo.textContent = text;
}

function setLiveTag(isLive) {
  liveTag.textContent = isLive ? "Streaming Live" : "Offline";
  liveTag.classList.toggle("on", isLive);
  liveTag.classList.toggle("off", !isLive);
}

function togglePlaceholder(element, show, text) {
  if (text) {
    element.textContent = text;
  }
  element.style.display = show ? "flex" : "none";
}

async function tryPlayVideo(videoEl) {
  try {
    await videoEl.play();
  } catch (error) {
    setStatus(`Autoplay blocked: ${error.message || "interaction required"}`, "warning");
  }
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 1500);
}

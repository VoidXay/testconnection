const config = window.MINI_DISCORD_CONFIG || {};
const socketServerUrl = resolveSocketServerUrl(config.socketServerUrl);
const socket = io(socketServerUrl || undefined, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600,
    timeout: 12000
});

const rtcConfiguration = {
    iceServers: [
        {
            urls: [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            ]
        }
    ]
};

const elements = {
    participantGrid: document.getElementById("participantGrid"),
    peopleList: document.getElementById("peopleList"),
    emptyState: document.getElementById("emptyState"),
    sidebarCount: document.getElementById("sidebarCount"),
    membersCount: document.getElementById("membersCount"),
    roomLink: document.getElementById("roomLink"),
    copyButton: document.getElementById("copyButton"),
    copyLinkButton: document.getElementById("copyLinkButton"),
    inviteButton: document.getElementById("inviteButton"),
    micButton: document.getElementById("micButton"),
    micText: document.getElementById("micText"),
    noiseButton: document.getElementById("noiseButton"),
    noiseText: document.getElementById("noiseText"),
    leaveButton: document.getElementById("leaveButton"),
    localStatus: document.getElementById("localStatus"),
    localSidebarStatus: document.getElementById("localSidebarStatus"),
    connectionPill: document.getElementById("connectionPill"),
    connectionText: document.getElementById("connectionText"),
    roomDescription: document.getElementById("roomDescription"),
    audioContainer: document.getElementById("audioContainer"),
    toast: document.getElementById("toast")
};

const peers = new Map();
const audioContexts = new Set();

let roomId = resolveRoomId();
let localStream = null;
let localAudioMonitor = null;
let isMuted = false;
let noiseSuppressionEnabled = true;
let noiseSuppressionSupported = false;
let participantTotal = 1;
let toastTimer = null;
let hasLeftRoom = false;

start().catch(handleStartupError);

async function start() {
    updateRoomUrl();
    bindUiEvents();
    updateEmptyState();
    updateParticipantCount();

    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support getUserMedia.");
    }

    if (!socketServerUrl && isStaticHost()) {
        throw new Error(
            "Missing SOCKET_SERVER_URL. Configure it in Netlify before publishing."
        );
    }

    setConnectionStatus("Microfone", "waiting");

    localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
        },
        video: false
    });

    const localTrack = localStream.getAudioTracks()[0];

    if (!localTrack) {
        throw new Error("No audio track was returned by the browser.");
    }

    noiseSuppressionSupported = detectNoiseSuppressionSupport(localTrack);

    const settings = localTrack.getSettings?.() || {};
    if (typeof settings.noiseSuppression === "boolean") {
        noiseSuppressionEnabled = settings.noiseSuppression;
    }

    localAudioMonitor = createAudioActivityMonitor(localStream, "self");

    elements.micButton.disabled = false;
    elements.noiseButton.disabled = !noiseSuppressionSupported;
    elements.localStatus.textContent = "Microfone conectado";
    elements.localSidebarStatus.textContent = "online";

    updateMicrophoneUi();
    updateNoiseUi();

    if (socket.connected) {
        joinRoom();
    } else {
        setConnectionStatus("Conectando", "waiting");
    }
}

function bindUiEvents() {
    elements.copyButton.addEventListener("click", copyRoomLink);
    elements.copyLinkButton.addEventListener("click", copyRoomLink);
    elements.inviteButton.addEventListener("click", copyRoomLink);
    elements.micButton.addEventListener("click", toggleMicrophone);
    elements.noiseButton.addEventListener("click", toggleNoiseSuppression);
    elements.leaveButton.addEventListener("click", leaveRoom);

    const unlockAudio = () => {
        for (const context of audioContexts) {
            if (context.state === "suspended") {
                context.resume().catch(() => {});
            }
        }

        for (const peer of peers.values()) {
            peer.audioElement.play().catch(() => {});
        }
    };

    window.addEventListener("pointerdown", unlockAudio, { passive: true });

    window.addEventListener("beforeunload", () => {
        if (!hasLeftRoom) {
            socket.emit("leave-room");
        }
        cleanup();
    });
}

function resolveSocketServerUrl(value) {
    const url = String(value || "").trim().replace(/\/$/, "");
    return url;
}

function isStaticHost() {
    const host = window.location.hostname;
    return !(
        host === "localhost" ||
        host === "127.0.0.1" ||
        host.endsWith(".onrender.com")
    );
}

function resolveRoomId() {
    const pathnameRoom = window.location.pathname
        .replace(/^\/+|\/+$/g, "")
        .trim();

    if (/^[a-zA-Z0-9_-]{6,80}$/.test(pathnameRoom)) {
        return pathnameRoom;
    }

    if (window.crypto?.randomUUID) {
        return window.crypto.randomUUID().replaceAll("-", "").slice(0, 18);
    }

    return `${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 12)}`;
}

function updateRoomUrl() {
    const targetPath = `/${roomId}`;

    if (window.location.pathname !== targetPath) {
        window.history.replaceState({}, "", targetPath);
    }

    elements.roomLink.value = window.location.href;
}

async function copyRoomLink() {
    const roomLink = window.location.href;

    try {
        await navigator.clipboard.writeText(roomLink);
    } catch {
        elements.roomLink.focus();
        elements.roomLink.select();
        document.execCommand("copy");
        window.getSelection()?.removeAllRanges();
    }

    showToast("Link da sala copiado.");
}

function toggleMicrophone() {
    if (!localStream) {
        return;
    }

    isMuted = !isMuted;

    for (const track of localStream.getAudioTracks()) {
        track.enabled = !isMuted;
    }

    if (isMuted) {
        setParticipantSpeaking("self", false);
    }

    updateMicrophoneUi();
}

function updateMicrophoneUi() {
    elements.micButton.classList.toggle("muted", isMuted);
    elements.micText.textContent = isMuted ? "Ativar mic" : "Microfone";
    elements.localStatus.textContent = isMuted
        ? "Microfone desligado"
        : "Microfone conectado";
    elements.localSidebarStatus.textContent = isMuted ? "mudo" : "online";
}

function detectNoiseSuppressionSupport(track) {
    const supportedConstraints =
        navigator.mediaDevices.getSupportedConstraints?.() || {};
    const capabilities = track.getCapabilities?.() || {};

    if (Array.isArray(capabilities.noiseSuppression)) {
        return capabilities.noiseSuppression.length > 0;
    }

    if (typeof capabilities.noiseSuppression === "boolean") {
        return true;
    }

    return Boolean(supportedConstraints.noiseSuppression);
}

async function toggleNoiseSuppression() {
    if (!localStream || !noiseSuppressionSupported) {
        showToast("Seu navegador não permite controlar a redução de ruído.");
        return;
    }

    const track = localStream.getAudioTracks()[0];
    if (!track) {
        return;
    }

    const nextValue = !noiseSuppressionEnabled;

    try {
        await track.applyConstraints({
            echoCancellation: true,
            noiseSuppression: nextValue,
            autoGainControl: true
        });

        const settings = track.getSettings?.() || {};
        noiseSuppressionEnabled =
            typeof settings.noiseSuppression === "boolean"
                ? settings.noiseSuppression
                : nextValue;

        updateNoiseUi();
        showToast(
            noiseSuppressionEnabled
                ? "Redução de ruído ativada."
                : "Redução de ruído desativada."
        );
    } catch (error) {
        console.error("Noise suppression update failed:", error);
        showToast("Não foi possível alterar a redução de ruído.");
    }
}

function updateNoiseUi() {
    elements.noiseButton.classList.toggle(
        "active",
        noiseSuppressionSupported && noiseSuppressionEnabled
    );

    if (!noiseSuppressionSupported) {
        elements.noiseText.textContent = "Ruído indisponível";
        elements.noiseButton.title =
            "O navegador não expõe o controle de noiseSuppression.";
        return;
    }

    elements.noiseText.textContent = noiseSuppressionEnabled
        ? "Ruído ligado"
        : "Ruído desligado";
}

function joinRoom() {
    if (!localStream || hasLeftRoom) {
        return;
    }

    socket.emit("join-room", { roomId });
}

function leaveRoom() {
    if (hasLeftRoom) {
        return;
    }

    hasLeftRoom = true;
    socket.emit("leave-room");
    cleanup();
    socket.disconnect();

    elements.micButton.disabled = true;
    elements.noiseButton.disabled = true;
    elements.localStatus.textContent = "Você saiu da sala";
    elements.localSidebarStatus.textContent = "offline";
    elements.roomDescription.textContent = "Atualize a página para entrar novamente.";

    setConnectionStatus("Desconectado", "error");
    showToast("Você saiu da sala.");
}

socket.on("connect", () => {
    if (localStream && !hasLeftRoom) {
        joinRoom();
    }
});

socket.on("disconnect", (reason) => {
    if (hasLeftRoom) {
        return;
    }

    setConnectionStatus("Reconectando", "waiting");

    if (reason === "io server disconnect") {
        socket.connect();
    }
});

socket.on("connect_error", (error) => {
    console.error("Socket connection failed:", error);
    setConnectionStatus("Servidor offline", "error");
});

socket.on("room-joined", async ({ existingParticipants, participantCount }) => {
    participantTotal = participantCount;
    updateParticipantCount();
    setConnectionStatus("Conectado", "connected");

    elements.roomDescription.textContent =
        existingParticipants.length === 0
            ? "Só você por enquanto. Compartilhe o link para alguém entrar."
            : "Áudio conectado diretamente entre os participantes.";

    for (const participantId of existingParticipants) {
        ensureParticipantUi(participantId);
        await createPeerConnection(participantId, true);
    }

    updateEmptyState();
});

socket.on("participant-joined", ({ participantId, participantCount }) => {
    if (!participantId || participantId === socket.id) {
        return;
    }

    participantTotal = participantCount;
    updateParticipantCount();
    ensureParticipantUi(participantId);
    updateEmptyState();
    elements.roomDescription.textContent = "Sala de voz ativa.";
});

socket.on("participant-left", ({ participantId }) => {
    removePeer(participantId);
    removeParticipantUi(participantId);
    updateEmptyState();
});

socket.on("participant-count", ({ participantCount }) => {
    participantTotal = Math.max(1, Number(participantCount) || 1);
    updateParticipantCount();
});

socket.on("webrtc-offer", async ({ senderId, offer }) => {
    if (!senderId || !offer || senderId === socket.id) {
        return;
    }

    ensureParticipantUi(senderId);

    const peer = await createPeerConnection(senderId, false);
    await peer.connection.setRemoteDescription(offer);
    await flushIceCandidates(peer);

    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);

    socket.emit("webrtc-answer", {
        targetId: senderId,
        answer: peer.connection.localDescription
    });
});

socket.on("webrtc-answer", async ({ senderId, answer }) => {
    const peer = peers.get(senderId);

    if (!peer || !answer) {
        return;
    }

    await peer.connection.setRemoteDescription(answer);
    await flushIceCandidates(peer);
});

socket.on("webrtc-ice-candidate", async ({ senderId, candidate }) => {
    if (!senderId || !candidate || senderId === socket.id) {
        return;
    }

    let peer = peers.get(senderId);

    if (!peer) {
        ensureParticipantUi(senderId);
        peer = await createPeerConnection(senderId, false);
    }

    if (!peer.connection.remoteDescription?.type) {
        peer.pendingIceCandidates.push(candidate);
        return;
    }

    try {
        await peer.connection.addIceCandidate(candidate);
    } catch (error) {
        console.error("Failed to add ICE candidate:", error);
    }
});

socket.on("room-error", ({ message }) => {
    setConnectionStatus("Erro", "error");
    showToast(message || "Não foi possível entrar na sala.");
});

async function createPeerConnection(participantId, shouldCreateOffer) {
    const existingPeer = peers.get(participantId);
    if (existingPeer) {
        return existingPeer;
    }

    if (!localStream) {
        throw new Error("Local audio stream is not ready.");
    }

    const connection = new RTCPeerConnection(rtcConfiguration);
    const peer = {
        connection,
        pendingIceCandidates: [],
        audioElement: createRemoteAudioElement(participantId),
        audioMonitor: null
    };

    peers.set(participantId, peer);

    for (const track of localStream.getTracks()) {
        connection.addTrack(track, localStream);
    }

    connection.addEventListener("icecandidate", ({ candidate }) => {
        if (!candidate) {
            return;
        }

        socket.emit("webrtc-ice-candidate", {
            targetId: participantId,
            candidate
        });
    });

    connection.addEventListener("track", ({ streams }) => {
        const [remoteStream] = streams;
        if (!remoteStream) {
            return;
        }

        peer.audioElement.srcObject = remoteStream;
        peer.audioElement.play().catch(() => {});

        getParticipantCard(participantId)?.classList.add("connected");
        setParticipantStatus(participantId, "áudio conectado");

        peer.audioMonitor?.stop();
        peer.audioMonitor = createAudioActivityMonitor(remoteStream, participantId);
    });

    connection.addEventListener("connectionstatechange", () => {
        const state = connection.connectionState;

        if (state === "connected") {
            setParticipantStatus(participantId, "áudio conectado");
            getParticipantCard(participantId)?.classList.add("connected");
        } else if (state === "connecting") {
            setParticipantStatus(participantId, "conectando...");
        } else if (state === "disconnected") {
            setParticipantStatus(participantId, "reconectando...");
        } else if (state === "failed") {
            setParticipantStatus(participantId, "falha na conexão");
            setParticipantSpeaking(participantId, false);
        } else if (state === "closed") {
            setParticipantSpeaking(participantId, false);
        }
    });

    if (shouldCreateOffer) {
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);

        socket.emit("webrtc-offer", {
            targetId: participantId,
            offer: connection.localDescription
        });
    }

    return peer;
}

function createRemoteAudioElement(participantId) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.dataset.participantId = participantId;
    elements.audioContainer.appendChild(audio);
    return audio;
}

async function flushIceCandidates(peer) {
    const pendingCandidates = peer.pendingIceCandidates.splice(0);

    for (const candidate of pendingCandidates) {
        try {
            await peer.connection.addIceCandidate(candidate);
        } catch (error) {
            console.error("Failed to flush ICE candidate:", error);
        }
    }
}

function ensureParticipantUi(participantId) {
    if (!participantId || getParticipantCard(participantId)) {
        return;
    }

    const label = createParticipantLabel(participantId);

    const card = document.createElement("article");
    card.className = "participant-card";
    card.dataset.participantId = participantId;
    card.innerHTML = `
        <div class="avatar-wrap">
            <div class="avatar">${escapeHtml(label.initials)}</div>
            <span class="voice-dot large" aria-label="Falando"></span>
        </div>
        <strong>${escapeHtml(label.name)}</strong>
        <span class="participant-status" data-role="status">conectando...</span>
    `;
    elements.participantGrid.appendChild(card);

    const person = document.createElement("div");
    person.className = "person-row";
    person.dataset.participantId = participantId;
    person.innerHTML = `
        <div class="avatar small-avatar">${escapeHtml(label.initials)}</div>
        <div class="person-copy">
            <strong>${escapeHtml(label.name)}</strong>
            <span>online</span>
        </div>
        <span class="voice-dot" aria-label="Falando"></span>
    `;
    elements.peopleList.appendChild(person);
}

function removeParticipantUi(participantId) {
    selectParticipantElements(participantId).forEach((element) => {
        if (element.dataset.participantId !== "self") {
            element.remove();
        }
    });
}

function removePeer(participantId) {
    const peer = peers.get(participantId);
    if (!peer) {
        return;
    }

    peer.audioMonitor?.stop();
    peer.connection.close();
    peer.audioElement.remove();
    peers.delete(participantId);
    setParticipantSpeaking(participantId, false);
}

function getParticipantCard(participantId) {
    return elements.participantGrid.querySelector(
        `[data-participant-id="${cssEscape(participantId)}"]`
    );
}

function selectParticipantElements(participantId) {
    return document.querySelectorAll(
        `[data-participant-id="${cssEscape(participantId)}"]`
    );
}

function setParticipantStatus(participantId, text) {
    const status = getParticipantCard(participantId)?.querySelector(
        '[data-role="status"]'
    );

    if (status) {
        status.textContent = text;
    }
}

function setParticipantSpeaking(participantId, speaking) {
    selectParticipantElements(participantId).forEach((element) => {
        element.classList.toggle("speaking", speaking);
    });
}

function createParticipantLabel(participantId) {
    const shortId = participantId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4);
    const suffix = shortId || "user";

    return {
        name: `Pessoa ${suffix.toUpperCase()}`,
        initials: suffix.slice(0, 2).toUpperCase()
    };
}

function updateParticipantCount() {
    const count = Math.max(1, participantTotal);
    elements.sidebarCount.textContent = String(count);
    elements.membersCount.textContent = String(count);
}

function updateEmptyState() {
    const remoteCount = elements.participantGrid.querySelectorAll(
        '.participant-card:not([data-participant-id="self"])'
    ).length;

    elements.emptyState.classList.toggle("visible", remoteCount === 0);
}

function setConnectionStatus(text, state) {
    elements.connectionText.textContent = text;
    elements.connectionPill.classList.remove("connected", "error");

    if (state === "connected") {
        elements.connectionPill.classList.add("connected");
    } else if (state === "error") {
        elements.connectionPill.classList.add("error");
    }
}

function createAudioActivityMonitor(stream, participantId) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
        return { stop() {} };
    }

    const audioContext = new AudioContextClass();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    const samples = new Uint8Array(256);

    audioContexts.add(audioContext);
    audioContext.resume().catch(() => {});
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);

    let animationFrameId = 0;
    let stopped = false;
    let speakingUntil = 0;
    let currentSpeaking = false;

    const tick = (now) => {
        if (stopped) {
            return;
        }

        analyser.getByteTimeDomainData(samples);

        let sumSquares = 0;
        for (const sample of samples) {
            const normalized = (sample - 128) / 128;
            sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / samples.length);

        if (rms > 0.028) {
            speakingUntil = now + 180;
        }

        const speaking = now < speakingUntil;
        if (speaking !== currentSpeaking) {
            currentSpeaking = speaking;
            setParticipantSpeaking(participantId, speaking);
        }

        animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);

    return {
        stop() {
            if (stopped) {
                return;
            }

            stopped = true;
            cancelAnimationFrame(animationFrameId);
            setParticipantSpeaking(participantId, false);

            try {
                source.disconnect();
                analyser.disconnect();
            } catch {}

            audioContexts.delete(audioContext);
            audioContext.close().catch(() => {});
        }
    };
}

function cleanup() {
    for (const participantId of [...peers.keys()]) {
        removePeer(participantId);
        removeParticipantUi(participantId);
    }

    localAudioMonitor?.stop();
    localAudioMonitor = null;

    if (localStream) {
        for (const track of localStream.getTracks()) {
            track.stop();
        }
        localStream = null;
    }

    setParticipantSpeaking("self", false);
    participantTotal = 1;
    updateParticipantCount();
    updateEmptyState();
}

function handleStartupError(error) {
    console.error(error);

    const isConfigurationError = String(error?.message || "").includes(
        "SOCKET_SERVER_URL"
    );

    setConnectionStatus(
        isConfigurationError ? "Configurar servidor" : "Erro no microfone",
        "error"
    );

    elements.localStatus.textContent = isConfigurationError
        ? "Servidor Render não configurado"
        : "Microfone indisponível";
    elements.localSidebarStatus.textContent = "offline";
    elements.roomDescription.textContent = isConfigurationError
        ? "Defina SOCKET_SERVER_URL no Netlify com a URL do seu serviço no Render."
        : "Permita o acesso ao microfone e atualize a página.";

    showToast(
        isConfigurationError
            ? "Configure SOCKET_SERVER_URL no Netlify."
            : "Não foi possível acessar o microfone."
    );
}

function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        elements.toast.classList.remove("visible");
    }, 1900);
}

function cssEscape(value) {
    if (window.CSS?.escape) {
        return window.CSS.escape(value);
    }

    return String(value).replace(/["\\]/g, "\\$&");
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

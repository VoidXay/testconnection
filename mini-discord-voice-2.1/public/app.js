const config = window.MINI_DISCORD_CONFIG || {};
const socketServerUrl = resolveSocketServerUrl(config.socketServerUrl);
const socket = io(socketServerUrl || undefined, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600,
    timeout: 12000
});

let rtcConfiguration = {
    iceServers: [
        {
            urls: [
                "stun:stun.relay.metered.ca:80",
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            ]
        }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: "all"
};

const SCREEN_SHARE_BITRATE = 2_500_000;
const SCREEN_SHARE_REQUEST_TIMEOUT = 7000;
const PROFILE_STORAGE_KEY = "mini-meet-profile-v1";
const MAX_AVATAR_FILE_SIZE = 6 * 1024 * 1024;
const MAX_AVATAR_DATA_LENGTH = 180_000;

const elements = {
    prejoin: document.getElementById("prejoin"),
    appShell: document.getElementById("appShell"),
    lobbyAvatarPreview: document.getElementById("lobbyAvatarPreview"),
    avatarInput: document.getElementById("avatarInput"),
    removeAvatarButton: document.getElementById("removeAvatarButton"),
    nicknameInput: document.getElementById("nicknameInput"),
    nicknameCount: document.getElementById("nicknameCount"),
    joinButton: document.getElementById("joinButton"),
    lobbyError: document.getElementById("lobbyError"),
    lobbyRoomCode: document.getElementById("lobbyRoomCode"),
    lobbyCopyLinkButton: document.getElementById("lobbyCopyLinkButton"),
    roomCodeText: document.getElementById("roomCodeText"),
    footerRoomCode: document.getElementById("footerRoomCode"),
    content: document.getElementById("content"),
    participantGrid: document.getElementById("participantGrid"),
    peopleList: document.getElementById("peopleList"),
    peoplePanel: document.getElementById("peoplePanel"),
    peopleButton: document.getElementById("peopleButton"),
    closePeopleButton: document.getElementById("closePeopleButton"),
    emptyState: document.getElementById("emptyState"),
    sidebarCount: document.getElementById("sidebarCount"),
    membersCount: document.getElementById("membersCount"),
    roomLink: document.getElementById("roomLink"),
    copyButton: document.getElementById("copyButton"),
    copyLinkButton: document.getElementById("copyLinkButton"),
    inviteButton: document.getElementById("inviteButton"),
    layoutButton: document.getElementById("layoutButton"),
    profileButton: document.getElementById("profileButton"),
    topProfileAvatar: document.getElementById("topProfileAvatar"),
    micButton: document.getElementById("micButton"),
    micText: document.getElementById("micText"),
    noiseButton: document.getElementById("noiseButton"),
    noiseText: document.getElementById("noiseText"),
    screenButton: document.getElementById("screenButton"),
    screenText: document.getElementById("screenText"),
    screenShareStage: document.getElementById("screenShareStage"),
    screenOwnerText: document.getElementById("screenOwnerText"),
    screenVideo: document.getElementById("screenVideo"),
    screenPlaceholder: document.getElementById("screenPlaceholder"),
    fullscreenButton: document.getElementById("fullscreenButton"),
    leaveButton: document.getElementById("leaveButton"),
    localDisplayName: document.getElementById("localDisplayName"),
    localSidebarName: document.getElementById("localSidebarName"),
    localStatus: document.getElementById("localStatus"),
    localSidebarStatus: document.getElementById("localSidebarStatus"),
    connectionPill: document.getElementById("connectionPill"),
    connectionText: document.getElementById("connectionText"),
    roomDescription: document.getElementById("roomDescription"),
    profileModal: document.getElementById("profileModal"),
    profileModalAvatarPreview: document.getElementById("profileModalAvatarPreview"),
    profileModalAvatarInput: document.getElementById("profileModalAvatarInput"),
    profileModalRemoveAvatarButton: document.getElementById("profileModalRemoveAvatarButton"),
    profileModalNicknameInput: document.getElementById("profileModalNicknameInput"),
    profileModalNicknameCount: document.getElementById("profileModalNicknameCount"),
    profileModalError: document.getElementById("profileModalError"),
    saveProfileButton: document.getElementById("saveProfileButton"),
    cancelProfileButton: document.getElementById("cancelProfileButton"),
    closeProfileModalButton: document.getElementById("closeProfileModalButton"),
    audioContainer: document.getElementById("audioContainer"),
    toast: document.getElementById("toast")
};

const peers = new Map();
const audioContexts = new Set();
const participantProfiles = new Map();
const participantMediaStates = new Map();

let roomId = resolveRoomId();
let localProfile = loadStoredProfile();
let lobbyAvatarDraft = localProfile.avatarDataUrl;
let modalAvatarDraft = localProfile.avatarDataUrl;
let roomActive = false;
let joiningRoom = false;
let localStream = null;
let localAudioMonitor = null;
let localScreenStream = null;
let activeScreenSharerId = null;
let isMuted = false;
let noiseSuppressionEnabled = true;
let noiseSuppressionSupported = false;
let screenShareStarting = false;
let screenShareStopping = false;
let participantTotal = 1;
let toastTimer = null;
let hasLeftRoom = false;

bootstrap().catch(handleStartupError);

async function bootstrap() {
    updateRoomUrl();
    bindUiEvents();
    updateEmptyState();
    updateParticipantCount();
    updateScreenShareUi();
    populateLobbyFromProfile();
    applyLocalProfileUi();
    updateRoomCodeUi();
    showPrejoin();

    if (!navigator.mediaDevices?.getUserMedia) {
        setLobbyError("Seu navegador não suporta acesso ao microfone.");
        elements.joinButton.disabled = true;
        return;
    }

    if (!socketServerUrl && isStaticHost()) {
        setLobbyError("O servidor Render ainda não foi configurado no Netlify.");
        elements.joinButton.disabled = true;
    }
}

async function enterRoomFromLobby() {
    if (joiningRoom || roomActive) {
        return;
    }

    const displayName = normalizeDisplayName(elements.nicknameInput.value);
    if (displayName.length < 2) {
        setLobbyError("Digite um nick com pelo menos 2 caracteres.");
        elements.nicknameInput.focus();
        return;
    }

    if (!socketServerUrl && isStaticHost()) {
        setLobbyError("SOCKET_SERVER_URL não está configurado no Netlify.");
        return;
    }

    joiningRoom = true;
    setLobbyError("");
    setJoinButtonLoading(true);

    localProfile = sanitizeProfile({
        displayName,
        avatarDataUrl: lobbyAvatarDraft
    });
    saveStoredProfile(localProfile);
    applyLocalProfileUi();

    try {
        await loadIceConfiguration();
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
        roomActive = true;
        hasLeftRoom = false;

        elements.micButton.disabled = false;
        elements.noiseButton.disabled = !noiseSuppressionSupported;
        elements.localStatus.textContent = "Microfone conectado";
        elements.localSidebarStatus.textContent = "online";
        elements.roomDescription.textContent = "Entrando na sala...";

        updateMicrophoneUi();
        updateNoiseUi();
        updateScreenShareUi();
        showMeeting();

        if (socket.connected) {
            joinRoom();
        } else {
            setConnectionStatus("Conectando", "waiting");
        }
    } catch (error) {
        console.error("Could not enter room:", error);
        if (localStream) {
            stopStream(localStream);
            localStream = null;
        }
        localAudioMonitor?.stop();
        localAudioMonitor = null;
        roomActive = false;

        if (error?.name === "NotAllowedError") {
            setLobbyError("Permita o acesso ao microfone para entrar na sala.");
        } else {
            setLobbyError("Não foi possível preparar o microfone. Tente novamente.");
        }
        showPrejoin();
    } finally {
        joiningRoom = false;
        setJoinButtonLoading(false);
    }
}

async function loadIceConfiguration() {
    if (!socketServerUrl) {
        return;
    }

    try {
        const response = await fetch(`${socketServerUrl}/ice-config`, {
            method: "GET",
            mode: "cors",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`ICE config request failed with ${response.status}.`);
        }

        const payload = await response.json();

        if (Array.isArray(payload.iceServers) && payload.iceServers.length > 0) {
            rtcConfiguration = {
                ...rtcConfiguration,
                iceServers: payload.iceServers
            };
        }

        if (!payload.turnConfigured) {
            console.warn("TURN is not configured on the Render service.");
        }
    } catch (error) {
        console.error("Could not load TURN configuration; using STUN only:", error);
    }
}

function bindUiEvents() {
    elements.copyButton.addEventListener("click", copyRoomLink);
    elements.copyLinkButton.addEventListener("click", copyRoomLink);
    elements.inviteButton.addEventListener("click", copyRoomLink);
    elements.lobbyCopyLinkButton.addEventListener("click", copyRoomLink);
    elements.joinButton.addEventListener("click", enterRoomFromLobby);
    elements.nicknameInput.addEventListener("input", () => {
        updateNicknameCounter(elements.nicknameInput, elements.nicknameCount);
        setLobbyError("");
    });
    elements.nicknameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            enterRoomFromLobby();
        }
    });
    elements.avatarInput.addEventListener("change", async () => {
        const [file] = elements.avatarInput.files || [];
        if (!file) {
            return;
        }
        try {
            lobbyAvatarDraft = await processAvatarFile(file);
            renderAvatarPreview(elements.lobbyAvatarPreview, {
                displayName: elements.nicknameInput.value || localProfile.displayName,
                avatarDataUrl: lobbyAvatarDraft
            });
            setLobbyError("");
        } catch (error) {
            setLobbyError(error.message || "Não foi possível usar essa imagem.");
        } finally {
            elements.avatarInput.value = "";
        }
    });
    elements.removeAvatarButton.addEventListener("click", () => {
        lobbyAvatarDraft = "";
        renderAvatarPreview(elements.lobbyAvatarPreview, {
            displayName: elements.nicknameInput.value || localProfile.displayName,
            avatarDataUrl: ""
        });
    });

    elements.micButton.addEventListener("click", toggleMicrophone);
    elements.noiseButton.addEventListener("click", toggleNoiseSuppression);
    elements.screenButton.addEventListener("click", toggleScreenShare);
    elements.fullscreenButton.addEventListener("click", toggleScreenFullscreen);
    elements.leaveButton.addEventListener("click", leaveRoom);
    elements.peopleButton.addEventListener("click", togglePeoplePanel);
    elements.closePeopleButton.addEventListener("click", closePeoplePanel);
    elements.layoutButton.addEventListener("click", () => {
        document.body.classList.toggle("compact-grid");
    });
    elements.profileButton.addEventListener("click", openProfileModal);
    elements.closeProfileModalButton.addEventListener("click", closeProfileModal);
    elements.cancelProfileButton.addEventListener("click", closeProfileModal);
    elements.saveProfileButton.addEventListener("click", saveProfileFromModal);
    elements.profileModalNicknameInput.addEventListener("input", () => {
        updateNicknameCounter(
            elements.profileModalNicknameInput,
            elements.profileModalNicknameCount
        );
        setProfileModalError("");
    });
    elements.profileModalAvatarInput.addEventListener("change", async () => {
        const [file] = elements.profileModalAvatarInput.files || [];
        if (!file) {
            return;
        }
        try {
            modalAvatarDraft = await processAvatarFile(file);
            renderAvatarPreview(elements.profileModalAvatarPreview, {
                displayName: elements.profileModalNicknameInput.value,
                avatarDataUrl: modalAvatarDraft
            });
            setProfileModalError("");
        } catch (error) {
            setProfileModalError(error.message || "Não foi possível usar essa imagem.");
        } finally {
            elements.profileModalAvatarInput.value = "";
        }
    });
    elements.profileModalRemoveAvatarButton.addEventListener("click", () => {
        modalAvatarDraft = "";
        renderAvatarPreview(elements.profileModalAvatarPreview, {
            displayName: elements.profileModalNicknameInput.value,
            avatarDataUrl: ""
        });
    });
    elements.profileModal.addEventListener("click", (event) => {
        if (event.target === elements.profileModal) {
            closeProfileModal();
        }
    });

    const unlockMedia = () => {
        for (const context of audioContexts) {
            if (context.state === "suspended") {
                context.resume().catch(() => {});
            }
        }
        for (const peer of peers.values()) {
            peer.audioElement.play().catch(() => {});
        }
        if (elements.screenVideo.srcObject) {
            elements.screenVideo.play().catch(() => {});
        }
    };

    window.addEventListener("pointerdown", unlockMedia, { passive: true });
    window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closePeoplePanel();
            closeProfileModal();
        }
    });
    window.addEventListener("beforeunload", () => {
        if (roomActive) {
            socket.emit("leave-room");
        }
        cleanup();
    });
}

function resolveSocketServerUrl(value) {
    return String(value || "").trim().replace(/\/$/, "");
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
    updateRoomCodeUi();
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

    if (roomActive && socket.connected) {
        socket.emit("set-muted", { muted: isMuted });
    }
}

function updateMicrophoneUi() {
    elements.micButton.classList.toggle("muted", isMuted);
    elements.micButton.setAttribute("aria-pressed", String(isMuted));
    elements.micText.textContent = isMuted ? "Ativar mic" : "Microfone";
    elements.localStatus.textContent = isMuted
        ? "Microfone desligado"
        : "Microfone conectado";
    elements.localSidebarStatus.textContent = isMuted ? "microfone desligado" : "online";
    setParticipantMuted("self", isMuted);
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

async function toggleScreenShare() {
    if (screenShareStarting || screenShareStopping || hasLeftRoom) {
        return;
    }

    if (localScreenStream) {
        await stopLocalScreenShare(true);
        return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
        showToast("Compartilhamento de tela não é suportado neste navegador.");
        return;
    }

    if (activeScreenSharerId && activeScreenSharerId !== socket.id) {
        showToast("Outra pessoa já está compartilhando a tela.");
        return;
    }

    if (!socket.connected) {
        showToast("Aguarde a conexão com a sala antes de compartilhar.");
        return;
    }

    screenShareStarting = true;
    updateScreenShareUi();

    let capturedStream = null;

    try {
        capturedStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                width: { ideal: 1920, max: 1920 },
                height: { ideal: 1080, max: 1080 },
                frameRate: { ideal: 30, max: 30 }
            },
            audio: false
        });

        const screenTrack = capturedStream.getVideoTracks()[0];

        if (!screenTrack) {
            throw new Error("No screen video track was returned by the browser.");
        }

        if ("contentHint" in screenTrack) {
            screenTrack.contentHint = "detail";
        }

        const grant = await requestScreenShareSlot();

        if (!grant.ok) {
            stopStream(capturedStream);
            capturedStream = null;

            if (grant.reason === "already-sharing") {
                showToast("Outra pessoa começou a compartilhar primeiro.");
            } else {
                showToast("Não foi possível iniciar o compartilhamento.");
            }
            return;
        }

        localScreenStream = capturedStream;
        capturedStream = null;
        screenTrack.onended = () => {
            stopLocalScreenShare(true).catch((error) => {
                console.error("Could not stop ended screen share:", error);
            });
        };

        setActiveScreenSharer(socket.id);
        await attachScreenTrackToAllPeers(screenTrack);
        showScreenStream(localScreenStream, true);
        showToast("Compartilhamento de tela iniciado.");
    } catch (error) {
        if (capturedStream) {
            stopStream(capturedStream);
        }

        if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
            showToast("Compartilhamento de tela cancelado.");
        } else {
            console.error("Screen sharing failed:", error);
            showToast("Não foi possível compartilhar a tela.");
        }
    } finally {
        screenShareStarting = false;
        updateScreenShareUi();
    }
}

function requestScreenShareSlot() {
    return new Promise((resolve) => {
        let resolved = false;

        const timer = setTimeout(() => {
            if (resolved) {
                return;
            }

            resolved = true;
            resolve({ ok: false, reason: "timeout" });
        }, SCREEN_SHARE_REQUEST_TIMEOUT);

        socket.emit("request-screen-share", {}, (response) => {
            if (resolved) {
                return;
            }

            resolved = true;
            clearTimeout(timer);
            resolve(response && typeof response === "object"
                ? response
                : { ok: false, reason: "invalid-response" });
        });
    });
}

async function reclaimLocalScreenShare() {
    const screenTrack = getLocalScreenTrack();

    if (!screenTrack || !socket.connected) {
        return;
    }

    const grant = await requestScreenShareSlot();

    if (!grant.ok) {
        await stopLocalScreenShare(false);
        return;
    }

    setActiveScreenSharer(socket.id);
    await attachScreenTrackToAllPeers(screenTrack);
    showScreenStream(localScreenStream, true);
}

async function stopLocalScreenShare(notifyServer) {
    if (!localScreenStream || screenShareStopping) {
        return;
    }

    screenShareStopping = true;
    updateScreenShareUi();

    const stream = localScreenStream;
    localScreenStream = null;

    try {
        const track = stream.getVideoTracks()[0];
        if (track) {
            track.onended = null;
        }

        await detachScreenTrackFromAllPeers();
        stopStream(stream);

        if (notifyServer && socket.connected) {
            socket.emit("stop-screen-share");
        }

        if (activeScreenSharerId === socket.id) {
            setActiveScreenSharer(null);
        }

        showToast("Compartilhamento de tela encerrado.");
    } finally {
        screenShareStopping = false;
        updateScreenShareUi();
    }
}

function getLocalScreenTrack() {
    const track = localScreenStream?.getVideoTracks()[0] || null;

    if (!track || track.readyState !== "live") {
        return null;
    }

    return track;
}

async function attachScreenTrackToAllPeers(screenTrack) {
    const updates = [];

    for (const [participantId, peer] of peers.entries()) {
        updates.push(
            attachScreenTrackToPeer(peer, screenTrack).then(() =>
                renegotiatePeerForScreenShare(participantId, peer)
            )
        );
    }

    await Promise.allSettled(updates);
}

async function attachScreenTrackToPeer(peer, screenTrack) {
    if (!peer.screenSender || peer.connection.signalingState === "closed") {
        return;
    }

    await peer.screenSender.replaceTrack(screenTrack);
    await configureScreenSender(peer.screenSender);
}

async function configureScreenSender(sender) {
    try {
        const parameters = sender.getParameters();

        if (Array.isArray(parameters.encodings) && parameters.encodings.length > 0) {
            parameters.encodings[0].maxBitrate = SCREEN_SHARE_BITRATE;
        }

        if ("degradationPreference" in parameters) {
            parameters.degradationPreference = "maintain-resolution";
        }

        await sender.setParameters(parameters);
    } catch (error) {
        console.warn("Could not apply screen bitrate parameters:", error);
    }
}

async function detachScreenTrackFromAllPeers() {
    const updates = [];

    for (const [participantId, peer] of peers.entries()) {
        if (!peer.screenSender || peer.connection.signalingState === "closed") {
            continue;
        }

        updates.push(
            peer.screenSender
                .replaceTrack(null)
                .then(() => renegotiatePeerForScreenShare(participantId, peer))
        );
    }

    await Promise.allSettled(updates);
}

async function renegotiatePeerForScreenShare(participantId, peer) {
    const connection = peer.connection;

    if (connection.signalingState === "closed") {
        return;
    }

    await waitForStableSignalingState(connection);

    if (connection.signalingState !== "stable") {
        throw new Error("Peer signaling state did not become stable in time.");
    }

    await createAndSendOffer(participantId, peer, false);
}

function waitForStableSignalingState(connection, timeoutMs = 5000) {
    if (connection.signalingState === "stable") {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let settled = false;

        const finish = () => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            connection.removeEventListener("signalingstatechange", onChange);
            resolve();
        };

        const onChange = () => {
            if (
                connection.signalingState === "stable" ||
                connection.signalingState === "closed"
            ) {
                finish();
            }
        };

        const timer = setTimeout(finish, timeoutMs);
        connection.addEventListener("signalingstatechange", onChange);
    });
}

function setActiveScreenSharer(participantId) {
    activeScreenSharerId = participantId || null;

    document.querySelectorAll("[data-participant-id]").forEach((element) => {
        element.classList.remove("screen-sharing");
    });

    if (activeScreenSharerId) {
        const uiParticipantId = toUiParticipantId(activeScreenSharerId);
        selectParticipantElements(uiParticipantId).forEach((element) => {
            element.classList.add("screen-sharing");
        });
    }

    refreshScreenStage();
    updateScreenShareUi();
}

function refreshScreenStage() {
    if (!activeScreenSharerId) {
        elements.screenShareStage.hidden = true;
        elements.content.classList.remove("screen-active");
        clearScreenVideo();
        return;
    }

    elements.screenShareStage.hidden = false;
    elements.content.classList.add("screen-active");

    if (activeScreenSharerId === socket.id) {
        elements.screenOwnerText.textContent = "Você está compartilhando";

        if (localScreenStream) {
            showScreenStream(localScreenStream, true);
        } else {
            showScreenPlaceholder("Preparando seu compartilhamento...");
        }
        return;
    }

    const label = createParticipantLabel(activeScreenSharerId);
    elements.screenOwnerText.textContent = `${label.name} está compartilhando`;

    const peer = peers.get(activeScreenSharerId);
    const track = peer?.remoteScreenTrack;

    if (
        peer?.remoteScreenStream &&
        track &&
        track.readyState === "live" &&
        !track.muted
    ) {
        showScreenStream(peer.remoteScreenStream, false);
    } else {
        showScreenPlaceholder("Conectando compartilhamento...");
    }
}

function showScreenStream(stream, muted) {
    if (!stream) {
        return;
    }

    if (elements.screenVideo.srcObject !== stream) {
        elements.screenVideo.srcObject = stream;
    }

    elements.screenVideo.muted = Boolean(muted);
    elements.screenPlaceholder.classList.add("hidden");
    elements.screenVideo.play().catch(() => {});
}

function showScreenPlaceholder(message) {
    elements.screenPlaceholder.querySelector("span").textContent = message;
    elements.screenPlaceholder.classList.remove("hidden");

    if (elements.screenVideo.srcObject) {
        elements.screenVideo.pause();
        elements.screenVideo.srcObject = null;
    }
}

function clearScreenVideo() {
    elements.screenVideo.pause();
    elements.screenVideo.srcObject = null;
    elements.screenVideo.muted = false;
    elements.screenPlaceholder.classList.remove("hidden");
}

function updateScreenShareUi() {
    const supported = Boolean(navigator.mediaDevices?.getDisplayMedia);
    const sharingLocally = Boolean(localScreenStream);
    const busyByOther = Boolean(
        activeScreenSharerId && activeScreenSharerId !== socket.id
    );

    elements.screenButton.classList.toggle("screen-active", sharingLocally);
    elements.screenButton.classList.toggle("screen-busy", busyByOther);

    if (!supported) {
        elements.screenText.textContent = "Tela indisponível";
        elements.screenButton.disabled = true;
        elements.screenButton.title = "Seu navegador não suporta compartilhamento de tela.";
        return;
    }

    if (screenShareStarting) {
        elements.screenText.textContent = "Preparando tela";
    } else if (screenShareStopping) {
        elements.screenText.textContent = "Encerrando tela";
    } else if (sharingLocally) {
        elements.screenText.textContent = "Parar tela";
    } else if (busyByOther) {
        elements.screenText.textContent = "Tela em uso";
    } else {
        elements.screenText.textContent = "Compartilhar tela";
    }

    elements.screenButton.disabled = Boolean(
        hasLeftRoom ||
        !localStream ||
        screenShareStarting ||
        screenShareStopping ||
        busyByOther
    );

    elements.screenButton.title = busyByOther
        ? "Outra pessoa já está compartilhando a tela."
        : "Compartilhar sua tela";
}

async function toggleScreenFullscreen() {
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
            return;
        }

        if (elements.screenShareStage.requestFullscreen) {
            await elements.screenShareStage.requestFullscreen();
        }
    } catch (error) {
        console.error("Fullscreen failed:", error);
        showToast("Não foi possível abrir em tela cheia.");
    }
}

function joinRoom() {
    if (!localStream || hasLeftRoom || !roomActive) {
        return;
    }

    socket.emit("join-room", {
        roomId,
        profile: localProfile,
        muted: isMuted
    });
}

async function leaveRoom() {
    if (!roomActive) {
        return;
    }

    hasLeftRoom = true;
    roomActive = false;

    if (localScreenStream) {
        await stopLocalScreenShare(true);
    }

    socket.emit("leave-room");
    cleanup();
    participantProfiles.clear();
    closePeoplePanel();

    elements.micButton.disabled = true;
    elements.noiseButton.disabled = true;
    elements.screenButton.disabled = true;
    elements.localStatus.textContent = "Fora da chamada";
    elements.localSidebarStatus.textContent = "offline";
    elements.roomDescription.textContent = "Entre novamente quando quiser.";

    populateLobbyFromProfile();
    showPrejoin();
    setConnectionStatus("Pronto", "waiting");
}

socket.on("connect", () => {
    if (roomActive && localStream && !hasLeftRoom) {
        joinRoom();
    }
});

socket.on("disconnect", (reason) => {
    if (!roomActive || hasLeftRoom) {
        return;
    }

    setConnectionStatus("Reconectando", "waiting");

    if (reason === "io server disconnect") {
        socket.connect();
    }
});

socket.on("connect_error", (error) => {
    console.error("Socket connection failed:", error);
    if (roomActive) {
        setConnectionStatus("Servidor offline", "error");
    }
});

socket.on("room-joined", async ({
    existingParticipants,
    participantCount,
    screenSharerId,
    participantProfiles: profilesById,
    participantStates: statesById
}) => {
    participantTotal = participantCount;
    updateParticipantCount();
    setConnectionStatus("Conectado", "connected");

    setActiveScreenSharer(screenSharerId || null);

    elements.roomDescription.textContent =
        existingParticipants.length === 0
            ? "Só você por enquanto. Convide alguém para entrar."
            : `${participantCount} pessoas conectadas na sala.`;

    for (const participantId of existingParticipants) {
        const profile = sanitizeProfile(profilesById?.[participantId]);
        const state = sanitizeParticipantState(statesById?.[participantId]);
        participantProfiles.set(participantId, profile);
        participantMediaStates.set(participantId, state);
        ensureParticipantUi(participantId, profile);
        setParticipantMuted(participantId, state.muted);
        await createPeerConnection(participantId, true);
    }

    setParticipantMuted("self", isMuted);

    if (localScreenStream && activeScreenSharerId !== socket.id) {
        reclaimLocalScreenShare().catch((error) => {
            console.error("Could not reclaim screen share after reconnect:", error);
        });
    }

    updateEmptyState();
});

socket.on("participant-joined", ({ participantId, participantCount, profile, muted }) => {
    if (!participantId || participantId === socket.id) {
        return;
    }

    participantTotal = participantCount;
    participantProfiles.set(participantId, sanitizeProfile(profile));
    participantMediaStates.set(participantId, { muted: Boolean(muted) });
    updateParticipantCount();
    ensureParticipantUi(participantId, profile);
    setParticipantMuted(participantId, Boolean(muted));
    updateEmptyState();
    elements.roomDescription.textContent = `${participantTotal} pessoas conectadas na sala.`;
});

socket.on("participant-left", ({ participantId }) => {
    if (activeScreenSharerId === participantId) {
        setActiveScreenSharer(null);
    }

    removePeer(participantId);
    removeParticipantUi(participantId);
    participantProfiles.delete(participantId);
    participantMediaStates.delete(participantId);
    updateEmptyState();
});

socket.on("participant-profile-updated", ({ participantId, profile }) => {
    if (!participantId || participantId === socket.id) {
        return;
    }

    const safeProfile = sanitizeProfile(profile);
    participantProfiles.set(participantId, safeProfile);
    updateParticipantProfileUi(participantId, safeProfile);

    if (activeScreenSharerId === participantId) {
        refreshScreenStage();
    }
});

socket.on("participant-count", ({ participantCount }) => {
    participantTotal = Math.max(1, Number(participantCount) || 1);
    updateParticipantCount();
});

socket.on("participant-media-state", ({ participantId, muted }) => {
    if (!participantId || participantId === socket.id) {
        return;
    }

    const state = { muted: Boolean(muted) };
    participantMediaStates.set(participantId, state);
    setParticipantMuted(participantId, state.muted);
});

socket.on("screen-share-started", ({ participantId }) => {
    if (!participantId) {
        return;
    }

    setActiveScreenSharer(participantId);
});

socket.on("screen-share-stopped", ({ participantId }) => {
    if (!participantId || activeScreenSharerId !== participantId) {
        return;
    }

    setActiveScreenSharer(null);
});

socket.on("webrtc-offer", async ({ senderId, offer }) => {
    if (!senderId || !offer || senderId === socket.id) {
        return;
    }

    try {
        ensureParticipantUi(senderId);

        const peer = await createPeerConnection(senderId, false);

        if (peer.connection.signalingState === "have-local-offer") {
            await peer.connection.setLocalDescription({ type: "rollback" });
        }

        await peer.connection.setRemoteDescription(offer);
        await flushIceCandidates(peer);

        const answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);

        socket.emit("webrtc-answer", {
            targetId: senderId,
            answer: peer.connection.localDescription
        });
    } catch (error) {
        console.error("Failed to handle WebRTC offer:", error);
    }
});

socket.on("webrtc-answer", async ({ senderId, answer }) => {
    const peer = peers.get(senderId);

    if (!peer || !answer) {
        return;
    }

    try {
        await peer.connection.setRemoteDescription(answer);
        await flushIceCandidates(peer);
    } catch (error) {
        console.error("Failed to handle WebRTC answer:", error);
    }
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

    for (const track of localStream.getAudioTracks()) {
        connection.addTrack(track, localStream);
    }

    const screenTransceiver = connection.addTransceiver("video", {
        direction: "sendrecv"
    });

    const peer = {
        connection,
        pendingIceCandidates: [],
        audioElement: createRemoteAudioElement(participantId),
        audioMonitor: null,
        screenSender: screenTransceiver.sender,
        remoteScreenTrack: null,
        remoteScreenStream: null,
        initiator: shouldCreateOffer,
        restartAttempts: 0,
        restartInProgress: false,
        disconnectedTimer: null
    };

    peers.set(participantId, peer);

    const screenTrack =
        activeScreenSharerId === socket.id ? getLocalScreenTrack() : null;

    if (screenTrack) {
        await attachScreenTrackToPeer(peer, screenTrack);
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

    connection.addEventListener("icecandidateerror", (event) => {
        console.warn("ICE candidate error:", {
            participantId,
            errorCode: event.errorCode,
            errorText: event.errorText,
            url: event.url
        });
    });

    connection.addEventListener("track", (event) => {
        if (event.track.kind === "audio") {
            handleRemoteAudioTrack(participantId, peer, event);
            return;
        }

        if (event.track.kind === "video") {
            handleRemoteScreenTrack(participantId, peer, event.track);
        }
    });

    connection.addEventListener("connectionstatechange", () => {
        const state = connection.connectionState;

        if (state === "connected") {
            clearTimeout(peer.disconnectedTimer);
            peer.disconnectedTimer = null;
            peer.restartAttempts = 0;
            peer.restartInProgress = false;
            setParticipantStatus(participantId, "áudio conectado");
            getParticipantCard(participantId)?.classList.add("connected");
        } else if (state === "connecting") {
            setParticipantStatus(participantId, "conectando...");
        } else if (state === "disconnected") {
            setParticipantStatus(participantId, "reconectando...");
            clearTimeout(peer.disconnectedTimer);

            peer.disconnectedTimer = setTimeout(() => {
                if (
                    peer.initiator &&
                    connection.connectionState === "disconnected"
                ) {
                    attemptIceRestart(participantId, peer);
                }
            }, 2500);
        } else if (state === "failed") {
            setParticipantSpeaking(participantId, false);

            if (peer.initiator && peer.restartAttempts < 2) {
                attemptIceRestart(participantId, peer);
            } else if (!peer.restartInProgress) {
                setParticipantStatus(participantId, "falha na conexão");
            }
        } else if (state === "closed") {
            clearTimeout(peer.disconnectedTimer);
            setParticipantSpeaking(participantId, false);
        }
    });

    if (shouldCreateOffer) {
        await createAndSendOffer(participantId, peer, false);
    }

    return peer;
}

function handleRemoteAudioTrack(participantId, peer, event) {
    const remoteStream = event.streams[0] || new MediaStream([event.track]);

    peer.audioElement.srcObject = remoteStream;
    peer.audioElement.play().catch(() => {});

    getParticipantCard(participantId)?.classList.add("connected");
    setParticipantStatus(participantId, "áudio conectado");

    peer.audioMonitor?.stop();
    peer.audioMonitor = createAudioActivityMonitor(remoteStream, participantId);
}

function handleRemoteScreenTrack(participantId, peer, track) {
    peer.remoteScreenTrack = track;
    peer.remoteScreenStream = new MediaStream([track]);

    track.onunmute = () => {
        if (activeScreenSharerId === participantId) {
            refreshScreenStage();
        }
    };

    track.onmute = () => {
        if (activeScreenSharerId === participantId) {
            showScreenPlaceholder("Compartilhamento pausado...");
        }
    };

    track.onended = () => {
        if (activeScreenSharerId === participantId) {
            showScreenPlaceholder("Compartilhamento encerrado...");
        }
    };

    if (activeScreenSharerId === participantId && !track.muted) {
        refreshScreenStage();
    }
}

async function createAndSendOffer(participantId, peer, iceRestart) {
    const connection = peer.connection;

    if (connection.signalingState === "closed") {
        return;
    }

    const offer = await connection.createOffer({ iceRestart });
    await connection.setLocalDescription(offer);

    socket.emit("webrtc-offer", {
        targetId: participantId,
        offer: connection.localDescription
    });
}

async function attemptIceRestart(participantId, peer) {
    if (
        peer.restartInProgress ||
        !peer.initiator ||
        peer.connection.signalingState === "closed"
    ) {
        return;
    }

    peer.restartInProgress = true;
    peer.restartAttempts += 1;
    setParticipantStatus(participantId, "recuperando conexão...");

    try {
        if (typeof peer.connection.restartIce === "function") {
            peer.connection.restartIce();
        }

        await createAndSendOffer(participantId, peer, true);
    } catch (error) {
        console.error("ICE restart failed:", error);

        if (peer.restartAttempts >= 2) {
            setParticipantStatus(participantId, "falha na conexão");
        }
    } finally {
        peer.restartInProgress = false;
    }
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

function ensureParticipantUi(participantId, suppliedProfile) {
    if (!participantId) {
        return;
    }

    if (suppliedProfile) {
        participantProfiles.set(participantId, sanitizeProfile(suppliedProfile));
    }

    const existingCard = getParticipantCard(participantId);
    if (existingCard) {
        updateParticipantProfileUi(participantId, participantProfiles.get(participantId));
        return;
    }

    const label = createParticipantLabel(participantId);

    const card = document.createElement("article");
    card.className = "participant-card";
    card.dataset.participantId = participantId;
    card.innerHTML = `
        <span class="screen-card-badge" data-role="screen-badge">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="4" width="18" height="13" rx="2"/>
                <path d="M9 21h6M12 17v4"/>
            </svg>
            Apresentando
        </span>
        <div class="participant-avatar-shell" data-role="avatar">
            ${renderParticipantAvatarMarkup(label, "participant-avatar")}
        </div>
        <div class="participant-card-footer">
            <div class="participant-name-line">
                <strong data-role="participant-name">${escapeHtml(label.name)}</strong>
            </div>
            <span class="voice-dot large" aria-label="Falando"></span>
        </div>
        <span class="participant-status" data-role="status">conectando...</span>
        <span class="mute-badge" data-role="mute-badge" aria-label="Microfone desligado" title="Microfone desligado">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 9v2a3 3 0 005.12 2.12M15 9V6a3 3 0 00-5.12-2.12M5 10v1a7 7 0 0011.2 5.6M19 10v1a7 7 0 01-.42 2.38M12 18v3M9 21h6M3 3l18 18"/>
            </svg>
            <span>Mic off</span>
        </span>
    `;
    elements.participantGrid.appendChild(card);

    const person = document.createElement("div");
    person.className = "person-row";
    person.dataset.participantId = participantId;
    person.innerHTML = `
        <div class="person-avatar" data-role="avatar">
            ${renderParticipantAvatarMarkup(label, "person-avatar-inner")}
        </div>
        <div class="person-copy">
            <strong data-role="participant-name">${escapeHtml(label.name)}</strong>
            <span data-role="sidebar-status">online</span>
        </div>
        <span class="screen-mini-badge" data-role="screen-badge" aria-label="Compartilhando tela">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="4" width="18" height="13" rx="2"/>
                <path d="M9 21h6M12 17v4"/>
            </svg>
        </span>
        <span class="mini-mute-badge" data-role="mute-badge" aria-label="Microfone desligado" title="Microfone desligado">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 9v2a3 3 0 005.12 2.12M15 9V6a3 3 0 00-5.12-2.12M5 10v1a7 7 0 0011.2 5.6M19 10v1a7 7 0 01-.42 2.38M3 3l18 18"/></svg>
        </span>
        <span class="voice-dot" aria-label="Falando"></span>
    `;
    elements.peopleList.appendChild(person);

    const participantState = sanitizeParticipantState(
        participantMediaStates.get(participantId)
    );
    setParticipantMuted(participantId, participantState.muted);

    if (activeScreenSharerId === participantId) {
        setActiveScreenSharer(participantId);
    }
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

    clearTimeout(peer.disconnectedTimer);
    peer.audioMonitor?.stop();

    if (peer.remoteScreenTrack) {
        peer.remoteScreenTrack.onunmute = null;
        peer.remoteScreenTrack.onmute = null;
        peer.remoteScreenTrack.onended = null;
    }

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

function toUiParticipantId(participantId) {
    return participantId === socket.id ? "self" : participantId;
}

function setParticipantStatus(participantId, text) {
    const status = getParticipantCard(participantId)?.querySelector(
        '[data-role="status"]'
    );

    if (status) {
        status.textContent = text;
    }

    const personRow = elements.peopleList.querySelector(
        `[data-participant-id="${cssEscape(participantId)}"]`
    );
    const sidebarStatus = personRow?.querySelector('[data-role="sidebar-status"]');
    if (sidebarStatus) {
        const state = sanitizeParticipantState(
            participantMediaStates.get(participantId)
        );
        sidebarStatus.textContent = state.muted
            ? "microfone desligado"
            : (text.includes("conect") ? "online" : text);
    }
}

function setParticipantMuted(participantId, muted) {
    const isParticipantMuted = Boolean(muted);

    selectParticipantElements(participantId).forEach((element) => {
        element.classList.toggle("muted", isParticipantMuted);
    });

    if (participantId !== "self") {
        const personRow = elements.peopleList.querySelector(
            `[data-participant-id="${cssEscape(participantId)}"]`
        );
        const sidebarStatus = personRow?.querySelector('[data-role="sidebar-status"]');
        if (sidebarStatus) {
            sidebarStatus.textContent = isParticipantMuted
                ? "microfone desligado"
                : "online";
        }
    }

    if (isParticipantMuted) {
        setParticipantSpeaking(participantId, false);
    }
}

function sanitizeParticipantState(value) {
    return {
        muted: Boolean(value?.muted)
    };
}

function setParticipantSpeaking(participantId, speaking) {
    selectParticipantElements(participantId).forEach((element) => {
        element.classList.toggle("speaking", speaking);
    });
}

function createParticipantLabel(participantId) {
    const profile = participantId === socket.id
        ? localProfile
        : sanitizeProfile(participantProfiles.get(participantId));
    const name = profile.displayName || "Convidado";

    return {
        name,
        initials: getInitials(name),
        avatarDataUrl: profile.avatarDataUrl || ""
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

function stopStream(stream) {
    if (!stream) {
        return;
    }

    for (const track of stream.getTracks()) {
        track.stop();
    }
}

function cleanup() {
    if (localScreenStream) {
        const screenStream = localScreenStream;
        localScreenStream = null;

        const screenTrack = screenStream.getVideoTracks()[0];
        if (screenTrack) {
            screenTrack.onended = null;
        }

        stopStream(screenStream);
    }

    activeScreenSharerId = null;
    clearScreenVideo();
    elements.screenShareStage.hidden = true;
    elements.content.classList.remove("screen-active");

    for (const participantId of [...peers.keys()]) {
        removePeer(participantId);
        removeParticipantUi(participantId);
    }

    localAudioMonitor?.stop();
    localAudioMonitor = null;

    if (localStream) {
        stopStream(localStream);
        localStream = null;
    }

    setParticipantSpeaking("self", false);
    participantMediaStates.clear();
    participantTotal = 1;
    updateParticipantCount();
    updateEmptyState();
    updateScreenShareUi();
}

function handleStartupError(error) {
    console.error(error);
    setLobbyError("Não foi possível iniciar a página. Atualize e tente novamente.");
    showPrejoin();
}

function populateLobbyFromProfile() {
    elements.nicknameInput.value = localProfile.displayName || "";
    lobbyAvatarDraft = localProfile.avatarDataUrl || "";
    updateNicknameCounter(elements.nicknameInput, elements.nicknameCount);
    renderAvatarPreview(elements.lobbyAvatarPreview, localProfile);
}

function updateRoomCodeUi() {
    const shortCode = roomId.length > 18 ? `${roomId.slice(0, 18)}…` : roomId;
    elements.lobbyRoomCode.textContent = shortCode;
    elements.roomCodeText.textContent = shortCode;
    elements.footerRoomCode.textContent = shortCode;
}

function showPrejoin() {
    elements.prejoin.classList.remove("is-hidden");
    elements.appShell.classList.add("is-hidden");
    elements.appShell.setAttribute("aria-hidden", "true");
    document.body.classList.remove("people-open");
}

function showMeeting() {
    elements.prejoin.classList.add("is-hidden");
    elements.appShell.classList.remove("is-hidden");
    elements.appShell.setAttribute("aria-hidden", "false");
}

function setJoinButtonLoading(loading) {
    elements.joinButton.disabled = loading;
    elements.joinButton.querySelector("span").textContent = loading
        ? "Preparando chamada..."
        : "Entrar na sala";
}

function setLobbyError(message) {
    elements.lobbyError.textContent = message || "";
}

function updateNicknameCounter(input, counter) {
    counter.textContent = `${input.value.length}/24`;
}

function togglePeoplePanel() {
    const opening = !document.body.classList.contains("people-open");
    document.body.classList.toggle("people-open", opening);
    elements.peoplePanel.setAttribute("aria-hidden", opening ? "false" : "true");
}

function closePeoplePanel() {
    document.body.classList.remove("people-open");
    elements.peoplePanel.setAttribute("aria-hidden", "true");
}

function openProfileModal() {
    modalAvatarDraft = localProfile.avatarDataUrl || "";
    elements.profileModalNicknameInput.value = localProfile.displayName || "";
    updateNicknameCounter(
        elements.profileModalNicknameInput,
        elements.profileModalNicknameCount
    );
    renderAvatarPreview(elements.profileModalAvatarPreview, localProfile);
    setProfileModalError("");
    elements.profileModal.hidden = false;
    setTimeout(() => elements.profileModalNicknameInput.focus(), 0);
}

function closeProfileModal() {
    if (!elements.profileModal.hidden) {
        elements.profileModal.hidden = true;
    }
}

function setProfileModalError(message) {
    elements.profileModalError.textContent = message || "";
}

function saveProfileFromModal() {
    const displayName = normalizeDisplayName(elements.profileModalNicknameInput.value);
    if (displayName.length < 2) {
        setProfileModalError("Digite um nick com pelo menos 2 caracteres.");
        return;
    }

    const nextProfile = sanitizeProfile({
        displayName,
        avatarDataUrl: modalAvatarDraft
    });

    localProfile = nextProfile;
    lobbyAvatarDraft = nextProfile.avatarDataUrl;
    saveStoredProfile(nextProfile);
    applyLocalProfileUi();
    populateLobbyFromProfile();
    closeProfileModal();

    if (roomActive && socket.connected) {
        socket.emit("update-profile", { profile: nextProfile }, (response) => {
            if (!response?.ok) {
                showToast("O perfil foi salvo localmente, mas não sincronizou com a sala.");
            }
        });
    }

    showToast("Perfil atualizado.");
}

function applyLocalProfileUi() {
    const label = {
        name: localProfile.displayName || "Você",
        initials: getInitials(localProfile.displayName || "Você"),
        avatarDataUrl: localProfile.avatarDataUrl || ""
    };

    elements.localDisplayName.textContent = label.name;
    elements.localSidebarName.textContent = label.name;
    renderAvatarPreview(elements.topProfileAvatar, localProfile);

    selectParticipantElements("self").forEach((element) => {
        const nameElement = element.querySelector('[data-role="participant-name"]');
        if (nameElement) {
            nameElement.textContent = label.name;
        }
        const avatarElement = element.querySelector('[data-role="avatar"]');
        if (avatarElement) {
            avatarElement.innerHTML = renderParticipantAvatarMarkup(
                label,
                element.classList.contains("person-row")
                    ? "person-avatar-inner"
                    : "participant-avatar"
            );
        }
    });
}

function updateParticipantProfileUi(participantId, suppliedProfile) {
    const safeProfile = sanitizeProfile(suppliedProfile);
    participantProfiles.set(participantId, safeProfile);
    const label = {
        name: safeProfile.displayName || "Convidado",
        initials: getInitials(safeProfile.displayName || "Convidado"),
        avatarDataUrl: safeProfile.avatarDataUrl || ""
    };

    selectParticipantElements(participantId).forEach((element) => {
        const nameElement = element.querySelector('[data-role="participant-name"]');
        if (nameElement) {
            nameElement.textContent = label.name;
        }
        const avatarElement = element.querySelector('[data-role="avatar"]');
        if (avatarElement) {
            avatarElement.innerHTML = renderParticipantAvatarMarkup(
                label,
                element.classList.contains("person-row")
                    ? "person-avatar-inner"
                    : "participant-avatar"
            );
        }
    });
}

function renderParticipantAvatarMarkup(label, className) {
    if (isSafeAvatarDataUrl(label.avatarDataUrl)) {
        return `<div class="${className}"><img src="${label.avatarDataUrl}" alt=""></div>`;
    }
    return `<div class="${className}">${escapeHtml(label.initials)}</div>`;
}

function renderAvatarPreview(container, profile) {
    const displayName = normalizeDisplayName(profile?.displayName || "") || "Você";
    const avatarDataUrl = isSafeAvatarDataUrl(profile?.avatarDataUrl)
        ? String(profile.avatarDataUrl)
        : "";
    const initials = getInitials(displayName);
    if (avatarDataUrl) {
        container.innerHTML = `<img src="${avatarDataUrl}" alt="">`;
    } else {
        container.innerHTML = `<span>${escapeHtml(initials)}</span>`;
    }
}

function loadStoredProfile() {
    try {
        const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
        if (!raw) {
            return { displayName: "", avatarDataUrl: "" };
        }
        return sanitizeProfile(JSON.parse(raw));
    } catch {
        return { displayName: "", avatarDataUrl: "" };
    }
}

function saveStoredProfile(profile) {
    try {
        window.localStorage.setItem(
            PROFILE_STORAGE_KEY,
            JSON.stringify(sanitizeProfile(profile))
        );
    } catch (error) {
        console.warn("Could not save profile locally:", error);
    }
}

function sanitizeProfile(profile) {
    const displayName = normalizeDisplayName(profile?.displayName || "");
    const avatarDataUrl = isSafeAvatarDataUrl(profile?.avatarDataUrl)
        ? String(profile.avatarDataUrl)
        : "";

    return {
        displayName: displayName || "Convidado",
        avatarDataUrl
    };
}

function normalizeDisplayName(value) {
    return String(value || "")
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 24);
}

function getInitials(name) {
    const parts = normalizeDisplayName(name).split(" ").filter(Boolean);
    if (parts.length === 0) {
        return "?";
    }
    if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
    }
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function isSafeAvatarDataUrl(value) {
    if (typeof value !== "string" || value.length > MAX_AVATAR_DATA_LENGTH) {
        return false;
    }
    return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

async function processAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpeg|webp)$/)) {
        throw new Error("Use uma imagem PNG, JPG ou WEBP.");
    }
    if (file.size > MAX_AVATAR_FILE_SIZE) {
        throw new Error("A imagem precisa ter no máximo 6 MB.");
    }

    const image = await loadImageFile(file);
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
        throw new Error("Seu navegador não conseguiu processar a imagem.");
    }

    const scale = Math.max(size / image.width, size / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const x = (size - width) / 2;
    const y = (size - height) / 2;
    context.fillStyle = "#22262b";
    context.fillRect(0, 0, size, size);
    context.drawImage(image, x, y, width, height);

    let result = canvas.toDataURL("image/webp", 0.82);
    if (!isSafeAvatarDataUrl(result)) {
        result = canvas.toDataURL("image/jpeg", 0.72);
    }
    if (!isSafeAvatarDataUrl(result)) {
        throw new Error("A foto ficou grande demais. Tente outra imagem.");
    }
    return result;
}

function loadImageFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Não foi possível abrir essa imagem."));
        };
        image.src = url;
    });
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

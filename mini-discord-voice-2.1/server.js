const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const allowedOrigins = parseAllowedOrigins(process.env.CLIENT_ORIGIN || "*");
const TURN_USERNAME = String(process.env.TURN_USERNAME || "").trim();
const TURN_CREDENTIAL = String(process.env.TURN_CREDENTIAL || "").trim();
const TURN_URLS = parseTurnUrls(process.env.TURN_URLS);

const screenSharers = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin(origin, callback) {
            if (
                !origin ||
                allowedOrigins.has("*") ||
                allowedOrigins.has(origin)
            ) {
                callback(null, true);
                return;
            }

            callback(new Error("Origin not allowed by CLIENT_ORIGIN."));
        },
        methods: ["GET", "POST"]
    },
    transports: ["websocket", "polling"]
});

app.disable("x-powered-by");

app.use((req, res, next) => {
    const origin = String(req.headers.origin || "").replace(/\/$/, "");

    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }

    next();
});

app.use(express.static(PUBLIC_DIR));

app.get("/health", (_req, res) => {
    res.status(200).json({
        ok: true,
        service: "mini-discord-voice",
        version: "2.3.1",
        turnConfigured: Boolean(TURN_USERNAME && TURN_CREDENTIAL)
    });
});

app.get("/ice-config", (req, res) => {
    const origin = String(req.headers.origin || "").replace(/\/$/, "");

    if (
        origin &&
        !allowedOrigins.has("*") &&
        !allowedOrigins.has(origin)
    ) {
        res.status(403).json({ error: "Origin not allowed." });
        return;
    }

    const iceServers = [
        {
            urls: [
                "stun:stun.relay.metered.ca:80",
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            ]
        }
    ];

    if (TURN_USERNAME && TURN_CREDENTIAL) {
        for (const url of TURN_URLS) {
            iceServers.push({
                urls: url,
                username: TURN_USERNAME,
                credential: TURN_CREDENTIAL
            });
        }
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
        iceServers,
        turnConfigured: Boolean(TURN_USERNAME && TURN_CREDENTIAL)
    });
});

app.get("/:roomId", (req, res, next) => {
    if (!isValidRoomId(req.params.roomId)) {
        next();
        return;
    }

    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

io.on("connection", (socket) => {
    socket.on("join-room", ({ roomId } = {}) => {
        if (!isValidRoomId(roomId)) {
            socket.emit("room-error", {
                message: "Invalid room link."
            });
            return;
        }

        leaveCurrentRoom(socket);

        const room = io.sockets.adapter.rooms.get(roomId);
        const existingParticipants = room ? Array.from(room) : [];
        const screenSharerId = getActiveScreenSharer(roomId);

        socket.join(roomId);
        socket.data.roomId = roomId;

        socket.emit("room-joined", {
            roomId,
            participantId: socket.id,
            existingParticipants,
            participantCount: existingParticipants.length + 1,
            screenSharerId
        });

        socket.to(roomId).emit("participant-joined", {
            participantId: socket.id,
            participantCount: existingParticipants.length + 1
        });

        emitParticipantCount(roomId);
    });

    socket.on("request-screen-share", (_payload, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};
        const roomId = socket.data.roomId;

        if (!isSocketInRoom(socket, roomId)) {
            reply({ ok: false, reason: "not-in-room" });
            return;
        }

        const currentSharerId = getActiveScreenSharer(roomId);

        if (currentSharerId && currentSharerId !== socket.id) {
            reply({
                ok: false,
                reason: "already-sharing",
                participantId: currentSharerId
            });
            return;
        }

        screenSharers.set(roomId, socket.id);
        socket.data.screenSharing = true;

        reply({ ok: true });
        io.to(roomId).emit("screen-share-started", {
            participantId: socket.id
        });
    });

    socket.on("stop-screen-share", () => {
        releaseScreenShare(socket);
    });

    socket.on("webrtc-offer", ({ targetId, offer } = {}) => {
        if (!offer || !canSignal(socket, targetId)) {
            return;
        }

        io.to(targetId).emit("webrtc-offer", {
            senderId: socket.id,
            offer
        });
    });

    socket.on("webrtc-answer", ({ targetId, answer } = {}) => {
        if (!answer || !canSignal(socket, targetId)) {
            return;
        }

        io.to(targetId).emit("webrtc-answer", {
            senderId: socket.id,
            answer
        });
    });

    socket.on("webrtc-ice-candidate", ({ targetId, candidate } = {}) => {
        if (!candidate || !canSignal(socket, targetId)) {
            return;
        }

        io.to(targetId).emit("webrtc-ice-candidate", {
            senderId: socket.id,
            candidate
        });
    });

    socket.on("leave-room", () => {
        leaveCurrentRoom(socket);
    });

    socket.on("disconnecting", () => {
        const roomId = socket.data.roomId;

        if (!roomId) {
            return;
        }

        releaseScreenShare(socket, roomId);

        socket.to(roomId).emit("participant-left", {
            participantId: socket.id
        });
    });

    socket.on("disconnect", () => {
        const roomId = socket.data.roomId;

        if (roomId) {
            emitParticipantCount(roomId);
        }
    });
});

function parseAllowedOrigins(value) {
    return new Set(
        String(value)
            .split(",")
            .map((origin) => origin.trim().replace(/\/$/, ""))
            .filter(Boolean)
    );
}

function parseTurnUrls(value) {
    const configuredUrls = String(value || "")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean);

    if (configuredUrls.length > 0) {
        return configuredUrls;
    }

    return [
        "turn:global.relay.metered.ca:80",
        "turn:global.relay.metered.ca:80?transport=tcp",
        "turn:global.relay.metered.ca:443",
        "turns:global.relay.metered.ca:443?transport=tcp"
    ];
}

function isValidRoomId(roomId) {
    return (
        typeof roomId === "string" &&
        /^[a-zA-Z0-9_-]{6,80}$/.test(roomId)
    );
}

function isSocketInRoom(socket, roomId) {
    return (
        typeof roomId === "string" &&
        socket.data.roomId === roomId &&
        socket.rooms.has(roomId)
    );
}

function canSignal(socket, targetId) {
    const roomId = socket.data.roomId;

    if (!roomId || typeof targetId !== "string" || targetId === socket.id) {
        return false;
    }

    const room = io.sockets.adapter.rooms.get(roomId);

    return Boolean(room && room.has(socket.id) && room.has(targetId));
}

function getActiveScreenSharer(roomId) {
    if (!roomId) {
        return null;
    }

    const sharerId = screenSharers.get(roomId);
    if (!sharerId) {
        return null;
    }

    const room = io.sockets.adapter.rooms.get(roomId);

    if (!room || !room.has(sharerId)) {
        screenSharers.delete(roomId);
        return null;
    }

    return sharerId;
}

function releaseScreenShare(socket, forcedRoomId) {
    const roomId = forcedRoomId || socket.data.roomId;

    if (!roomId || screenSharers.get(roomId) !== socket.id) {
        socket.data.screenSharing = false;
        return;
    }

    screenSharers.delete(roomId);
    socket.data.screenSharing = false;

    io.to(roomId).emit("screen-share-stopped", {
        participantId: socket.id
    });
}

function leaveCurrentRoom(socket) {
    const roomId = socket.data.roomId;

    if (!roomId) {
        return;
    }

    releaseScreenShare(socket, roomId);

    socket.to(roomId).emit("participant-left", {
        participantId: socket.id
    });

    socket.leave(roomId);
    socket.data.roomId = null;

    setImmediate(() => emitParticipantCount(roomId));
}

function emitParticipantCount(roomId) {
    if (!roomId) {
        return;
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const participantCount = room ? room.size : 0;

    if (participantCount === 0) {
        screenSharers.delete(roomId);
    }

    io.to(roomId).emit("participant-count", {
        participantCount
    });
}

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Mini Discord Voice 2.3 listening on port ${PORT}`);
});

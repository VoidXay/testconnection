const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const allowedOrigins = parseAllowedOrigins(process.env.CLIENT_ORIGIN || "*");

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
app.use(express.static(PUBLIC_DIR));

app.get("/health", (_req, res) => {
    res.status(200).json({
        ok: true,
        service: "mini-discord-voice"
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

        socket.join(roomId);
        socket.data.roomId = roomId;

        socket.emit("room-joined", {
            roomId,
            participantId: socket.id,
            existingParticipants,
            participantCount: existingParticipants.length + 1
        });

        socket.to(roomId).emit("participant-joined", {
            participantId: socket.id,
            participantCount: existingParticipants.length + 1
        });

        emitParticipantCount(roomId);
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

function isValidRoomId(roomId) {
    return (
        typeof roomId === "string" &&
        /^[a-zA-Z0-9_-]{6,80}$/.test(roomId)
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

function leaveCurrentRoom(socket) {
    const roomId = socket.data.roomId;

    if (!roomId) {
        return;
    }

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

    io.to(roomId).emit("participant-count", {
        participantCount
    });
}

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Mini Discord Voice listening on port ${PORT}`);
});

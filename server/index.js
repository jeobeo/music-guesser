import express from 'express';
import { createServer } from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = process.env.NODE_ENV === 'production';
const port = process.env.PORT || 3000;
const distPath = path.join(__dirname, '..', 'dist');
const hasClientBuild = fs.existsSync(path.join(distPath, 'index.html'));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: isProduction ? undefined : { origin: 'http://localhost:5173' }
});

const sessions = new Map();
const EMPTY_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function createSession() {
  const id = generateSessionId();

  sessions.set(id, {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOccupiedAt: Date.now(),
    contentUpdatedAt: Date.now(),
    videoId: '',
    duration: 0,
    position: 0,
    playing: false,
    updatedBy: null
  });

  return { id };
}

function generateSessionId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';

  do {
    id = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (sessions.has(id));

  return id;
}

function publicState(session) {
  return {
    id: session.id,
    videoId: session.videoId,
    duration: session.duration,
    position: session.position,
    playing: session.playing,
    updatedAt: session.updatedAt
  };
}

function getSyncedPosition(session) {
  if (!session.videoId) return 0;
  const elapsed = session.playing ? (Date.now() - session.updatedAt) / 1000 : 0;
  const duration = session.duration || Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(duration, session.position + elapsed));
}

function applyRoomUpdate(session, payload, socketId) {
  const now = Date.now();
  const hasVideoId = typeof payload.videoId === 'string';
  const hasPosition = Number.isFinite(payload.position);
  const hasDuration = Number.isFinite(payload.duration);
  const hasPlaying = typeof payload.playing === 'boolean';
  const currentPosition = getSyncedPosition(session);

  if (hasVideoId && payload.videoId !== session.videoId) {
    session.videoId = payload.videoId;
    session.duration = hasDuration ? Math.max(0, payload.duration) : 0;
    session.position = hasPosition ? Math.max(0, payload.position) : 0;
    session.playing = hasPlaying ? payload.playing : false;
    session.updatedAt = now;
    session.contentUpdatedAt = Date.now();
    session.updatedBy = socketId;
    return;
  }

  if (hasDuration) {
    session.duration = Math.max(0, payload.duration);
  }

  if (hasPosition || hasPlaying) {
    const nextPosition = hasPosition ? payload.position : currentPosition;
    session.position = Math.max(0, Math.min(session.duration || Number.POSITIVE_INFINITY, nextPosition));
    if (hasPlaying) session.playing = payload.playing;
    session.updatedAt = now;
    session.updatedBy = socketId;
  }
}

function emitPresence(roomId) {
  const session = sessions.get(roomId);
  const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;

  if (session && count > 0) {
    session.lastOccupiedAt = Date.now();
  }

  io.to(roomId).emit('session:presence', {
    count
  });
}

app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/api/sessions', (_req, res) => {
  res.status(201).json(createSession());
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id.toUpperCase());
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json(publicState(session));
});

io.on('connection', (socket) => {
  socket.on('session:join', ({ sessionId } = {}, ack) => {
    const normalizedId = String(sessionId || '').toUpperCase();
    const session = sessions.get(normalizedId);

    if (!session) {
      ack?.({ ok: false, error: 'Session not found' });
      return;
    }

    socket.join(normalizedId);
    session.lastOccupiedAt = Date.now();

    ack?.({
      ok: true,
      state: publicState(session)
    });

    emitPresence(normalizedId);
  });

  socket.on('session:leave', ({ sessionId } = {}, ack) => {
    const normalizedId = String(sessionId || '').toUpperCase();

    if (!sessions.has(normalizedId)) {
      ack?.({ ok: false });
      return;
    }

    socket.leave(normalizedId);
    emitPresence(normalizedId);
    ack?.({ ok: true });
  });

  socket.on('session:update', ({ sessionId, state } = {}, ack) => {
    const normalizedId = String(sessionId || '').toUpperCase();
    const session = sessions.get(normalizedId);

    if (!session || !socket.rooms.has(normalizedId)) {
      ack?.({ ok: false });
      return;
    }

    applyRoomUpdate(session, state || {}, socket.id);
    io.to(normalizedId).emit('session:state', publicState(session));
    ack?.({ ok: true });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (!sessions.has(roomId)) continue;
      const currentSize = io.sockets.adapter.rooms.get(roomId)?.size || 1;
      socket.to(roomId).emit('session:presence', { count: Math.max(0, currentSize - 1) });
    }
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions) {
    const roomSize = io.sockets.adapter.rooms.get(id)?.size || 0;
    const staleWhileEmpty = roomSize === 0 && now - session.lastOccupiedAt > EMPTY_SESSION_TTL_MS;

    if (staleWhileEmpty) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

if (isProduction || hasClientBuild) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Listening on ${port}`);
});

import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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

function createSession() {
  const id = generateSessionId();
  const hostToken = randomUUID();

  sessions.set(id, {
    id,
    hostToken,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    videoId: '',
    duration: 0,
    position: 0,
    playing: false,
    updatedBy: null
  });

  return { id, hostToken };
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

function applyHostUpdate(session, payload, socketId) {
  const position = Number.isFinite(payload.position) ? payload.position : getSyncedPosition(session);
  const duration = Number.isFinite(payload.duration) ? payload.duration : session.duration;

  if (typeof payload.videoId === 'string') {
    session.videoId = payload.videoId;
  }

  session.duration = Math.max(0, duration);
  session.position = Math.max(0, Math.min(session.duration || Number.POSITIVE_INFINITY, position));
  session.playing = Boolean(payload.playing);
  session.updatedAt = Date.now();
  session.updatedBy = socketId;
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
  socket.on('session:join', ({ sessionId, hostToken } = {}, ack) => {
    const normalizedId = String(sessionId || '').toUpperCase();
    const session = sessions.get(normalizedId);

    if (!session) {
      ack?.({ ok: false, error: 'Session not found' });
      return;
    }

    const isHost = hostToken === session.hostToken;
    const roomSize = io.sockets.adapter.rooms.get(normalizedId)?.size || 0;

    if (!isHost && roomSize >= 2) {
      ack?.({ ok: false, error: 'Session full' });
      return;
    }

    socket.join(normalizedId);

    ack?.({
      ok: true,
      isHost,
      state: publicState(session)
    });

    io.to(normalizedId).emit('session:presence', {
      count: io.sockets.adapter.rooms.get(normalizedId)?.size || 0
    });
  });

  socket.on('session:update', ({ sessionId, hostToken, state } = {}, ack) => {
    const normalizedId = String(sessionId || '').toUpperCase();
    const session = sessions.get(normalizedId);

    if (!session || hostToken !== session.hostToken) {
      ack?.({ ok: false });
      return;
    }

    applyHostUpdate(session, state || {}, socket.id);
    io.to(normalizedId).emit('session:state', publicState(session));
    ack?.({ ok: true });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (!sessions.has(roomId)) continue;
      const currentSize = io.sockets.adapter.rooms.get(roomId)?.size || 1;
      socket.to(roomId).emit('session:presence', {
        count: Math.max(0, currentSize - 1)
      });
    }
  });
});

if (isProduction || hasClientBuild) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Listening on ${port}`);
});

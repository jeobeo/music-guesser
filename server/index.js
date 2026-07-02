import express from 'express';
import { createServer } from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import yts from 'yt-search';

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
const SEARCH_VIDEO_PAGE_SIZE = 12;
const SEARCH_PLAYLIST_PAGE_SIZE = 8;
const ROOM_WORDS = [
  'rabbit', 'kitten', 'donkey', 'monkey', 'turtle', 'parrot', 'pigeon', 'salmon', 'spider', 'beetle',
  'lizard', 'weasel', 'ferret', 'badger', 'beaver', 'gopher', 'walrus', 'coyote', 'cougar', 'jaguar',
  'bobcat', 'banana', 'orange', 'cherry', 'tomato', 'potato', 'carrot', 'celery', 'pepper', 'pickle',
  'cheese', 'butter', 'yogurt', 'muffin', 'cookie', 'noodle', 'cereal', 'waffle', 'burger', 'coffee',
  'peanut', 'almond', 'walnut', 'raisin', 'garlic', 'ginger', 'bottle', 'button', 'basket', 'candle',
  'camera', 'mirror', 'pillow', 'ticket', 'wallet', 'pencil', 'marker', 'drawer', 'closet', 'hammer',
  'shovel', 'ladder', 'carpet', 'window', 'faucet', 'toilet', 'shower', 'sponge', 'forest', 'desert',
  'meadow', 'island', 'valley', 'canyon', 'pebble', 'flower', 'garden', 'branch', 'stream', 'jungle',
  'lagoon', 'rocket', 'planet', 'crater', 'fossil', 'doctor', 'farmer', 'driver', 'singer', 'dancer',
  'writer', 'editor', 'artist', 'lawyer', 'barber', 'sailor', 'tailor', 'parent', 'cousin', 'mother'
];

function createSession() {
  const id = generateSessionId();
  if (!id) return null;

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
  const availableWords = ROOM_WORDS.filter((word) => !sessions.has(word));
  if (availableWords.length === 0) return null;

  return availableWords[Math.floor(Math.random() * availableWords.length)];
}

function normalizeSessionId(value = '') {
  return String(value).trim().toLowerCase();
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

function normalizeVideo(video) {
  const videoId = video.videoId || video.video_id || extractYoutubeVideoId(video.url);
  if (!videoId) return null;

  return {
    type: 'video',
    id: videoId,
    title: video.title || 'Untitled video',
    author: video.author?.name || video.author || '',
    duration: video.seconds || 0,
    timestamp: video.timestamp || '',
    thumbnail: video.thumbnail || video.image || '',
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

function normalizePlaylist(playlist) {
  const playlistId =
    playlist.listId ||
    playlist.playlistId ||
    playlist.playlistID ||
    playlist.id ||
    extractYoutubePlaylistId(playlist.url || playlist.link || playlist.href || '');
  if (!playlistId) return null;

  return {
    type: 'playlist',
    id: playlistId,
    title: playlist.title || 'Untitled playlist',
    author: playlist.author?.name || playlist.author || '',
    videoCount: playlist.videoCount || playlist.length || 0,
    thumbnail: playlist.thumbnail || playlist.image || '',
    url: `https://www.youtube.com/playlist?list=${playlistId}`
  };
}

function extractYoutubeVideoId(value = '') {
  try {
    const url = new URL(value);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1).split('/')[0];
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const embedMatch = url.pathname.match(/\/(?:embed|shorts|live)\/([^/?]+)/);
    return embedMatch?.[1] || '';
  } catch {
    return /^[a-zA-Z0-9_-]{11}$/.test(value.trim()) ? value.trim() : '';
  }
}

function extractYoutubePlaylistId(value = '') {
  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);
    return url.searchParams.get('list') || '';
  } catch {
    return /^[a-zA-Z0-9_-]{10,}$/.test(trimmed) ? trimmed : '';
  }
}

app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/youtube/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const kind = String(req.query.kind || 'all');
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);

  if (query.length < 2) {
    res.status(400).json({ error: 'Search query is too short' });
    return;
  }

  try {
    const result = await yts({ query });
    const allVideos = (result.videos || []).map(normalizeVideo).filter(Boolean);
    const allPlaylists = (result.playlists || []).map(normalizePlaylist).filter(Boolean);
    const videoStart = (page - 1) * SEARCH_VIDEO_PAGE_SIZE;
    const playlistStart = (page - 1) * SEARCH_PLAYLIST_PAGE_SIZE;
    const videos = kind === 'playlist' ? [] : allVideos.slice(videoStart, videoStart + SEARCH_VIDEO_PAGE_SIZE);
    const playlists = kind === 'video' ? [] : allPlaylists.slice(playlistStart, playlistStart + SEARCH_PLAYLIST_PAGE_SIZE);

    res.json({
      videos,
      playlists,
      hasMore: {
        video: videoStart + SEARCH_VIDEO_PAGE_SIZE < allVideos.length,
        playlist: playlistStart + SEARCH_PLAYLIST_PAGE_SIZE < allPlaylists.length
      }
    });
  } catch {
    res.status(502).json({ error: 'YouTube search failed' });
  }
});

app.get('/api/youtube/playlist', async (req, res) => {
  const listId = extractYoutubePlaylistId(String(req.query.id || req.query.url || '').trim());

  if (!listId) {
    res.status(400).json({ error: 'Playlist id is required' });
    return;
  }

  try {
    const playlist = await yts({ listId });
    const videos = (playlist.videos || []).map(normalizeVideo).filter(Boolean);

    res.json({
      id: listId,
      title: playlist.title || 'Playlist',
      videos
    });
  } catch {
    res.status(502).json({ error: 'YouTube playlist failed' });
  }
});

app.post('/api/sessions', (_req, res) => {
  const session = createSession();
  if (!session) {
    res.status(503).json({ error: 'No rooms available' });
    return;
  }

  res.status(201).json(session);
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(normalizeSessionId(req.params.id));
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json(publicState(session));
});

io.on('connection', (socket) => {
  socket.on('session:join', ({ sessionId } = {}, ack) => {
    const normalizedId = normalizeSessionId(sessionId);
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
    const normalizedId = normalizeSessionId(sessionId);

    if (!sessions.has(normalizedId)) {
      ack?.({ ok: false });
      return;
    }

    socket.leave(normalizedId);
    emitPresence(normalizedId);
    ack?.({ ok: true });
  });

  socket.on('session:update', ({ sessionId, state } = {}, ack) => {
    const normalizedId = normalizeSessionId(sessionId);
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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { Copy, Link as LinkIcon, Loader2, Pause, Play, Radio, RotateCcw, Users, Volume2 } from 'lucide-react';
import './styles.css';

const socket = io();
const HOST_HEARTBEAT_MS = 900;
const HARD_DRIFT_SECONDS = 0.55;
const SOFT_DRIFT_SECONDS = 0.16;
const VOLUME_KEY = 'music-guessing-volume';

function App() {
  const [route, setRoute] = useState(() => parseRoute());
  const [session, setSession] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [status, setStatus] = useState('idle');
  const [presence, setPresence] = useState(1);

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!route.sessionId) {
      setSession(null);
      setIsHost(false);
      setStatus('idle');
      return;
    }

    const hostToken = localStorage.getItem(hostTokenKey(route.sessionId));
    setStatus('joining');
    socket.emit('session:join', { sessionId: route.sessionId, hostToken }, (response) => {
      if (!response?.ok) {
        setStatus(response?.error === 'Session full' ? 'full' : 'missing');
        return;
      }

      setSession(response.state);
      setIsHost(response.isHost);
      setStatus('ready');
    });

    const handleState = (state) => setSession(state);
    const handlePresence = ({ count }) => setPresence(count);

    socket.on('session:state', handleState);
    socket.on('session:presence', handlePresence);

    return () => {
      socket.off('session:state', handleState);
      socket.off('session:presence', handlePresence);
    };
  }, [route.sessionId]);

  async function startSession() {
    setStatus('creating');
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      setStatus('idle');
      return;
    }

    const nextSession = await response.json();
    localStorage.setItem(hostTokenKey(nextSession.id), nextSession.hostToken);
    window.history.pushState(null, '', `/s/${nextSession.id}`);
    setRoute({ sessionId: nextSession.id });
  }

  if (!route.sessionId) {
    return <StartScreen onStart={startSession} busy={status === 'creating'} />;
  }

  if (status === 'idle' || status === 'joining' || !session) {
    return <Shell><Loader label="Joining" /></Shell>;
  }

  if (status === 'missing') {
    return (
      <Shell>
        <section className="empty-state">
          <Radio size={28} />
          <h1>Session unavailable</h1>
          <button className="primary" onClick={startSession}>Start session</button>
        </section>
      </Shell>
    );
  }

  if (status === 'full') {
    return (
      <Shell>
        <section className="empty-state">
          <Users size={28} />
          <h1>Session full</h1>
        </section>
      </Shell>
    );
  }

  return (
    <SessionRoom
      session={session}
      isHost={isHost}
      presence={presence}
      hostToken={localStorage.getItem(hostTokenKey(route.sessionId))}
    />
  );
}

function StartScreen({ onStart, busy }) {
  return (
    <Shell>
      <main className="start-grid">
        <section>
          <div className="mark"><Radio size={30} /></div>
          <h1>Blind music rooms</h1>
          <p>Two-person synced YouTube playback with no visible video details.</p>
        </section>
        <button className="primary start-button" onClick={onStart} disabled={busy}>
          {busy ? <Loader2 className="spin" size={20} /> : <Radio size={20} />}
          Start session
        </button>
      </main>
    </Shell>
  );
}

function SessionRoom({ session, isHost, presence, hostToken }) {
  const [url, setUrl] = useState('');
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localPosition, setLocalPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioReady, setAudioReady] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(isHost);
  const [volume, setVolume] = useState(() => readStoredVolume());
  const playerRef = useRef(null);
  const syncLockRef = useRef(false);
  const lastSentRef = useRef(0);
  const lastVideoRef = useRef('');

  const inviteUrl = `${window.location.origin}/s/${session?.id || ''}`;
  const needsAudioJoin = !isHost && session.videoId && !audioUnlocked;

  useEffect(() => {
    if (!playerRef.current || !audioReady) return;
    playerRef.current.setVolume?.(volume);
  }, [audioReady, volume]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!session?.videoId) {
        setLocalPosition(0);
        setDuration(0);
        setLocalPlaying(false);
        return;
      }

      if (!isHost && !audioUnlocked) {
        setLocalPosition(syncedPosition(session));
        if (session.duration) setDuration(session.duration);
        return;
      }

      if (!playerRef.current || syncLockRef.current) return;

      const state = safeCall(() => playerRef.current.getPlayerState(), null);
      const current = safeCall(() => playerRef.current.getCurrentTime(), localPosition);
      const total = safeCall(() => playerRef.current.getDuration(), duration);
      const targetPosition = syncedPosition(session);
      const iframeIsStillLoading = (state === -1 || state === 3 || state === 5) && current < 0.2 && targetPosition > 0.8;

      if (Number.isFinite(current) && !iframeIsStillLoading) {
        setLocalPosition(current);
      } else {
        setLocalPosition(targetPosition);
      }

      if (Number.isFinite(total) && total > 0) setDuration(total);
    }, 500);

    return () => window.clearInterval(timer);
  }, [audioUnlocked, duration, isHost, localPosition, session]);

  useEffect(() => {
    if (!isHost || !session?.id || !session.videoId || !audioReady) return;

    const heartbeat = window.setInterval(() => {
      const current = safeCall(() => playerRef.current?.getCurrentTime(), localPosition);
      const total = safeCall(() => playerRef.current?.getDuration(), duration);
      const state = safeCall(() => playerRef.current?.getPlayerState(), null);
      const playing = state === 1 || (state !== 2 && localPlaying);

      socket.emit('session:update', {
        sessionId: session.id,
        hostToken,
        state: {
          videoId: session.videoId,
          duration: Number.isFinite(total) && total > 0 ? total : duration,
          position: Number.isFinite(current) ? current : localPosition,
          playing
        }
      });
    }, HOST_HEARTBEAT_MS);

    return () => window.clearInterval(heartbeat);
  }, [audioReady, duration, hostToken, isHost, localPlaying, localPosition, session?.id, session?.videoId]);

  useEffect(() => {
    if (!session) return;

    const targetPosition = syncedPosition(session);
    setLocalPlaying(session.playing);
    setLocalPosition(targetPosition);
    setDuration(session.duration || 0);

    if (!playerRef.current || !audioReady || !session.videoId) return;

    if (!isHost && !audioUnlocked) {
      lastVideoRef.current = '';
      return;
    }

    const videoChanged = session.videoId !== lastVideoRef.current;

    syncLockRef.current = true;
    if (videoChanged) {
      playerRef.current.loadVideoById({ videoId: session.videoId, startSeconds: targetPosition });
      playerRef.current.setVolume?.(volume);
      lastVideoRef.current = session.videoId;
    } else if (session.videoId) {
      const current = safeCall(() => playerRef.current.getCurrentTime(), 0);
      const drift = targetPosition - current;

      if (Math.abs(drift) > HARD_DRIFT_SECONDS) {
        playerRef.current.seekTo(targetPosition, true);
      } else if (!isHost && session.playing && Math.abs(drift) > SOFT_DRIFT_SECONDS) {
        playerRef.current.setPlaybackRate?.(drift > 0 ? 1.05 : 0.95);
        window.setTimeout(() => playerRef.current?.setPlaybackRate?.(1), 700);
      } else {
        playerRef.current.setPlaybackRate?.(1);
      }
    }

    if (session.videoId) {
      if (session.playing) playerRef.current.playVideo();
      else playerRef.current.pauseVideo();
    }

    window.setTimeout(() => {
      syncLockRef.current = false;
    }, 250);
  }, [audioReady, audioUnlocked, isHost, session]);

  function emitState(next) {
    if (!isHost || !session) return;
    const now = Date.now();
    if (now - lastSentRef.current < 120 && !next.force) return;
    lastSentRef.current = now;

    socket.emit('session:update', {
      sessionId: session.id,
      hostToken,
      state: {
        videoId: session.videoId,
        duration,
        position: localPosition,
        playing: localPlaying,
        ...next
      }
    });
  }

  function loadUrl(event) {
    event.preventDefault();
    const videoId = extractYoutubeId(url);
    if (!videoId) return;

    setUrl('');
    setDuration(0);
    setLocalPosition(0);
    setLocalPlaying(true);
    lastVideoRef.current = videoId;
    playerRef.current?.loadVideoById({ videoId, startSeconds: 0 });
    playerRef.current?.setVolume?.(volume);
    playerRef.current?.playVideo();
    emitState({ videoId, duration: 0, position: 0, playing: true, force: true });
  }

  function togglePlayback() {
    const playing = !localPlaying;
    setLocalPlaying(playing);
    if (playing) playerRef.current?.playVideo();
    else playerRef.current?.pauseVideo();
    emitState({ playing, position: localPosition, force: true });
  }

  function seek(value) {
    const position = Number(value);
    setLocalPosition(position);
    playerRef.current?.seekTo(position, true);
    emitState({ position, force: true });
  }

  function joinAudio() {
    if (!playerRef.current || !session.videoId) return;
    const targetPosition = syncedPosition(session);
    playerRef.current.setVolume?.(volume);

    if (session.videoId !== lastVideoRef.current) {
      playerRef.current.loadVideoById({ videoId: session.videoId, startSeconds: targetPosition });
      playerRef.current.setVolume?.(volume);
      lastVideoRef.current = session.videoId;
    } else {
      playerRef.current.seekTo(targetPosition, true);
    }

    if (session.playing) playerRef.current.playVideo();
    setAudioUnlocked(true);
    setLocalPlaying(session.playing);
    setLocalPosition(targetPosition);
  }

  function changeVolume(value) {
    const nextVolume = Math.max(0, Math.min(100, Number(value)));
    setVolume(nextVolume);
    localStorage.setItem(VOLUME_KEY, String(nextVolume));
    playerRef.current?.setVolume?.(nextVolume);
  }

  const handleReady = useCallback((player) => {
    playerRef.current = player;
    player.setVolume?.(readStoredVolume());
    setAudioReady(true);
  }, []);

  return (
    <Shell>
      <main className="room">
        <header className="topbar">
          <div className="session-pill">
            <Radio size={18} />
            <span>{session.id}</span>
          </div>
          <div className="presence"><Users size={17} /> {presence}/2</div>
        </header>

        <YoutubeAudioPlayer onReady={handleReady} />

        <section className={`transport ${!isHost ? 'transport-passive' : ''}`} aria-label="Playback controls">
          {isHost ? (
            <button
              className="round-button"
              onClick={togglePlayback}
              disabled={!session.videoId || !audioReady}
              aria-label={localPlaying ? 'Pause' : 'Play'}
            >
              {localPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
            </button>
          ) : needsAudioJoin ? (
            <button className="primary join-audio" onClick={joinAudio} disabled={!audioReady}>
              <Play size={19} fill="currentColor" />
              Join audio
            </button>
          ) : (
            <div className="listen-state" aria-hidden="true">
              {localPlaying ? <Radio size={24} /> : <Pause size={24} />}
            </div>
          )}

          <input
            className="scrubber"
            type="range"
            min="0"
            max={Math.max(duration, 1)}
            step="0.1"
            value={Math.min(localPosition, Math.max(duration, 1))}
            onChange={(event) => isHost && seek(event.target.value)}
            disabled={!isHost || !session.videoId}
            aria-label="Playback position"
          />

          <div className="time-row">
            <span>{formatTime(localPosition)}</span>
            <span>{duration ? formatTime(duration) : '--:--'}</span>
          </div>

          <label className="volume-control">
            <Volume2 size={18} />
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={volume}
              onChange={(event) => changeVolume(event.target.value)}
              aria-label="Volume"
            />
            <span>{volume}</span>
          </label>
        </section>

        {isHost ? (
          <section className="host-panel">
            <form onSubmit={loadUrl} className="url-form">
              <LinkIcon size={18} />
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="Paste YouTube URL"
                spellCheck="false"
              />
              <button className="compact" type="submit">Load</button>
            </form>

            <div className="actions">
              <button className="secondary" onClick={() => navigator.clipboard.writeText(inviteUrl)}>
                <Copy size={17} />
                Copy invite
              </button>
              <button className="secondary icon-only" onClick={() => seek(0)} disabled={!session.videoId} aria-label="Restart">
                <RotateCcw size={17} />
              </button>
            </div>
          </section>
        ) : (
          null
        )}
      </main>
    </Shell>
  );
}

function YoutubeAudioPlayer({ onReady }) {
  const mountRef = useRef(null);

  useEffect(() => {
    let player;

    function createPlayer() {
      player = new window.YT.Player(mountRef.current, {
        width: '1',
        height: '1',
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0
        },
        events: {
          onReady: (event) => onReady(event.target)
        }
      });
    }

    if (window.YT?.Player) {
      createPlayer();
    } else {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
      window.onYouTubeIframeAPIReady = createPlayer;
    }

    return () => {
      player?.destroy?.();
    };
  }, [onReady]);

  return <div className="audio-engine" ref={mountRef} aria-hidden="true" />;
}

function Shell({ children }) {
  return <div className="app-shell">{children}</div>;
}

function Loader({ label }) {
  return (
    <div className="loader">
      <Loader2 className="spin" size={28} />
      <span>{label}</span>
    </div>
  );
}

function parseRoute() {
  const match = window.location.pathname.match(/^\/s\/([A-Z0-9]{6})/i);
  return { sessionId: match?.[1]?.toUpperCase() || null };
}

function hostTokenKey(sessionId) {
  return `music-guessing-host:${sessionId}`;
}

function readStoredVolume() {
  const stored = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(stored) ? Math.max(0, Math.min(100, stored)) : 100;
}

function extractYoutubeId(value) {
  try {
    const url = new URL(value.trim());
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1).split('/')[0];
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const embedMatch = url.pathname.match(/\/(?:embed|shorts|live)\/([^/?]+)/);
    return embedMatch?.[1] || '';
  } catch {
    return /^[a-zA-Z0-9_-]{11}$/.test(value.trim()) ? value.trim() : '';
  }
}

function syncedPosition(state) {
  if (!state?.videoId) return 0;
  const elapsed = state.playing ? (Date.now() - state.updatedAt) / 1000 : 0;
  return Math.max(0, Math.min(state.duration || Number.POSITIVE_INFINITY, state.position + elapsed));
}

function formatTime(value) {
  if (!Number.isFinite(value)) return '--:--';
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function safeCall(callback, fallback) {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

createRoot(document.getElementById('root')).render(<App />);

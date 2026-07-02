import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Slider from '@radix-ui/react-slider';
import { io } from 'socket.io-client';
import { ArrowLeft, Link as LinkIcon, ListMusic, Loader2, Pause, Play, Radio, Search, Users, Volume2 } from 'lucide-react';
import './styles.css';
import logoUrl from '../logo.png';

const socket = io();
const DURATION_SYNC_MS = 3000;
const HARD_DRIFT_SECONDS = 0.55;
const SOFT_DRIFT_SECONDS = 0.16;
const PLAYER_LOAD_GRACE_MS = 3500;
const VOLUME_KEY = 'music-guessing-volume-v2';
const YOUTUBE_QUALITY = 'highres';

function App() {
  const [route, setRoute] = useState(() => parseRoute());
  const [session, setSession] = useState(null);
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
      setStatus('idle');
      return;
    }

    setStatus('joining');
    socket.emit('session:join', { sessionId: route.sessionId }, (response) => {
      if (!response?.ok) {
        setStatus('missing');
        return;
      }

      setSession(response.state);
      setStatus('ready');
    });

    const handleState = (state) => setSession(state);
    const handlePresence = ({ count }) => setPresence(count);
    const leaveSession = () => {
      socket.emit('session:leave', { sessionId: route.sessionId });
    };

    socket.on('session:state', handleState);
    socket.on('session:presence', handlePresence);
    window.addEventListener('pagehide', leaveSession);

    return () => {
      leaveSession();
      socket.off('session:state', handleState);
      socket.off('session:presence', handlePresence);
      window.removeEventListener('pagehide', leaveSession);
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
    window.history.pushState(null, '', `/s/${nextSession.id}`);
    setRoute({ sessionId: nextSession.id });
  }

  function goHome() {
    window.history.pushState(null, '', '/');
    setRoute({ sessionId: null });
  }

  function joinSession(code) {
    const sessionId = normalizeRoomCode(code);
    if (!sessionId) return;

    window.history.pushState(null, '', `/s/${sessionId}`);
    setRoute({ sessionId });
  }

  if (!route.sessionId) {
    return <StartScreen onStart={startSession} onJoin={joinSession} busy={status === 'creating'} />;
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
          <button className="primary" onClick={startSession}>Create room</button>
        </section>
      </Shell>
    );
  }

  return (
    <SessionRoom
      session={session}
      presence={presence}
      onHome={goHome}
    />
  );
}

function StartScreen({ onStart, onJoin, busy }) {
  const [roomCode, setRoomCode] = useState('');

  function submitJoin(event) {
    event.preventDefault();
    onJoin(roomCode);
  }

  return (
    <Shell>
      <main className="start-grid">
        <section>
          <h1>Music Guesser</h1>
          <img className="home-logo" src={logoUrl} alt="" />
        </section>
        <div className="home-actions">
          <button className="primary start-button" onClick={onStart} disabled={busy}>
            {busy ? <Loader2 className="spin" size={20} /> : <Radio size={20} />}
            Create room
          </button>

          <form className="join-panel" onSubmit={submitJoin}>
            <input
              value={roomCode}
              onChange={(event) => setRoomCode(event.target.value)}
              placeholder="Room code"
              spellCheck="false"
              autoCapitalize="none"
            />
            <button className="compact" type="submit">Join</button>
          </form>
        </div>
      </main>
    </Shell>
  );
}

function SessionRoom({ session, presence, onHome }) {
  const [url, setUrl] = useState('');
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localPosition, setLocalPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioReady, setAudioReady] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [volume, setVolume] = useState(() => readStoredVolume());
  const playerRef = useRef(null);
  const syncLockRef = useRef(false);
  const lastSentRef = useRef(0);
  const lastDurationSentRef = useRef(0);
  const lastVideoRef = useRef('');
  const lastVideoLoadAtRef = useRef(0);
  const sessionRef = useRef(session);
  const localPositionRef = useRef(localPosition);
  const durationRef = useRef(duration);
  const audioUnlockedRef = useRef(audioUnlocked);

  const needsAudioJoin = session.videoId && !audioUnlocked;
  const hasKnownDuration = duration > 0;
  const scrubberMax = hasKnownDuration ? duration : 100;
  const scrubberValue = hasKnownDuration ? Math.min(localPosition, duration) : 0;

  useEffect(() => {
    sessionRef.current = session;
    localPositionRef.current = localPosition;
    durationRef.current = duration;
    audioUnlockedRef.current = audioUnlocked;
  });

  useEffect(() => {
    if (!playerRef.current || !audioReady) return;
    applyPlayerAudioSettings(playerRef.current, volume);
  }, [audioReady, volume]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!session?.videoId) {
        setLocalPosition(0);
        setDuration(0);
        setLocalPlaying(false);
        return;
      }

      if (!audioUnlocked) {
        setLocalPosition(syncedPosition(session));
        if (session.duration) setDuration(session.duration);
        return;
      }

      if (!playerRef.current || syncLockRef.current) return;

      const state = safeCall(() => playerRef.current.getPlayerState(), null);
      const current = safeCall(() => playerRef.current.getCurrentTime(), localPosition);
      const total = safeCall(() => playerRef.current.getDuration(), duration);
      const targetPosition = syncedPosition(session);
      const iframeIsStillCatchingUp = isPlayerTimeUnstable({
        state,
        current,
        targetPosition,
        lastLoadAt: lastVideoLoadAtRef.current
      });

      if (Number.isFinite(current) && !iframeIsStillCatchingUp) {
        setLocalPosition(current);
      } else {
        setLocalPosition(targetPosition);
      }

      if (Number.isFinite(total) && total > 0) setDuration(total);
    }, 500);

    return () => window.clearInterval(timer);
  }, [audioUnlocked, duration, localPosition, session]);

  useEffect(() => {
    if (!session?.id || !session.videoId || !audioReady || !audioUnlocked) return;

    const durationSync = window.setInterval(() => {
      const total = safeCall(() => playerRef.current?.getDuration(), duration);
      if (!Number.isFinite(total) || total <= 0 || Math.abs(total - lastDurationSentRef.current) < 0.5) return;

      lastDurationSentRef.current = total;

      socket.emit('session:update', {
        sessionId: session.id,
        state: {
          duration: total
        }
      });
    }, DURATION_SYNC_MS);

    return () => window.clearInterval(durationSync);
  }, [audioReady, audioUnlocked, duration, session?.id, session?.videoId]);

  useEffect(() => {
    if (!session) return;

    const targetPosition = syncedPosition(session);
    setLocalPlaying(session.playing);
    setLocalPosition(targetPosition);
    setDuration(session.duration || 0);

    if (!playerRef.current || !audioReady || !session.videoId) return;

    if (!audioUnlocked) {
      lastVideoRef.current = '';
      return;
    }

    const videoChanged = session.videoId !== lastVideoRef.current;

    syncLockRef.current = true;
    if (videoChanged) {
      lastVideoLoadAtRef.current = Date.now();
      playerRef.current.loadVideoById({
        videoId: session.videoId,
        startSeconds: targetPosition,
        suggestedQuality: YOUTUBE_QUALITY
      });
      applyPlayerAudioSettings(playerRef.current, volume);
      lastVideoRef.current = session.videoId;
    } else if (session.videoId) {
      const current = safeCall(() => playerRef.current.getCurrentTime(), 0);
      const drift = targetPosition - current;

      if (Math.abs(drift) > HARD_DRIFT_SECONDS) {
        playerRef.current.seekTo(targetPosition, true);
      } else if (session.playing && Math.abs(drift) > SOFT_DRIFT_SECONDS) {
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
    }, videoChanged ? 900 : 250);
  }, [audioReady, audioUnlocked, session]);

  function emitState(next) {
    if (!session) return;
    const now = Date.now();
    if (now - lastSentRef.current < 120 && !next.force) return;
    lastSentRef.current = now;

    socket.emit('session:update', {
      sessionId: session.id,
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

    startVideo(videoId);
  }

  function startVideo(videoId) {
    setUrl('');
    setDuration(0);
    setLocalPosition(0);
    setLocalPlaying(true);
    setAudioUnlocked(true);
    lastVideoRef.current = videoId;
    lastVideoLoadAtRef.current = Date.now();
    playerRef.current?.loadVideoById({ videoId, startSeconds: 0, suggestedQuality: YOUTUBE_QUALITY });
    applyPlayerAudioSettings(playerRef.current, volume);
    playerRef.current?.playVideo();
    emitState({ videoId, duration: 0, position: 0, playing: true, force: true });
  }

  function togglePlayback() {
    const playing = !localPlaying;
    const position = getCurrentPlayerPosition(playerRef.current, localPosition);
    setLocalPlaying(playing);
    setLocalPosition(position);
    if (playing && session.videoId) setAudioUnlocked(true);
    if (playing) playerRef.current?.playVideo();
    else playerRef.current?.pauseVideo();
    emitState({ playing, position, force: true });
  }

  function seek(value) {
    const position = Number(value);
    setLocalPosition(position);
    playerRef.current?.seekTo(position, true);
    emitState({ position, playing: localPlaying, force: true });
  }

  function joinAudio() {
    if (!playerRef.current || !session.videoId) return;
    const targetPosition = syncedPosition(session);
    applyPlayerAudioSettings(playerRef.current, volume);

    if (session.videoId !== lastVideoRef.current) {
      lastVideoLoadAtRef.current = Date.now();
      playerRef.current.loadVideoById({
        videoId: session.videoId,
        startSeconds: targetPosition,
        suggestedQuality: YOUTUBE_QUALITY
      });
      applyPlayerAudioSettings(playerRef.current, volume);
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
    applyPlayerAudioSettings(playerRef.current, nextVolume);
  }

  const handleReady = useCallback((player) => {
    playerRef.current = player;
    applyPlayerAudioSettings(player, readStoredVolume());
    setAudioReady(true);
  }, []);

  const handlePlayerStateChange = useCallback((event) => {
    if (event.data !== window.YT?.PlayerState?.ENDED) return;

    const currentSession = sessionRef.current;
    if (!currentSession?.id || !currentSession.videoId || !audioUnlockedRef.current) return;

    const player = event.target || playerRef.current;
    const total = safeCall(() => player?.getDuration(), durationRef.current || currentSession.duration);
    const fallbackPosition = getCurrentPlayerPosition(player, localPositionRef.current);
    const endPosition = Number.isFinite(total) && total > 0 ? total : fallbackPosition;
    const syncedDuration = Number.isFinite(total) && total > 0 ? total : durationRef.current;

    setLocalPlaying(false);
    setLocalPosition(endPosition);
    if (syncedDuration) setDuration(syncedDuration);

    socket.emit('session:update', {
      sessionId: currentSession.id,
      state: {
        videoId: currentSession.videoId,
        duration: syncedDuration,
        position: endPosition,
        playing: false
      }
    });
  }, []);

  return (
    <Shell>
      <main className="room">
        <header className="topbar">
          <button className="logo-link" onClick={onHome} aria-label="Home">
            <img src={logoUrl} alt="" />
            <span>Music Guesser</span>
          </button>
          <div className="room-status">
            <div className="room-code">{session.id}</div>
            <div className="presence"><Users size={17} /> {presence}</div>
          </div>
        </header>

        <YoutubeAudioPlayer onReady={handleReady} onStateChange={handlePlayerStateChange} />

        <section className="transport" aria-label="Playback controls">
          <div className="playback-main">
            {needsAudioJoin ? (
              <button className="round-button join-audio" onClick={joinAudio} disabled={!audioReady} aria-label="Join">
                Join
              </button>
            ) : (
              <button
                className="round-button"
                onClick={togglePlayback}
                disabled={!session.videoId || !audioReady}
                aria-label={localPlaying ? 'Pause' : 'Play'}
              >
                {localPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
              </button>
            )}

            <input
              className="scrubber"
              type="range"
              min="0"
              max={scrubberMax}
              step="0.1"
              value={scrubberValue}
              onChange={(event) => seek(event.target.value)}
              disabled={!session.videoId || !hasKnownDuration}
              aria-label="Playback position"
            />

            <div className="time-row">
              <span>{formatTime(localPosition)}</span>
              <span>{duration ? formatTime(duration) : '--:--'}</span>
            </div>
          </div>

          <div className="volume-control" tabIndex="0" aria-label="Volume control">
            <Slider.Root
              className="volume-slider"
              orientation="vertical"
              min={0}
              max={100}
              step={1}
              value={[volume]}
              onValueChange={([nextVolume]) => changeVolume(nextVolume)}
              aria-label="Volume"
            >
              <Slider.Track className="volume-slider-track">
                <Slider.Range className="volume-slider-range" />
              </Slider.Track>
              <Slider.Thumb className="volume-slider-thumb" />
            </Slider.Root>
            <Volume2 size={18} />
          </div>
        </section>

        <section className="peer-panel">
          <form onSubmit={loadUrl} className="url-form">
            <LinkIcon size={18} />
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="Paste YouTube URL"
              spellCheck="false"
            />
            <button className="compact icon-submit" type="submit" aria-label="Load video">
              <Play size={17} fill="currentColor" />
            </button>
          </form>

        </section>

        <YoutubeSearchPanel onSelectVideo={startVideo} />
      </main>
    </Shell>
  );
}

function YoutubeSearchPanel({ onSelectVideo }) {
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('video');
  const [videos, setVideos] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [playlist, setPlaylist] = useState(null);
  const [pages, setPages] = useState({ video: 1, playlist: 1 });
  const [hasMore, setHasMore] = useState({ video: false, playlist: false });
  const [loadingMore, setLoadingMore] = useState('');

  async function searchYoutube(event) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;

    const playlistId = extractYoutubePlaylistId(trimmed);
    if (playlistId) {
      await openPlaylist(playlistId);
      return;
    }

    setStatus('searching');
    setError('');
    setPlaylist(null);
    setSearchedQuery(trimmed);

    try {
      const result = await fetchSearchPage(trimmed, 1, 'all');
      const nextVideos = result.videos || [];
      const nextPlaylists = result.playlists || [];
      setVideos(nextVideos);
      setPlaylists(nextPlaylists);
      setPages({ video: 1, playlist: 1 });
      setHasMore(result.hasMore || { video: false, playlist: false });
      setActiveTab(nextPlaylists.length > 0 && /playlist/i.test(trimmed) ? 'playlist' : nextVideos.length > 0 ? 'video' : 'playlist');
      setStatus('ready');
    } catch (searchError) {
      setError(searchError.message || 'Search failed');
      setStatus('error');
    }
  }

  async function fetchSearchPage(searchQuery, page, kind) {
    const params = new URLSearchParams({
      q: searchQuery,
      page: String(page)
    });
    if (kind !== 'all') params.set('kind', kind);

    const response = await fetch(`/api/youtube/search?${params.toString()}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Search failed');
    return result;
  }

  async function loadMoreResults(kind) {
    if (playlist || loadingMore || status !== 'ready' || !searchedQuery || !hasMore[kind]) return;

    const nextPage = pages[kind] + 1;
    setLoadingMore(kind);

    try {
      const result = await fetchSearchPage(searchedQuery, nextPage, kind);
      if (kind === 'video') {
        setVideos((current) => mergeUniqueResults(current, result.videos || []));
      } else {
        setPlaylists((current) => mergeUniqueResults(current, result.playlists || []));
      }
      setPages((current) => ({ ...current, [kind]: nextPage }));
      setHasMore((current) => ({ ...current, [kind]: Boolean(result.hasMore?.[kind]) }));
    } catch (loadError) {
      setError(loadError.message || 'Search failed');
    } finally {
      setLoadingMore('');
    }
  }

  function handleResultScroll(event) {
    const element = event.currentTarget;
    const nearBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
    if (nearBottom) loadMoreResults(activeTab);
  }

  async function openPlaylist(playlistId) {
    setStatus('playlist');
    setError('');

    try {
      const response = await fetch(`/api/youtube/playlist?id=${encodeURIComponent(playlistId)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Playlist failed');

      setPlaylist(result);
      setActiveTab('video');
      setStatus('ready');
    } catch (playlistError) {
      setError(playlistError.message || 'Playlist failed');
      setStatus('error');
    }
  }

  function selectVideo(videoId) {
    onSelectVideo(videoId);
  }

  const activeVideos = playlist?.videos || videos;
  const activeResultCount = activeTab === 'video' ? activeVideos.length : playlists.length;
  const hasResults = playlist ? activeVideos.length > 0 : activeVideos.length > 0 || playlists.length > 0;

  return (
    <section className="search-panel" aria-label="YouTube search">
      <form className="search-form" onSubmit={searchYoutube}>
        <Search size={18} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search YouTube"
          spellCheck="false"
        />
        <button className="compact search-submit" type="submit" disabled={status === 'searching' || status === 'playlist'} aria-label="Search">
          {status === 'searching' || status === 'playlist' ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
        </button>
      </form>

      {playlist ? (
        <div className="search-heading">
          <button className="back-button" onClick={() => setPlaylist(null)} type="button" aria-label="Back to search results">
            <ArrowLeft size={17} />
          </button>
          <span>{playlist.title}</span>
        </div>
      ) : (
        <div className="search-tabs" role="tablist" aria-label="Search result type">
          <button
            className={activeTab === 'video' ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={activeTab === 'video'}
            onClick={() => setActiveTab('video')}
          >
            Videos
          </button>
          <button
            className={activeTab === 'playlist' ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={activeTab === 'playlist'}
            onClick={() => setActiveTab('playlist')}
          >
            Playlists
          </button>
        </div>
      )}

      {error ? <p className="search-error">{error}</p> : null}

      {!error && status === 'ready' && hasResults && activeResultCount === 0 ? (
        <p className="search-empty">No {activeTab === 'video' ? 'videos' : 'playlists'}</p>
      ) : null}

      {!error && !hasResults && status === 'ready' ? (
        <p className="search-empty">No results</p>
      ) : null}

      {activeTab === 'video' && activeVideos.length > 0 ? (
        <div className="result-list" onScroll={handleResultScroll}>
          {activeVideos.map((video) => (
            <button
              key={video.id}
              className="result-item"
              type="button"
              onClick={() => selectVideo(video.id)}
            >
              <span className="result-title">{video.title}</span>
              <span className="result-meta">{[video.author, video.timestamp].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          {!playlist && loadingMore === 'video' ? <div className="load-more-row"><Loader2 className="spin" size={16} /></div> : null}
        </div>
      ) : null}

      {!playlist && activeTab === 'playlist' && playlists.length > 0 ? (
        <div className="playlist-list" onScroll={handleResultScroll}>
          {playlists.map((item) => (
            <button
              key={item.id}
              className="playlist-item"
              type="button"
              onClick={() => openPlaylist(item.id)}
            >
              <ListMusic size={18} />
              <span>
                <strong>{item.title}</strong>
                <small>{[item.author, item.videoCount ? `${item.videoCount} videos` : ''].filter(Boolean).join(' · ')}</small>
              </span>
            </button>
          ))}
          {loadingMore === 'playlist' ? <div className="load-more-row"><Loader2 className="spin" size={16} /></div> : null}
        </div>
      ) : null}
    </section>
  );
}

function YoutubeAudioPlayer({ onReady, onStateChange }) {
  const mountRef = useRef(null);
  const onReadyRef = useRef(onReady);
  const onStateChangeRef = useRef(onStateChange);

  useEffect(() => {
    onReadyRef.current = onReady;
    onStateChangeRef.current = onStateChange;
  });

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
          onReady: (event) => onReadyRef.current?.(event.target),
          onStateChange: (event) => onStateChangeRef.current?.(event)
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
  }, []);

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
  const match = window.location.pathname.match(/^\/s\/([a-z]{6})/i);
  return { sessionId: normalizeRoomCode(match?.[1] || '') || null };
}

function normalizeRoomCode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return normalized.length === 6 ? normalized : '';
}

function readStoredVolume() {
  const raw = localStorage.getItem(VOLUME_KEY);
  if (raw === null) return 100;

  const stored = Number(raw);
  return Number.isFinite(stored) ? Math.max(0, Math.min(100, stored)) : 100;
}

function applyPlayerAudioSettings(player, volume) {
  if (!player) return;
  player.unMute?.();
  player.setVolume?.(Math.max(0, Math.min(100, Number(volume))));
  player.setPlaybackQuality?.(YOUTUBE_QUALITY);
  window.setTimeout(() => player.setPlaybackQuality?.(YOUTUBE_QUALITY), 400);
  window.setTimeout(() => player.setPlaybackQuality?.(YOUTUBE_QUALITY), 1200);
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

function extractYoutubePlaylistId(value) {
  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);
    return url.searchParams.get('list') || '';
  } catch {
    return /^[a-zA-Z0-9_-]{10,}$/.test(trimmed) ? trimmed : '';
  }
}

function mergeUniqueResults(current, next) {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
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

function getCurrentPlayerPosition(player, fallback) {
  const current = safeCall(() => player?.getCurrentTime(), fallback);
  return Number.isFinite(current) ? current : fallback;
}

function isPlayerTimeUnstable({ state, current, targetPosition, lastLoadAt }) {
  if (!Number.isFinite(current)) return true;
  if (targetPosition <= 0.8 || current >= 0.2) return false;

  const recentlyLoaded = Date.now() - lastLoadAt < PLAYER_LOAD_GRACE_MS;
  const loadingState = state === -1 || state === 3 || state === 5;
  return recentlyLoaded || loadingState;
}

createRoot(document.getElementById('root')).render(<App />);

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { USE_LOCAL } from '../lib/mode';
import { subscribeLocal } from '../lib/localStore';
import {
  getRoom, getParticipants, getMessages, sendMessage, syncPlayback,
  setVideoSource, leaveRoom, deleteRoom, reactivateParticipant,
  type Room, type Participant, type RoomMessage,
} from '../services/rooms';
import { posterUrl } from '../services/tmdb';
import { hasRoomAccess, grantRoomAccess, revokeRoomAccess } from '../utils/hash';
import { createP2PHost, createP2PViewer, codecHint } from '../lib/p2pMedia';
import { extractYouTubeId } from '../utils/youtube';
import YouTubePlayer from '../components/YouTubePlayer';

export default function WatchRoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { user, displayName, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [sidebarTab, setSidebarTab] = useState<'chat' | 'participants' | 'source'>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
  const [localFileName, setLocalFileName] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [isFs, setIsFs] = useState(false);
  const [fitMode, setFitMode] = useState<'fit' | 'fill'>('fit');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  /** P2P-received temporary blob URL (viewers). Movie is never stored in DB. */
  const [remoteFileUrl, setRemoteFileUrl] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<string>('');
  const [viewerStreamCount, setViewerStreamCount] = useState(0);
  const [bufferProgress, setBufferProgress] = useState({ received: 0, total: 0 });
  const [codecInfo, setCodecInfo] = useState('');
  const [youtubeInput, setYoutubeInput] = useState('');
  const [youtubeSubmitting, setYoutubeSubmitting] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controlsTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hostFileRef = useRef<File | null>(null);
  const p2pHostRef = useRef<ReturnType<typeof createP2PHost> | null>(null);
  const p2pViewerRef = useRef<ReturnType<typeof createP2PViewer> | null>(null);
  const isHost = !!(user && room && room.host_id === user.id);

  // Wait for auth session restore before deciding to redirect (fixes refresh → home/auth)
  useEffect(() => {
    if (authLoading) return;
    if (!roomId) return;
    if (!user) {
      navigate('/auth', { state: { from: `/room/${roomId}` } });
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const r = await getRoom(roomId);
        if (cancelled) return;
        if (!r) {
          setError('Room not found or expired.');
          setLoading(false);
          return;
        }

        let parts = await getParticipants(roomId);
        if (cancelled) return;

        const isRoomHost = r.host_id === user.id;
        const wasEverMember = parts.some((p) => p.user_id === user.id) || isRoomHost;
        const isMember = parts.some((p) => p.user_id === user.id && p.is_active);
        const granted = hasRoomAccess(roomId);

        // Host always allowed; others need prior join grant or active membership
        if (!isRoomHost && !granted && !isMember && !wasEverMember) {
          if (!granted) {
            setError('Password required. Join the room with the code and password first.');
            setLoading(false);
            setTimeout(() => navigate(`/join/${roomId}`), 2000);
            return;
          }
        }

        grantRoomAccess(roomId);
        await reactivateParticipant(roomId, user.id, displayName, isRoomHost);
        parts = await getParticipants(roomId);
        if (cancelled) return;

        setRoom(r);
        setIsPlaying(r.is_playing);
        setCurrentTime(r.current_time);
        if (r.local_file_name) setLocalFileName(r.local_file_name);

        const msgs = await getMessages(roomId);
        if (cancelled) return;
        setParticipants(parts);
        setMessages(msgs);
        setLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        console.error('Room load failed', err);
        setError(err instanceof Error ? err.message : 'Failed to load room');
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [roomId, user, authLoading, navigate, displayName]);

  // Realtime subscriptions (local BroadcastChannel OR Supabase)
  useEffect(() => {
    if (!roomId) return;
    const id = roomId.toUpperCase();

    const applyRoomUpdate = (updated: Room | null) => {
      if (!updated) {
        setError('Room was deleted by the host.');
        setRoom(null);
        return;
      }
      setRoom(updated);
      // Always mirror shared playback state (needed for YouTube embed sync too)
      setIsPlaying(updated.is_playing);
      setCurrentTime(updated.current_time);
      if (user && videoRef.current) {
        const vid = videoRef.current;
        const drift = Math.abs(vid.currentTime - updated.current_time);
        if (drift > 1.5) {
          vid.currentTime = updated.current_time;
        }
        if (updated.is_playing && vid.paused) {
          vid.play().catch(() => setSourceError('Your browser blocked playback. Press Play to resume.'));
        } else if (!updated.is_playing && !vid.paused) {
          vid.pause();
        }
      }
    };

    if (USE_LOCAL) {
      const unsub = subscribeLocal((ev) => {
        if (ev.type === 'room' && ev.roomId === id) {
          applyRoomUpdate(ev.room);
        } else if (ev.type === 'participants' && ev.roomId === id) {
          getParticipants(roomId).then(setParticipants);
        } else if (ev.type === 'messages' && ev.roomId === id) {
          if (ev.message) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === ev.message!.id)) return prev;
              return [...prev, ev.message!];
            });
          } else {
            getMessages(roomId).then(setMessages);
          }
        } else if (ev.type === 'store') {
          getParticipants(roomId).then(setParticipants);
          getMessages(roomId).then(setMessages);
          const r = ev.data.rooms.find((x) => x.id === id) ?? null;
          if (r) applyRoomUpdate(r);
        }
      });
      return unsub;
    }

    const channel = supabase
      .channel(`room:${roomId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${id}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            applyRoomUpdate(null);
            return;
          }
          applyRoomUpdate(payload.new as Room);
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'room_participants', filter: `room_id=eq.${id}` },
        async () => {
          const parts = await getParticipants(roomId);
          setParticipants(parts);
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${id}` },
        (payload) => {
          const msg = payload.new as RoomMessage;
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, user]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Host: local blob URL. Viewer: P2P chunked blob URL. Never stored in DB.
  // YouTube: only the link/id is stored in room metadata (not the video bytes).
  const videoSrc = localFileUrl || remoteFileUrl || null;
  const youtubeId =
    room?.video_src_type === 'youtube' && room.video_src
      ? extractYouTubeId(room.video_src) || (room.video_src.length === 11 ? room.video_src : null)
      : null;
  const hasVideo = !!videoSrc || !!youtubeId;

  const handleSetYouTube = async () => {
    if (!isHost || !user || !roomId) return;
    const id = extractYouTubeId(youtubeInput);
    if (!id) {
      setSourceError('Invalid YouTube link. Paste a full URL or 11-character video id.');
      return;
    }
    setYoutubeSubmitting(true);
    setSourceError(null);
    // Clear local/P2P source when switching to YouTube
    hostFileRef.current = null;
    if (localFileUrl) {
      URL.revokeObjectURL(localFileUrl);
      setLocalFileUrl(null);
    }
    setLocalFileName('');
    p2pHostRef.current?.stop();
    p2pHostRef.current = null;

    const { error: err } = await setVideoSource(roomId, user.id, 'youtube', id);
    setYoutubeSubmitting(false);
    if (err) {
      setSourceError(err);
      return;
    }
    setYoutubeInput('');
  };

  useEffect(() => {
    return () => {
      if (localFileUrl) URL.revokeObjectURL(localFileUrl);
    };
  }, [localFileUrl]);

  // Host: seed file over P2P data channels (dynamic chunks, backpressure)
  useEffect(() => {
    if (!isHost || !user || !roomId || !hostFileRef.current) {
      p2pHostRef.current?.stop();
      p2pHostRef.current = null;
      setViewerStreamCount(0);
      return;
    }

    const file = hostFileRef.current;
    let cancelled = false;

    const startHost = async () => {
      p2pHostRef.current?.stop();
      const host = createP2PHost({
        roomId,
        hostId: user.id,
        file,
        onViewerCount: setViewerStreamCount,
      });
      p2pHostRef.current = host;
      setCodecInfo(host.codecHint);
      await host.start();
      if (cancelled) {
        host.stop();
        return;
      }
      participants
        .filter((p) => p.is_active && p.user_id !== user.id)
        .forEach((p) => host.offerTo(p.user_id));
    };

    void startHost();
    return () => {
      cancelled = true;
      p2pHostRef.current?.stop();
      p2pHostRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, user?.id, roomId, localFileUrl]);

  // New participants → host offers P2P media
  useEffect(() => {
    if (!isHost || !user || !p2pHostRef.current || !hostFileRef.current) return;
    participants
      .filter((p) => p.is_active && p.user_id !== user.id)
      .forEach((p) => p2pHostRef.current?.offerTo(p.user_id));
  }, [participants, isHost, user, localFileUrl]);

  // Viewer: receive chunked file via P2P, play from temporary memory blob
  useEffect(() => {
    if (isHost || !user || !roomId || !room) {
      p2pViewerRef.current?.stop();
      p2pViewerRef.current = null;
      setRemoteFileUrl(null);
      setStreamStatus('');
      setBufferProgress({ received: 0, total: 0 });
      return;
    }

    const hostSharingLocal = room.video_src_type === 'local' && !!room.local_file_name;
    if (!hostSharingLocal) {
      p2pViewerRef.current?.stop();
      p2pViewerRef.current = null;
      setRemoteFileUrl(null);
      setStreamStatus('');
      return;
    }

    let cancelled = false;
    const startViewer = async () => {
      p2pViewerRef.current?.stop();
      const viewer = createP2PViewer({
        roomId,
        viewerId: user.id,
        hostId: room.host_id,
        onPlayableUrl: (url, info) => {
          if (cancelled) return;
          setRemoteFileUrl(url);
          if (url) {
            setSourceError(null);
            if (info?.fileName) setLocalFileName(info.fileName);
            if (info?.mime) setCodecInfo(codecHint(info.mime, info.fileName));
          }
        },
        onStatus: (status) => {
          if (cancelled) return;
          setStreamStatus(status);
          if (status === 'host-left' || status === 'failed') {
            setRemoteFileUrl(null);
          }
        },
        onBufferProgress: (received, total) => {
          if (!cancelled) setBufferProgress({ received, total });
        },
      });
      p2pViewerRef.current = viewer;
      await viewer.start();
    };

    void startViewer();
    return () => {
      cancelled = true;
      p2pViewerRef.current?.stop();
      p2pViewerRef.current = null;
    };
  }, [isHost, user?.id, roomId, room?.video_src_type, room?.local_file_name, room?.host_id]);

  // Smart buffer feedback: pause/resume P2P download based on player buffer
  useEffect(() => {
    if (isHost || !videoRef.current || !p2pViewerRef.current) return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.buffered.length) return;
      try {
        const end = v.buffered.end(v.buffered.length - 1);
        const ahead = end - v.currentTime;
        p2pViewerRef.current?.reportPlayerBuffer(ahead);
      } catch {
        /* */
      }
    }, 2000);
    return () => clearInterval(id);
  }, [isHost, remoteFileUrl]);

  useEffect(() => {
    return () => {
      p2pHostRef.current?.stop();
      p2pViewerRef.current?.stop();
      hostFileRef.current = null;
    };
  }, []);

  // Host: push playback state periodically
  const pushSync = useCallback(() => {
    if (!isHost || !user || !roomId || !videoRef.current) return;
    const vid = videoRef.current;
    syncPlayback(roomId, user.id, !vid.paused, vid.currentTime);
  }, [isHost, user, roomId]);

  useEffect(() => {
    if (!isHost) return;
    const interval = setInterval(pushSync, 3000);
    return () => clearInterval(interval);
  }, [isHost, pushSync]);

  const handlePlayPause = async () => {
    const vid = videoRef.current;
    if (!vid) return;
    setSourceError(null);
    if (vid.paused) {
      try {
        await vid.play();
      } catch {
        setSourceError('Playback could not start. Try pressing Play again or choose a supported video file.');
        return;
      }
      setIsPlaying(true);
    } else {
      vid.pause();
      setIsPlaying(false);
    }
    if (user && roomId) {
      await syncPlayback(roomId, user.id, !vid.paused, vid.currentTime);
    }
  };

  const handleSeek = (t: number) => {
    if (!videoRef.current) return;
    const safeTime = Math.max(0, duration > 0 && Number.isFinite(duration) ? Math.min(t, duration) : t);
    videoRef.current.currentTime = safeTime;
    setCurrentTime(safeTime);
  };

  const commitSeek = () => {
    const vid = videoRef.current;
    if (vid && user && roomId) {
      void syncPlayback(roomId, user.id, !vid.paused, vid.currentTime);
    }
  };

  const handleLocalFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Keep File in memory for P2P chunk seeding — never uploaded to DB/storage
    hostFileRef.current = file;
    if (localFileUrl) URL.revokeObjectURL(localFileUrl);
    const url = URL.createObjectURL(file);
    setLocalFileUrl(url);
    setLocalFileName(file.name);
    setSourceError(null);
    setCodecInfo(codecHint(file.type, file.name));

    // Host notifies others (filename only — bytes stay on host until live P2P transfer)
    if (isHost && user && roomId) {
      void setVideoSource(roomId, user.id, 'local', undefined, file.name);
    }
    e.target.value = '';
  };

  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        // Prefer landscape on mobile when available (Chrome Android, etc.)
        const req =
          el.requestFullscreen?.bind(el) ||
          (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(el);
        if (req) await req();
        try {
          const orient = screen.orientation as ScreenOrientation & {
            lock?: (orientation: OrientationLockType | string) => Promise<void>;
          };
          if (typeof orient?.lock === 'function') {
            await orient.lock('landscape');
          }
        } catch {
          // Orientation lock is optional; many desktop browsers reject it.
        }
        setIsFs(true);
      } else {
        await document.exitFullscreen();
        try {
          screen.orientation?.unlock?.();
        } catch {
          /* ignore */
        }
        setIsFs(false);
      }
    } catch {
      /* fullscreen blocked or unsupported */
    }
  };

  useEffect(() => {
    const onFs = () => {
      const active = !!document.fullscreenElement;
      setIsFs(active);
      if (!active) {
        try {
          screen.orientation?.unlock?.();
        } catch {
          /* ignore */
        }
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !user || !roomId) return;
    const text = chatInput.trim();
    setChatInput('');
    const roomName = participants.find((participant) => participant.user_id === user.id)?.name || displayName;
    await sendMessage(roomId, user.id, roomName, text);
  };

  const handleLeave = async () => {
    if (!user || !roomId) return;
    if (isHost) {
      if (confirm('You are the host. Leaving will delete the room for everyone. Continue?')) {
        await deleteRoom(roomId, user.id);
        revokeRoomAccess(roomId);
        navigate('/');
      }
    } else {
      await leaveRoom(roomId, user.id);
      revokeRoomAccess(roomId);
      navigate('/');
    }
  };

  const copyCode = () => {
    if (room) {
      navigator.clipboard.writeText(room.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  /** Share link: opens join page with room code prefilled. Password NOT in URL. */
  const shareLink = room
    ? `${window.location.origin}/join/${room.id}`
    : '';

  const copyShareLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      // fallback
      window.prompt('Copy this link:', shareLink);
    }
  };

  const nativeShare = async () => {
    if (!shareLink || !navigator.share) {
      copyShareLink();
      return;
    }
    try {
      await navigator.share({
        title: 'CinemaClub room',
        text: `Join my watch room ${room?.id}. Password alag se host se lo.`,
        url: shareLink,
      });
    } catch {
      /* user cancelled */
    }
  };

  const formatTime = (s: number) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-obsidian flex items-center justify-center text-muted">
        Loading room…
      </div>
    );
  }

  if (error || !room) {
    return (
      <div className="min-h-screen bg-obsidian flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-crimson text-center">{error || 'Room not found'}</p>
        <Link to="/" className="btn-ghost">Go home</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-obsidian flex flex-col">
      {/* Top bar — compact & responsive */}
      <header className="min-h-12 sm:h-14 border-b border-border flex items-center justify-between gap-2 px-2 sm:px-4 py-2 flex-shrink-0 glass">
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 flex-1">
          <Link to="/" className="text-muted hover:text-text text-xs sm:text-sm flex-shrink-0 px-1">
            ← Exit
          </Link>
          <div className="h-4 w-px bg-border flex-shrink-0 hidden xs:block" />
          <span className="font-mono text-xs sm:text-sm text-violet-light tracking-wider flex-shrink-0">
            {room.id}
          </span>
          <button
            onClick={copyCode}
            className="text-[11px] sm:text-xs text-muted hover:text-text flex-shrink-0 hidden sm:inline"
            title="Copy room code"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button
            onClick={copyShareLink}
            className="text-[11px] sm:text-xs text-violet-light hover:text-text flex-shrink-0"
            title="Copy share link"
          >
            {linkCopied ? 'Link ✓' : 'Share'}
          </button>
          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
            <button
              onClick={nativeShare}
              className="text-[11px] sm:text-xs text-muted hover:text-text hidden md:inline"
              title="Share via apps"
            >
              Share…
            </button>
          )}
          {room.movie_title && (
            <span className="text-xs text-subtle truncate hidden lg:inline max-w-[160px]">
              · {room.movie_title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          <span className="text-[11px] text-muted hidden md:inline">
            {participants.length} watching
          </span>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="btn-ghost text-[11px] sm:text-xs py-1.5 px-2 sm:px-3"
            title="Toggle chat / source"
          >
            {sidebarOpen ? 'Hide' : 'Chat'}
          </button>
          <button onClick={handleLeave} className="btn-danger text-[11px] sm:text-xs py-1.5 px-2 sm:px-3">
            {isHost ? 'Delete' : 'Leave'}
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Player area */}
        <div className="flex-1 flex flex-col min-w-0">
          <div
            ref={containerRef}
            className="relative flex-1 bg-black flex items-center justify-center group"
            onMouseMove={() => {
              setShowControls(true);
              clearTimeout(controlsTimeout.current);
              controlsTimeout.current = setTimeout(() => setShowControls(false), 3000);
            }}
          >
            {youtubeId ? (
              <YouTubePlayer
                videoId={youtubeId}
                externalTime={!isHost ? currentTime : undefined}
                externalPlaying={!isHost ? isPlaying : undefined}
                onReady={(d) => {
                  setDuration(d);
                  setSourceError(null);
                }}
                onPlayState={(playing, time) => {
                  setIsPlaying(playing);
                  setCurrentTime(time);
                  if (user && roomId) {
                    void syncPlayback(roomId, user.id, playing, time);
                  }
                }}
                className="w-full h-full max-h-[calc(100vh-3.5rem)]"
              />
            ) : hasVideo ? (
              <video
                ref={videoRef}
                src={videoSrc || undefined}
                className={`w-full h-full max-h-[calc(100vh-3.5rem)] ${
                  fitMode === 'fill' ? 'object-cover' : 'object-contain'
                }`}
                onTimeUpdate={() => {
                  if (videoRef.current) {
                    setCurrentTime(videoRef.current.currentTime);
                  }
                }}
                onLoadedMetadata={() => {
                  if (videoRef.current) {
                    setDuration(Number.isFinite(videoRef.current.duration) ? videoRef.current.duration : 0);
                    setSourceError(null);
                  }
                }}
                onError={() => {
                  if (localFileUrl) {
                    setSourceError('This video format or codec is not supported by your browser. Try an MP4 (H.264/AAC) file.');
                  }
                }}
                playsInline
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onClick={handlePlayPause}
                onDoubleClick={toggleFullscreen}
              />
            ) : (
              <div className="text-center p-8">
                {room.movie_poster && (
                  <img
                    src={posterUrl(room.movie_poster, 'w342')}
                    alt=""
                    className="w-40 mx-auto rounded-lg mb-4 opacity-60"
                  />
                )}
                <p className="text-muted text-sm">
                  {isHost
                    ? 'Set a video source in the sidebar to start watching'
                    : room.video_src_type === 'local' && room.local_file_name
                      ? `Receiving from host… (${room.local_file_name})`
                      : 'Waiting for host to set a video source…'}
                </p>
                {!isHost && room.video_src_type === 'local' && room.local_file_name && (
                  <div className="mt-4 max-w-sm mx-auto">
                    <p className="text-xs text-subtle mb-2">
                      P2P chunked transfer — movie is not stored on the server.
                    </p>
                    {streamStatus && (
                      <p className="text-xs text-amber mb-2">Status: {streamStatus}</p>
                    )}
                    {bufferProgress.total > 0 && (
                      <div className="mt-2">
                        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full bg-violet transition-all"
                            style={{
                              width: `${Math.min(100, (100 * bufferProgress.received) / bufferProgress.total)}%`,
                            }}
                          />
                        </div>
                        <p className="text-[10px] text-subtle mt-1">
                          {(bufferProgress.received / (1024 * 1024)).toFixed(1)} /{' '}
                          {(bufferProgress.total / (1024 * 1024)).toFixed(1)} MB
                        </p>
                      </div>
                    )}
                    {(streamStatus === 'failed' || streamStatus === 'error') && (
                      <p className="text-xs text-crimson mt-2">
                        P2P transfer failed (network/NAT). Try the same Wi‑Fi or a TURN-enabled deploy.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {sourceError && hasVideo && (
              <div role="alert" className="absolute top-4 left-4 right-4 z-20 rounded-lg border border-red-400/40 bg-black/85 px-3 py-2 text-sm text-red-100">
                {sourceError}
              </div>
            )}

            {/* Controls overlay — native <video> only; YouTube uses its own controls */}
            {hasVideo && !youtubeId && (
              <div
                className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-4 transition-opacity ${
                  showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  value={currentTime}
                  onChange={(e) => handleSeek(Number(e.target.value))}
                  onPointerUp={commitSeek}
                  onTouchEnd={commitSeek}
                  onKeyUp={commitSeek}
                  className="w-full h-1 accent-violet mb-3 cursor-pointer"
                />
                <div className="flex items-center gap-3">
                  <button onClick={handlePlayPause} className="text-white hover:text-violet-light">
                    {isPlaying ? (
                      <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
                    ) : (
                      <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    )}
                  </button>
                  <span className="text-xs text-white/80 font-mono">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setFitMode((m) => (m === 'fit' ? 'fill' : 'fit'))}
                    className="text-[11px] text-white/80 hover:text-white border border-white/20 rounded px-2 py-0.5"
                    title={fitMode === 'fit' ? 'Fill screen (crop)' : 'Fit frame (letterbox)'}
                  >
                    {fitMode === 'fit' ? 'Fit' : 'Fill'}
                  </button>
                  <button
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.muted = !muted;
                        setMuted(!muted);
                      }
                    }}
                    className="text-white/80 hover:text-white text-xs"
                  >
                    {muted ? 'Unmute' : 'Mute'}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={volume}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setVolume(v);
                      if (videoRef.current) {
                        videoRef.current.volume = v;
                        setMuted(v === 0);
                      }
                    }}
                    className="w-20 h-1 accent-violet"
                  />
                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    className="text-white hover:text-violet-light p-1"
                    title={isFs ? 'Exit fullscreen' : 'Fullscreen'}
                  >
                    {isFs ? (
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                      </svg>
                    ) : (
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar — full-screen overlay on mobile, side panel on desktop */}
        {sidebarOpen && (
          <aside className="w-full sm:w-80 border-l border-border flex flex-col bg-surface flex-shrink-0 fixed sm:relative inset-0 sm:inset-auto z-30 sm:z-0 h-full max-h-[100dvh]">
            <div className="flex border-b border-border flex-shrink-0">
              {(['chat', 'participants', 'source'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setSidebarTab(tab)}
                  className={`flex-1 py-3 text-xs font-medium capitalize transition-colors ${
                    sidebarTab === tab
                      ? 'text-violet-light border-b-2 border-violet'
                      : 'text-muted hover:text-text'
                  }`}
                >
                  {tab === 'participants' ? `People (${participants.length})` : tab}
                </button>
              ))}
              <button
                onClick={() => setSidebarOpen(false)}
                className="sm:hidden px-3 text-muted hover:text-text text-lg leading-none"
                aria-label="Close sidebar"
              >
                ✕
              </button>
            </div>

            {sidebarTab === 'chat' && (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`text-sm ${m.type === 'system' ? 'text-subtle italic text-center text-xs' : ''}`}
                    >
                      {m.type === 'message' && (
                        <span className="text-violet-light font-medium text-xs mr-1.5">
                          {m.participant_name}
                        </span>
                      )}
                      <span className={m.type === 'message' ? 'text-text' : ''}>{m.text}</span>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <form onSubmit={handleSendChat} className="p-3 border-t border-border flex gap-2">
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Say something…"
                    className="input-field text-sm py-2 flex-1"
                    maxLength={500}
                  />
                  <button type="submit" className="btn-primary text-xs px-3 py-2">
                    Send
                  </button>
                </form>
              </div>
            )}

            {sidebarTab === 'participants' && (
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {participants.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border"
                  >
                    <div className="w-2 h-2 rounded-full bg-emerald" />
                    <span className="text-sm text-text flex-1 truncate">{p.name}</span>
                    {p.is_host && (
                      <span className="text-[10px] mono-label text-amber">HOST</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {sidebarTab === 'source' && (
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {isHost ? (
                  <>
                    <div>
                      <p className="text-xs mono-label text-muted mb-2">YouTube link</p>
                      <div className="flex gap-2">
                        <input
                          type="url"
                          value={youtubeInput}
                          onChange={(e) => setYoutubeInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSetYouTube();
                          }}
                          placeholder="https://youtube.com/watch?v=…"
                          className="input-field flex-1 text-sm"
                        />
                        <button
                          type="button"
                          disabled={youtubeSubmitting || !youtubeInput.trim()}
                          onClick={() => void handleSetYouTube()}
                          className="btn-primary text-sm px-3 shrink-0"
                        >
                          {youtubeSubmitting ? '…' : 'Set'}
                        </button>
                      </div>
                      <p className="text-[10px] text-subtle mt-2 leading-relaxed">
                        Paste a YouTube URL or video id. Only the link is saved in the room —
                        the video stays on YouTube. Everyone watches in sync via embed.
                      </p>
                      {youtubeId && (
                        <p className="text-[10px] text-emerald mt-2">
                          Active YouTube: {youtubeId}
                        </p>
                      )}
                    </div>

                    <div className="border-t border-border pt-4">
                      <p className="text-xs mono-label text-muted mb-2">Local video file</p>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="btn-primary w-full text-sm py-3"
                      >
                        {localFileName ? `Loaded: ${localFileName}` : 'Choose video file'}
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*,.mkv,.avi,.mp4,.webm,.mov,.m4v"
                        onChange={handleLocalFile}
                        className="hidden"
                      />
                      <p className="text-[10px] text-subtle mt-2 leading-relaxed">
                        File stays on your device and is sent to viewers in dynamic P2P chunks
                        (WebRTC data channel). Nothing is uploaded or stored in the database.
                        After refresh, choose the file again. Prefer MP4 (H.264/AAC); VP9/AV1
                        need less bandwidth but weaker Safari support.
                      </p>
                      {codecInfo && (
                        <p className="text-[10px] text-subtle mt-1">{codecInfo}</p>
                      )}
                      {localFileName && (
                        <p className="text-[10px] text-emerald mt-2">
                          P2P viewers connected: {viewerStreamCount}
                        </p>
                      )}
                    </div>

                    {sourceError && (
                      <p className="text-xs text-crimson">{sourceError}</p>
                    )}
                  </>
                ) : (
                  <div className="text-center mt-8">
                    <p className="text-muted text-sm">Only the host can change the video source.</p>
                    {room.video_src_type === 'youtube' && room.video_src && (
                      <div className="mt-4 glass rounded-xl p-4 text-left">
                        <p className="text-xs text-subtle mb-1">Host is playing YouTube</p>
                        <p className="text-sm font-medium text-text break-all">{room.video_src}</p>
                        <p className="text-[10px] text-subtle mt-2">
                          Video is streamed from YouTube — not stored on our servers.
                        </p>
                      </div>
                    )}
                    {room.video_src_type === 'local' && room.local_file_name && (
                      <div className="mt-4 glass rounded-xl p-4">
                        <p className="text-xs text-subtle mb-1">Host is sharing live</p>
                        <p className="text-sm font-medium text-text">{room.local_file_name}</p>
                        <p className="text-[10px] text-subtle mt-2">
                          Status: {streamStatus || (remoteFileUrl ? 'playing' : 'waiting…')}
                        </p>
                        {bufferProgress.total > 0 && (
                          <p className="text-[10px] text-subtle mt-1">
                            Buffered {(bufferProgress.received / (1024 * 1024)).toFixed(1)} /{' '}
                            {(bufferProgress.total / (1024 * 1024)).toFixed(1)} MB
                          </p>
                        )}
                        <p className="text-[10px] text-subtle mt-1">
                          Movie is not stored on the server — only in memory while you watch.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

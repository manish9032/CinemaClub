import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getRoom,
  setVideoSource,
  syncPlayback,
  deleteRoom,
  leaveRoom,
  reactivateParticipant,
  getParticipants,
  getMessages,
  sendMessage,
  type Room,
  type Participant,
  type RoomMessage,
} from '../services/rooms';
import { useAuth } from '../contexts/AuthContext';
import VideoPlayer from '../components/VideoPlayer';
import YouTubePlayer from '../components/YouTubePlayer';
import { WebRTCStream, createRoomSignaling } from '../lib/webrtcStream';
import { extractYouTubeId } from '../utils/youtube';
import { USE_LOCAL } from '../lib/mode';
import { supabase } from '../lib/supabase';
import { subscribeLocal } from '../lib/localStore';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How long a new chat message stays on the video before it fades away. */
const OVERLAY_VISIBLE_MS = 15000;

/** Stable avatar colour per name (like YouTube live chat). */
const avatarColor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 42%)`;
};

export default function WatchRoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user, displayName } = useAuth();
  const userId = user?.id;

  const [room, setRoom] = useState<Room | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [status, setStatus] = useState('Loading room...');
  const [error, setError] = useState<string | null>(null);
  const [localFileName, setLocalFileName] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [youtubeId, setYoutubeId] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [externalTime, setExternalTime] = useState<number | undefined>();
  const [externalPlaying, setExternalPlaying] = useState<boolean | undefined>();

  // Viewer-side live stream state
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [viewerMuted, setViewerMuted] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [isFs, setIsFs] = useState(false);

  // Members + chat
  const [panel, setPanel] = useState<'members' | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(0);
  const [chatOpen, setChatOpen] = useState(true);
  const [inputFocused, setInputFocused] = useState(false);
  const [, setTick] = useState(0);
  const [showInvite, setShowInvite] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const hostRef = useRef<WebRTCStream | null>(null);
  const playerWrapRef = useRef<HTMLDivElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteShellRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const chatOpenRef = useRef(true);
  const arrivedAtRef = useRef<Map<string, number>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const youtubeInputRef = useRef<HTMLInputElement>(null);

  // ---------------------------------------------------------------------
  // Load room
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!roomId || !user) return;
    let cancelled = false;

    (async () => {
      const r = await getRoom(roomId);
      if (cancelled) return;
      if (!r) {
        setError('Room not found');
        return;
      }
      setRoom(r);
      setIsHost(r.host_id === user.id);
      setLocalFileName(r.local_file_name);
      setExternalTime(r.current_time);
      setExternalPlaying(r.is_playing);

      if (r.video_src_type === 'youtube' && r.video_src) {
        setYoutubeId(extractYouTubeId(r.video_src) || r.video_src);
        setStatus('YouTube ready');
      } else if (r.video_src_type === 'stream' && r.video_src) {
        setPlayUrl(r.video_src);
        setStatus('Stream ready');
      } else {
        setStatus(r.host_id === user.id ? 'Select a local video file to share' : 'Waiting for host to share a file...');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId, user]);

  // ---------------------------------------------------------------------
  // Realtime: playback sync (YouTube / direct stream) + video source changes
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!roomId || !user) return;

    if (USE_LOCAL) {
      const unsub = subscribeLocal((payload: any) => {
        if (payload?.type === 'playback' && payload?.roomId?.toUpperCase() === roomId.toUpperCase()) {
          setExternalTime(payload.current_time);
          setExternalPlaying(payload.is_playing);
        }
      });
      return unsub;
    }

    const channel = supabase.channel(`room-sync:${roomId.toUpperCase()}`);
    channel
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rooms',
          filter: `id=eq.${roomId.toUpperCase()}`,
        },
        (payload) => {
          const r = payload.new as Room;
          setExternalTime(r.current_time);
          setExternalPlaying(r.is_playing);
          // Let viewers follow when the host changes the video source.
          setRoom((prev) =>
            prev
              ? {
                  ...prev,
                  video_src_type: r.video_src_type,
                  video_src: r.video_src,
                  local_file_name: r.local_file_name,
                }
              : prev
          );
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [roomId, user]);

  // Viewer follows the host's choice (YouTube <-> local live stream)
  useEffect(() => {
    if (isHost || !room) return;
    if (room.video_src_type === 'youtube' && room.video_src) {
      setYoutubeId(extractYouTubeId(room.video_src) || room.video_src);
      setRemoteStream(null);
      setPlayUrl(null);
    } else if (room.video_src_type === 'local') {
      setYoutubeId(null);
      setLocalFileName(room.local_file_name);
    }
  }, [isHost, room?.video_src_type, room?.video_src, room?.local_file_name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------
  // Members + chat
  // ---------------------------------------------------------------------
  useEffect(() => {
    chatOpenRef.current = chatOpen;
    if (chatOpen) setUnread(0);
  }, [chatOpen]);

  // Initial load
  useEffect(() => {
    if (!roomId || !userId) return;
    let cancelled = false;

    (async () => {
      await reactivateParticipant(roomId, userId, displayName);
      const [p, m] = await Promise.all([getParticipants(roomId), getMessages(roomId)]);
      if (cancelled) return;
      setParticipants(p);
      setMessages(m);
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId, userId, displayName]);

  // Realtime: new messages + members joining / leaving
  useEffect(() => {
    if (!roomId || !userId) return;
    const id = roomId.toUpperCase();

    const addMessage = (msg: RoomMessage) => {
      if (!arrivedAtRef.current.has(msg.id)) arrivedAtRef.current.set(msg.id, Date.now());
      setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev, msg]));
      if (!chatOpenRef.current && msg.type === 'message' && msg.participant_id !== userId) {
        setUnread((n) => n + 1);
      }
    };
    const refreshParticipants = () => {
      void getParticipants(roomId).then(setParticipants);
    };

    if (USE_LOCAL) {
      return subscribeLocal((ev: any) => {
        if (ev?.roomId?.toUpperCase?.() !== id) return;
        if (ev.type === 'participants') refreshParticipants();
        else if (ev.type === 'messages') {
          if (ev.message) addMessage(ev.message as RoomMessage);
          else void getMessages(roomId).then(setMessages);
        }
      });
    }

    const channel = supabase.channel(`room-chat:${id}`);
    channel
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${id}` },
        (payload) => addMessage(payload.new as RoomMessage)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'room_participants', filter: `room_id=eq.${id}` },
        () => refreshParticipants()
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [roomId, userId]);

  // Re-render every second so overlay messages can fade out
  useEffect(() => {
    if (!chatOpen) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [chatOpen]);

  // The host sees the invite card right after creating the room
  useEffect(() => {
    if (isHost) setShowInvite(true);
  }, [isHost]);

  const myName = participants.find((p) => p.user_id === userId)?.name || displayName;

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text || !roomId || !userId || sending) return;
    setSending(true);
    setChatError(null);
    setChatInput('');
    const msg = await sendMessage(roomId, userId, myName, text);
    if (msg) {
      if (!arrivedAtRef.current.has(msg.id)) arrivedAtRef.current.set(msg.id, Date.now());
      setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev, msg]));
    } else {
      setChatInput(text);
      setChatError('Message could not be sent. Please try again.');
    }
    setSending(false);
  };

  const roomCode = roomId?.toUpperCase() ?? '';
  const shareLink = `${window.location.origin}${window.location.pathname}#/join/${roomCode}`;
  const inviteText = `Join my CinemaClub watch party!\nRoom code: ${roomCode}\n${shareLink}`;

  const copyText = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    }
  };

  const flashCopied = (what: 'code' | 'link') => {
    setCopied(what);
    setTimeout(() => setCopied(null), 1800);
  };

  const copyCode = async () => {
    if (await copyText(roomCode)) flashCopied('code');
  };

  const copyLink = async () => {
    if (await copyText(shareLink)) flashCopied('link');
  };

  const shareInvite = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'CinemaClub — Watch Together',
          text: `Join my CinemaClub watch party! Room code: ${roomCode}`,
          url: shareLink,
        });
      } catch {
        /* share sheet closed */
      }
      return;
    }
    await copyLink();
  };

  const handleLeave = async () => {
    if (roomId && userId) {
      try {
        await leaveRoom(roomId, userId);
      } catch {
        /* ignore – still leave the page */
      }
    }
    navigate('/');
  };

  // ---------------------------------------------------------------------
  // Cleanup on leave
  // ---------------------------------------------------------------------
  useEffect(() => {
    return () => {
      hostRef.current?.stop();
      hostRef.current = null;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------------
  // HOST: share a local file as a live stream
  // ---------------------------------------------------------------------

  /** Wait until React has mounted the host's <video> with the new blob URL. */
  const waitForHostVideo = useCallback(async (url: string): Promise<HTMLVideoElement | null> => {
    for (let i = 0; i < 100; i++) {
      const video = playerWrapRef.current?.querySelector('video') ?? null;
      if (video && video.src === url) return video;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }, []);

  const startHostLive = useCallback(
    async (file: File) => {
      if (!roomId || !userId || !isHost) return;

      setError(null);
      setYoutubeId(null);
      setStatus('Preparing video...');
      setLocalFileName(file.name);

      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(file);
      blobUrlRef.current = url;
      setPlayUrl(url);

      const video = await waitForHostVideo(url);
      if (!video) {
        setError('Video player failed to initialise. Please choose the file again.');
        return;
      }

      try {
        if (hostRef.current) {
          await hostRef.current.replaceSource(video);
        } else {
          const host = new WebRTCStream('host', userId, createRoomSignaling(roomId, userId), {
            onViewerCount: setViewerCount,
            onError: (err) => console.error('[host stream]', err),
          });
          hostRef.current = host;
          await host.startAsHost(video);
        }
      } catch (e) {
        setError(errorMessage(e));
        return;
      }

      setStatus(`Sharing "${file.name}" live — press play, viewers follow instantly`);
      await setVideoSource(roomId, userId, 'local', undefined, file.name);
      setRoom((prev) =>
        prev ? { ...prev, video_src_type: 'local', local_file_name: file.name } : prev
      );
    },
    [roomId, userId, isHost, waitForHostVideo]
  );

  // ---------------------------------------------------------------------
  // VIEWER: receive the live MediaStream
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (isHost || !roomId || !userId || room?.video_src_type !== 'local') return;

    setStatus('Waiting for host...');
    const viewer = new WebRTCStream('viewer', userId, createRoomSignaling(roomId, userId), {
      onRemoteStream: (stream) => {
        setRemoteStream(stream);
        setStatus('Live — synced with host');
      },
      onRemoteStreamEnded: () => {
        setRemoteStream(null);
        setStatus('Host stopped sharing');
      },
      onConnectionState: (state) => {
        if (state === 'connected') setStatus('Live — synced with host');
        else if (state === 'connecting') setStatus('Connecting to host...');
        else if (state === 'failed' || state === 'disconnected') {
          setStatus('Connection lost — reconnecting...');
        }
      },
      onError: (err) => console.error('[viewer stream]', err),
    });

    void viewer.startAsViewer();

    return () => {
      viewer.stop();
      setRemoteStream(null);
    };
  }, [isHost, roomId, userId, room?.video_src_type]);

  /** Play the live stream; if the browser blocks autoplay, mute and retry. */
  const playRemote = useCallback(async (video: HTMLVideoElement) => {
    setAutoplayBlocked(false);
    try {
      await video.play();
    } catch (err) {
      const blocked = err instanceof DOMException && err.name === 'NotAllowedError';
      if (blocked) video.muted = true; // autoplay policy: muted playback is always allowed
      try {
        await video.play();
      } catch (retryErr) {
        console.warn('[viewer] autoplay still blocked', retryErr);
        setAutoplayBlocked(true);
      }
    }
    setViewerMuted(video.muted);
  }, []);

  // Bind the MediaStream directly to <video>.srcObject (no blob / playUrl)
  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video) return;

    if (!remoteStream) {
      video.srcObject = null;
      return;
    }

    setHasFrame(false);
    video.srcObject = remoteStream;
    void playRemote(video);

    return () => {
      video.srcObject = null;
    };
  }, [remoteStream, playRemote]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleViewerMute = () => {
    const video = remoteVideoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setViewerMuted(video.muted);
    if (video.paused) void playRemote(video);
  };

  const toggleViewerFullscreen = async () => {
    const el = remoteShellRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) await el.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      /* ignore */
    }
  };

  // ---------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------
  const handleLocalFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    await startHostLive(file);
    input.value = '';
  };

  const handleYouTubeSubmit = async () => {
    if (!isHost || !roomId || !user || !youtubeInputRef.current) return;
    const raw = youtubeInputRef.current.value.trim();
    const id = extractYouTubeId(raw);
    if (!id) {
      setError('Invalid YouTube URL or ID');
      return;
    }
    setError(null);
    hostRef.current?.stop();
    hostRef.current = null;
    setViewerCount(0);
    setYoutubeId(id);
    setPlayUrl(null);
    setStatus('YouTube loaded');
    await setVideoSource(roomId, user.id, 'youtube', id);
    setRoom((prev) => (prev ? { ...prev, video_src_type: 'youtube', video_src: id } : prev));
  };

  const handleDeleteRoom = async () => {
    if (!roomId || !user) return;
    if (!confirm('Delete this room?')) return;
    const { error: delError } = await deleteRoom(roomId, user.id);
    if (delError) {
      alert(delError);
      return;
    }
    navigate('/');
  };

  const onPlayState = useCallback(
    (playing: boolean, time: number) => {
      if (!isHost || !roomId || !user) return;
      void syncPlayback(roomId, user.id, playing, time);
    },
    [isHost, roomId, user]
  );

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  if (!user) {
    return (
      <div className="min-h-screen bg-obsidian pt-24 flex items-center justify-center text-muted">
        Please sign in to join a room.
      </div>
    );
  }

  if (error && !room) {
    return (
      <div className="min-h-screen bg-obsidian pt-24 flex items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  const nowMs = Date.now();
  const visibleMessages = messages
    .filter((m) => m.type === 'message')
    .filter((m) => {
      if (inputFocused) return true;
      const arrived = arrivedAtRef.current.get(m.id);
      return arrived !== undefined && nowMs - arrived < OVERLAY_VISIBLE_MS;
    })
    .slice(inputFocused ? -10 : -6);

  const fadeMask = {
    WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 30%)',
    maskImage: 'linear-gradient(to bottom, transparent, black 30%)',
  };

  /** Live-stream style chat: messages float on the right side of the video. */
  const chatOverlay = chatOpen ? (
    <div className="absolute right-3 top-12 bottom-[84px] w-[min(300px,52%)] z-20 flex flex-col justify-end gap-2 pointer-events-none">
      <div className="flex flex-col justify-end gap-1.5 overflow-hidden" style={fadeMask}>
        {visibleMessages.map((m) => {
          const arrived = arrivedAtRef.current.get(m.id);
          const age = arrived === undefined ? 0 : nowMs - arrived;
          const fading = !inputFocused && age > OVERLAY_VISIBLE_MS - 4000;
          const fromHost = !!room?.host_id && m.participant_id === room.host_id;
          return (
            <div
              key={m.id}
              className="flex items-start gap-1.5 w-fit max-w-full rounded-xl bg-black/50 backdrop-blur-sm px-2 py-1 text-[13px] leading-snug text-white transition-opacity duration-1000"
              style={{ opacity: fading ? 0.35 : 1 }}
            >
              <span
                className="w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
                style={{ backgroundColor: avatarColor(m.participant_name) }}
              >
                {m.participant_name.charAt(0).toUpperCase()}
              </span>
              <p className="min-w-0 break-words">
                <span className={`font-semibold mr-1.5 ${fromHost ? 'text-violet-light' : 'text-white/70'}`}>
                  {m.participant_name}
                </span>
                <span>{m.text}</span>
              </p>
            </div>
          );
        })}
      </div>

      {chatError && (
        <p className="pointer-events-auto text-[11px] text-red-300 bg-black/60 rounded px-2 py-1">{chatError}</p>
      )}

      <div
        className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-black/55 backdrop-blur-sm border border-white/15 pl-3 pr-1 py-1"
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          value={chatInput}
          maxLength={1000}
          onChange={(e) => setChatInput(e.target.value)}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSendChat();
            }
          }}
          placeholder="Say something..."
          className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-white placeholder:text-white/50"
        />
        <button
          type="button"
          onClick={() => void handleSendChat()}
          disabled={sending || !chatInput.trim()}
          aria-label="Send message"
          className="w-7 h-7 shrink-0 rounded-full bg-violet-500 text-white text-xs flex items-center justify-center disabled:opacity-40"
        >
          ➤
        </button>
        <button
          type="button"
          onClick={() => setChatOpen(false)}
          aria-label="Hide chat"
          title="Hide chat"
          className="w-7 h-7 shrink-0 rounded-full text-white/70 hover:text-white text-xs flex items-center justify-center"
        >
          ✕
        </button>
      </div>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setChatOpen(true)}
      title="Show chat"
      aria-label="Show chat"
      className="absolute right-3 bottom-[88px] z-20 w-10 h-10 rounded-full bg-black/60 border border-white/15 text-white flex items-center justify-center"
    >
      💬
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-violet-500 text-white text-[11px] flex items-center justify-center">
          {unread}
        </span>
      )}
    </button>
  );

  const viewingLive = !youtubeId && !isHost && !!remoteStream;
  const viewingFile = !youtubeId && !viewingLive && !!playUrl;
  // YouTube iframe / empty player: draw the overlay on the wrapper itself
  const overlayInWrapper = !viewingLive && !viewingFile;

  return (
    <div className="min-h-screen bg-obsidian pt-20 pb-12 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-text flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Room code:</span>
              <span className="font-mono tracking-widest text-xl text-violet-light bg-violet-500/15 border border-violet-500/30 rounded-lg px-3 py-0.5">
                {roomCode}
              </span>
              <button
                type="button"
                onClick={copyCode}
                className="text-xs font-sans font-normal text-muted hover:text-text"
              >
                {copied === 'code' ? '✓ Copied' : 'Copy'}
              </button>
            </h1>
            <p className="text-sm text-muted">
              {room?.movie_title || 'Watch together'} · {isHost ? 'You are host' : `Host: ${room?.host_name}`}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
            <button
              type="button"
              onClick={() => setPanel(panel === 'members' ? null : 'members')}
              className={`text-sm hover:text-text ${panel === 'members' ? 'text-violet-light' : 'text-muted'}`}
            >
              👥 Members ({participants.length})
            </button>
            <button
              type="button"
              onClick={() => setShowInvite((v) => !v)}
              className={`text-sm hover:text-text ${showInvite ? 'text-violet-light' : 'text-muted'}`}
            >
              🔗 Share
            </button>
            <button onClick={handleLeave} className="text-sm text-muted hover:text-text">
              Leave
            </button>
            {isHost && (
              <button
                onClick={handleDeleteRoom}
                className="text-sm text-red-400 hover:text-red-300"
              >
                Delete Room
              </button>
            )}
          </div>
        </div>

        {showInvite && (
          <div className="glass rounded-xl p-4 mb-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs mono-label text-muted">Invite friends</p>
              <button
                type="button"
                onClick={() => setShowInvite(false)}
                className="text-xs text-muted hover:text-text"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-text mt-2">
              Room code:{' '}
              <span className="font-mono tracking-widest text-violet-light">{roomCode}</span>
            </p>
            <div className="mt-2 flex flex-col sm:flex-row gap-2">
              <input
                readOnly
                value={shareLink}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-text"
              />
              <button type="button" onClick={copyLink} className="btn-primary text-sm">
                {copied === 'link' ? '✓ Copied' : 'Copy link'}
              </button>
              <button type="button" onClick={shareInvite} className="btn-secondary text-sm">
                Share
              </button>
              <a
                href={`https://wa.me/?text=${encodeURIComponent(inviteText)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary text-sm text-center"
              >
                WhatsApp
              </a>
            </div>
            <p className="text-xs text-subtle mt-2">
              Friends open the link, sign in and enter the room password. Share the password separately.
            </p>
          </div>
        )}

        <div className="glass rounded-xl p-3 mb-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-violet-light">{status}</span>
            {isHost && room?.video_src_type === 'local' && (
              <span className="text-muted">{viewerCount} viewer(s)</span>
            )}
          </div>
          {error && <p className="text-red-400 mt-1">{error}</p>}
        </div>

        {isHost && (
          <div className="glass rounded-xl p-4 mb-4 space-y-3">
            <p className="text-xs mono-label text-muted">Share a video</p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn-primary text-sm"
              >
                {localFileName ? `Change file (${localFileName})` : 'Choose local video file'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,.mp4,.webm,.mkv,.mov,.m4v,.avi"
                className="hidden"
                onChange={handleLocalFile}
              />
              <div className="flex-1 flex gap-2">
                <input
                  ref={youtubeInputRef}
                  type="text"
                  placeholder="Or paste YouTube URL / ID"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-text placeholder:text-subtle"
                  onKeyDown={(e) => e.key === 'Enter' && handleYouTubeSubmit()}
                />
                <button type="button" onClick={handleYouTubeSubmit} className="btn-secondary text-sm">
                  Load YT
                </button>
              </div>
            </div>
            <p className="text-xs text-subtle">
              Local files are streamed live, peer-to-peer (never uploaded to a server). Play, pause and seek are
              mirrored on every viewer instantly. Keep this tab open while sharing. Prefer MP4 (H.264) for best
              compatibility.
            </p>
          </div>
        )}

        <div
          ref={playerWrapRef}
          className="aspect-video bg-black/40 rounded-2xl overflow-hidden mb-6 relative"
        >
          {youtubeId ? (
            <YouTubePlayer
              videoId={youtubeId}
              externalTime={isHost ? undefined : externalTime}
              externalPlaying={isHost ? undefined : externalPlaying}
              onPlayState={onPlayState}
              className="w-full h-full"
            />
          ) : !isHost && remoteStream ? (
            <div ref={remoteShellRef} className="relative w-full h-full bg-black">
              {chatOverlay}
              <video
                ref={remoteVideoRef}
                className="w-full h-full object-contain bg-black"
                autoPlay
                playsInline
                onLoadedData={() => setHasFrame(true)}
                onPlaying={() => setHasFrame(true)}
                onVolumeChange={(e) => setViewerMuted(e.currentTarget.muted)}
              />

              {!hasFrame && !autoplayBlocked && (
                <div className="absolute inset-0 flex items-center justify-center text-muted text-sm bg-black/60 pointer-events-none">
                  Waiting for host to press play...
                </div>
              )}

              {autoplayBlocked && (
                <button
                  type="button"
                  onClick={() => remoteVideoRef.current && void playRemote(remoteVideoRef.current)}
                  className="absolute inset-0 flex items-center justify-center bg-black/60"
                >
                  <span className="btn-primary text-sm">▶ Click to start watching</span>
                </button>
              )}

              {viewerMuted && hasFrame && !autoplayBlocked && (
                <button
                  type="button"
                  onClick={toggleViewerMute}
                  className="absolute top-3 left-3 btn-primary text-xs"
                >
                  🔊 Tap to unmute
                </button>
              )}

              <div className="absolute top-3 right-3 text-[11px] text-white/80 bg-black/50 rounded px-2 py-0.5">
                ● LIVE · synced with host
              </div>

              <div className="absolute bottom-3 right-3 flex gap-2">
                <button
                  type="button"
                  onClick={toggleViewerMute}
                  className="text-white/90 hover:text-white text-xs bg-black/50 rounded px-2 py-1"
                >
                  {viewerMuted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  type="button"
                  onClick={toggleViewerFullscreen}
                  className="text-white/90 hover:text-white text-xs bg-black/50 rounded px-2 py-1"
                >
                  {isFs ? 'Exit fullscreen' : 'Fullscreen'}
                </button>
              </div>
            </div>
          ) : playUrl ? (
            <VideoPlayer
              src={playUrl}
              title={localFileName || room?.movie_title || 'Video'}
              isHost={isHost}
              externalTime={isHost ? undefined : externalTime}
              externalPlaying={isHost ? undefined : externalPlaying}
              onPlayState={onPlayState}
              overlay={chatOverlay}
              className="w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted text-sm">
              {isHost
                ? 'Select a local file or paste a YouTube link to start'
                : 'Waiting for host to share a video...'}
            </div>
          )}
          {overlayInWrapper && chatOverlay}
        </div>

        {!youtubeId && room?.video_src_type === 'local' && (
          <div className="text-xs text-subtle space-y-1">
            <p>• Host controls playback — play, pause and seek are mirrored live on every viewer.</p>
            <p>• If the browser blocks sound, the video starts muted — tap “Unmute” once.</p>
            <p>• Quality depends on the host’s upload speed. MP4 (H.264 + AAC) works best.</p>
          </div>
        )}
      </div>

      {panel === 'members' && (
        <div className="fixed top-20 right-0 bottom-0 z-40 w-full sm:w-96 bg-obsidian border-l border-white/10 flex flex-col shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <h2 className="font-display text-lg font-semibold text-text">
              Members ({participants.length})
            </h2>
            <button
              type="button"
              onClick={() => setPanel(null)}
              className="text-sm text-muted hover:text-text"
            >
              ✕ Close
            </button>
          </div>

          <ul className="flex-1 overflow-y-auto p-3 space-y-2">
            {participants.length === 0 && (
              <li className="text-sm text-muted p-2">No one here yet.</li>
            )}
            {[...participants]
              .sort((a, b) => Number(b.is_host) - Number(a.is_host))
              .map((p) => (
                <li key={p.id} className="flex items-center gap-3 glass rounded-lg px-3 py-2">
                  <span className="w-8 h-8 shrink-0 rounded-full bg-violet-500/30 text-violet-light flex items-center justify-center text-sm font-semibold">
                    {p.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="flex-1 text-sm text-text truncate">
                    {p.name}
                    {p.user_id === userId && <span className="text-muted"> (you)</span>}
                  </span>
                  {p.is_host && (
                    <span className="text-[11px] text-violet-light border border-violet-500/40 rounded px-1.5 py-0.5">
                      Host
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

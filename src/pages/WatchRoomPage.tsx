import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getRoom, setVideoSource, syncPlayback, deleteRoom, type Room } from '../services/rooms';
import { useAuth } from '../contexts/AuthContext';
import VideoPlayer from '../components/VideoPlayer';
import YouTubePlayer from '../components/YouTubePlayer';
import { WebRTCStream, createRoomSignaling } from '../lib/webrtcStream';
import { extractYouTubeId } from '../utils/youtube';
import { USE_LOCAL } from '../lib/mode';
import { supabase } from '../lib/supabase';
import { subscribeLocal } from '../lib/localStore';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function WatchRoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
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

  const hostRef = useRef<WebRTCStream | null>(null);
  const playerWrapRef = useRef<HTMLDivElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteShellRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);
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

  return (
    <div className="min-h-screen bg-obsidian pt-20 pb-12 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-text">
              Room {roomId?.toUpperCase()}
            </h1>
            <p className="text-sm text-muted">
              {room?.movie_title || 'Watch together'} · {isHost ? 'You are host' : `Host: ${room?.host_name}`}
            </p>
          </div>

          <div className="flex items-center">
            <button onClick={() => navigate('/')} className="text-sm text-muted hover:text-text">
              Leave
            </button>
            {isHost && (
              <button
                onClick={handleDeleteRoom}
                className="text-sm text-red-400 hover:text-red-300 ml-3"
              >
                Delete Room
              </button>
            )}
          </div>
        </div>

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
              className="w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted text-sm">
              {isHost
                ? 'Select a local file or paste a YouTube link to start'
                : 'Waiting for host to share a video...'}
            </div>
          )}
        </div>

        {!youtubeId && room?.video_src_type === 'local' && (
          <div className="text-xs text-subtle space-y-1">
            <p>• Host controls playback — play, pause and seek are mirrored live on every viewer.</p>
            <p>• If the browser blocks sound, the video starts muted — tap “Unmute” once.</p>
            <p>• Quality depends on the host’s upload speed. MP4 (H.264 + AAC) works best.</p>
          </div>
        )}
      </div>
    </div>
  );
}

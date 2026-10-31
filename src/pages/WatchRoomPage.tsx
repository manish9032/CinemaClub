import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getRoom, setVideoSource, syncPlayback, deleteRoom, type Room } from '../services/rooms';
import { useAuth } from '../contexts/AuthContext';
import VideoPlayer from '../components/VideoPlayer';
import YouTubePlayer from '../components/YouTubePlayer';
import { createP2PHost, createP2PViewer } from '../lib/p2pMedia';
import { extractYouTubeId } from '../utils/youtube';
import { USE_LOCAL } from '../lib/mode';
import { supabase } from '../lib/supabase';
import { subscribeLocal } from '../lib/localStore';

export default function WatchRoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [room, setRoom] = useState<Room | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [status, setStatus] = useState('Loading room...');
  const [error, setError] = useState<string | null>(null);
  const [localFileName, setLocalFileName] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [youtubeId, setYoutubeId] = useState<string | null>(null);
  const [bufferProgress, setBufferProgress] = useState<{ received: number; total: number } | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [externalTime, setExternalTime] = useState<number | undefined>();
  const [externalPlaying, setExternalPlaying] = useState<boolean | undefined>();

  const hostRef = useRef<ReturnType<typeof createP2PHost> | null>(null);
  const viewerRef = useRef<ReturnType<typeof createP2PViewer> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const youtubeInputRef = useRef<HTMLInputElement>(null);

  // Load room
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

  // Realtime playback sync
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
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [roomId, user]);

  // Cleanup P2P
  useEffect(() => {
    return () => {
      hostRef.current?.stop();
      viewerRef.current?.stop();
    };
  }, []);

  const startHostP2P = useCallback(
    async (file: File) => {
      if (!roomId || !user || !isHost) return;
      hostRef.current?.stop();
      setError(null);
      setStatus('Starting P2P share...');
      setLocalFileName(file.name);
      setPlayUrl(URL.createObjectURL(file));

      const host = createP2PHost({
        roomId,
        hostId: user.id,
        file,
        onViewerCount: setViewerCount,
        onProgress: (_id, sent, total) => {
          setBufferProgress({ received: sent, total });
        },
      });
      hostRef.current = host;
      await host.start();
      setStatus(`Sharing "${file.name}"`);

      await setVideoSource(roomId, user.id, 'local', undefined, file.name);
      setRoom((prev) =>
        prev ? { ...prev, video_src_type: 'local', local_file_name: file.name } : prev
      );
    },
    [roomId, user, isHost]
  );

  const startViewerP2P = useCallback(async () => {
    if (!roomId || !user || isHost || !room?.host_id) return;
    viewerRef.current?.stop();
    setError(null);
    setStatus('Requesting video from host...');

    const viewer = createP2PViewer({
      roomId,
      viewerId: user.id,
      hostId: room.host_id,
      onPlayableUrl: (url, info) => {
        setPlayUrl(url);
        if (info?.complete) setStatus(`Playing "${info.fileName}" (complete)`);
        else if (url) setStatus(`Playing "${info?.fileName || 'video'}" (buffering...)`);
        else setStatus('Host stopped sharing');
      },
      onStatus: (s) => {
        if (s === 'connected') setStatus('P2P connected — receiving video...');
        else if (s === 'failed') setStatus('Connection failed — check network');
        else if (s === 'requesting') setStatus('Waiting for host...');
      },
      onBufferProgress: (received, total) => setBufferProgress({ received, total }),
    });
    viewerRef.current = viewer;
    await viewer.start();
  }, [roomId, user, isHost, room?.host_id]);

  useEffect(() => {
    if (isHost || !room || room.video_src_type !== 'local' || !room.host_id) return;
    void startViewerP2P();
  }, [isHost, room, startViewerP2P]);

  const handleLocalFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await startHostP2P(file);
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
    setYoutubeId(id);
    setPlayUrl(null);
    setStatus('YouTube loaded');
    await setVideoSource(roomId, user.id, 'youtube', id);
    setRoom((prev) => (prev ? { ...prev, video_src_type: 'youtube', video_src: id } : prev));
  };

  const handleDeleteRoom = async () => {
    if (!roomId || !user) return;
    if (!confirm('Delete this room?')) return;
    const { error } = await deleteRoom(roomId, user.id);
    if (error) {
      alert(error);
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
          {bufferProgress && bufferProgress.total > 0 && (
            <div className="mt-2 h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all"
                style={{
                  width: `${Math.min(100, (bufferProgress.received / bufferProgress.total) * 100)}%`,
                }}
              />
            </div>
          )}
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
              Local files are streamed peer-to-peer (never uploaded to a server). Prefer MP4 (H.264) for best compatibility.
              YouTube works instantly for everyone.
            </p>
          </div>
        )}

        <div className="aspect-video bg-black/40 rounded-2xl overflow-hidden mb-6 relative">
          {youtubeId ? (
            <YouTubePlayer
              videoId={youtubeId}
              externalTime={isHost ? undefined : externalTime}
              externalPlaying={isHost ? undefined : externalPlaying}
              onPlayState={onPlayState}
              className="w-full h-full"
            />
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
            <p>• Use MP4 with H.264 + AAC for best results. Faststart MP4 starts faster.</p>
            <p>• Large files take time. Playback starts after ~1.5–4 MB is received.</p>
            <p>• Host controls playback. Viewers stay in sync.</p>
          </div>
        )}
      </div>
    </div>
  );
}

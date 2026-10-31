import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
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

'use client';
import { useState, useEffect, useRef } from 'react';
import { useRealtime } from '@/lib/supabase'; // tumhara Supabase hook
import { WebRTCStream } from '@/lib/webrtcStream';

export default function WatchRoomPage({ roomId }: { roomId: string }) {
  const { user, realtime } = useRealtime();
  const [isHost, setIsHost] = useState(false);
  const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<WebRTCStream | null>(null);

  // Host file select
  const handleLocalFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    setLocalFileUrl(url);

    if (videoRef.current) {
      videoRef.current.src = url;
      videoRef.current.load();
    }
  };

  // Start live stream
  const startLiveStream = async () => {
    if (!videoRef.current || !isHost || !realtime) return;

    await videoRef.current.play();
    streamRef.current = new WebRTCStream(
      'host',
      roomId,
      user.id,
      realtime,
      { onConnectionState: (state) => console.log('Host', state) }
    );
    await streamRef.current.startAsHost(videoRef.current);
  };

  // Viewer effect
  useEffect(() => {
    if (isHost || !realtime) return;

    const stream = new WebRTCStream(
      'viewer',
      roomId,
      user.id,
      realtime,
      {
        onRemoteStream: (remoteStream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream;
            videoRef.current.play().catch(console.error);
          }
        },
        onConnectionState: (state) => {
          console.log('Viewer', state);
          // "Receiving from host..." status update kar sakte ho yahan
        },
      }
    );

    stream.startAsViewer();
    streamRef.current = stream;

    const handleMessage = (payload: any) => {
      const { event, payload: data } = payload;
      if (event === 'offer' && data.from !== user.id) stream.handleOffer(data.sdp);
      else if (event === 'answer' && data.from !== user.id) stream.handleAnswer(data.sdp);
      else if (event === 'ice-candidate') stream.handleIceCandidate(data.candidate);
    };

    realtime.on('broadcast', { event: 'offer' }, handleMessage);
    realtime.on('broadcast', { event: 'answer' }, handleMessage);
    realtime.on('broadcast', { event: 'ice-candidate' }, handleMessage);

    return () => stream.stop();
  }, [isHost, roomId, user?.id]);

  // Host controls sync (play/pause/seek)
  useEffect(() => {
    if (!isHost || !realtime) return;

    const handleControl = (data: any) => {
      if (videoRef.current) {
        videoRef.current.currentTime = data.time;
        data.play ? videoRef.current.play() : videoRef.current.pause();
      }
    };

    realtime.on('broadcast', { event: 'control' }, handleControl);

    return () => realtime.off('broadcast', { event: 'control' });
  }, [isHost, realtime]);

  return (
    <div className="flex flex-col h-screen bg-black">
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        muted={isHost}
        playsInline
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />

      <div className="p-4 bg-zinc-900 flex gap-4">
        <input type="file" accept="video/mp4" onChange={handleLocalFile} className="text-white" />
        
        {isHost && (
          <>
            <button onClick={startLiveStream} className="bg-green-500 px-6 py-2 rounded">Start Live Stream</button>
            <button onClick={() => videoRef.current?.pause()} className="bg-red-500 px-6 py-2 rounded">Pause</button>
            <button onClick={() => videoRef.current?.play()} className="bg-blue-500 px-6 py-2 rounded">Play</button>
          </>
        )}

        {localFileUrl && (
          <div className="text-green-400 text-sm">Local file ready • Live streaming active</div>
        )}
      </div>

      <div className="text-center text-zinc-400 mt-4">
        {isHost ? 'Host mode - Live streaming enabled' : 'Viewer mode - Real-time stream will appear here'}
      </div>
    </div>
  );
}

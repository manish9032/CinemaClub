'use client';
import { useState, useEffect, useRef } from 'react';
import { useRealtime } from '@/lib/supabase';
import { WebRTCStream } from '@/lib/webrtcStream';

export default function WatchRoomPage({ roomId }: { roomId: string }) {
  const { user, realtime } = useRealtime();
  const [isHost, setIsHost] = useState(false);
  const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<WebRTCStream | null>(null);

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

  const startLiveStream = async () => {
    if (!videoRef.current || !isHost || !realtime) return;

    await videoRef.current.play();
    streamRef.current = new WebRTCStream(
      'host',
      roomId,
      user.id,
      realtime,
      { onConnectionState: (state) => console.log('Host connection:', state) }
    );
    await streamRef.current.startAsHost(videoRef.current);
  };

  // Viewer connection
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
          console.log('Viewer connection:', state);
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

  return (
    <div className="flex flex-col h-screen bg-black">
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        muted={isHost}
        playsInline
      />

      <div className="p-4 bg-zinc-900 flex gap-4">
        <input
          type="file"
          accept="video/mp4,video/*"
          onChange={handleLocalFile}
          className="text-white"
        />

        {isHost && (
          <button
            onClick={startLiveStream}
            className="bg-green-500 px-6 py-2 rounded font-bold"
          >
            Start Live Stream
          </button>
        )}

        {localFileUrl && (
          <div className="text-green-400 text-sm self-center">✅ Local file ready • Live streaming active</div>
        )}
      </div>

      <div className="text-center text-zinc-400 mt-6">
        {isHost 
          ? 'Host mode - Movie will play here and stream to viewers' 
          : 'Viewer mode - Real-time stream will appear here'}
      </div>
    </div>
  );
}

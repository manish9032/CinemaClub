import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { WebRTCStream, type SignalingAdapter } from '../lib/webrtcStream';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export default function WatchRoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<WebRTCStream | null>(null);

  const [isHost, setIsHost] = useState(false);
  const [status, setStatus] = useState('Connecting...');
  const [error, setError] = useState<string | null>(null);
  const [localFileName, setLocalFileName] = useState<string | null>(null);

  // ---------- Signaling Adapter (Supabase Realtime) ----------
  const createSignaling = (channel: ReturnType<typeof supabase.channel>): SignalingAdapter => ({
    send: (event, payload) => {
      channel.send({
        type: 'broadcast',
        event,
        payload,
      });
    },
    on: (event, handler) => {
      const sub = channel.on('broadcast', { event }, ({ payload }) => {
        handler(payload);
      });
      return () => {
        // supabase channel se specific listener remove karna mushkil hai,
        // isliye stop() pe poora channel remove hota hai
      };
    },
  });

  // ---------- Host: Local file select ----------
  const handleLocalFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !videoRef.current || !isHost) return;

    try {
      setError(null);
      setLocalFileName(file.name);
      setStatus('Loading file...');

      const url = URL.createObjectURL(file);
      const video = videoRef.current;
      video.src = url;
      video.load();

      // metadata wait
      await new Promise<void>((resolve, reject) => {
        const onMeta = () => {
          video.removeEventListener('loadedmetadata', onMeta);
          resolve();
        };
        video.addEventListener('loadedmetadata', onMeta);
        video.onerror = () => reject(new Error('File load nahi hua. 

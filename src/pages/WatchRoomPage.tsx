// Host ke video element pe
const videoRef = useRef<HTMLVideoElement>(null);
const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
const streamRef = useRef<WebRTCStream | null>(null);

// File select handler
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

// Jab host play kare
const startLiveStream = async () => {
  if (!videoRef.current || !isHost) return;

  // Pehle video play karo (captureStream ke liye play hona zaroori hai)
  await videoRef.current.play();

  streamRef.current = new WebRTCStream(
    'host',
    roomId,
    user.id,
    realtimeChannel, // tumhara Supabase channel
    {
      onConnectionState: (state) => console.log('Host connection:', state),
    }
  );

  await streamRef.current.startAsHost(videoRef.current);
};

// Viewer side
useEffect(() => {
  if (isHost || !realtimeChannel) return;

  const stream = new WebRTCStream(
    'viewer',
    roomId,
    user.id,
    realtimeChannel,
    {
      onRemoteStream: (remoteStream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = remoteStream;
          videoRef.current.play().catch(console.error);
        }
      },
      onConnectionState: (state) => {
        console.log('Viewer connection:', state);
        // "Receiving from host..." status update karo
      },
    }
  );

  stream.startAsViewer();
  streamRef.current = stream;

  // Signaling listeners
  const handleMessage = (payload: any) => {
    const { event, payload: data } = payload;
    if (event === 'offer' && data.from !== user.id) {
      stream.handleOffer(data.sdp);
    } else if (event === 'answer' && data.from !== user.id) {
      stream.handleAnswer(data.sdp);
    } else if (event === 'ice-candidate') {
      stream.handleIceCandidate(data.candidate);
    }
  };

  realtimeChannel.on('broadcast', { event: 'offer' }, handleMessage);
  realtimeChannel.on('broadcast', { event: 'answer' }, handleMessage);
  realtimeChannel.on('broadcast', { event: 'ice-candidate' }, handleMessage);

  return () => {
    stream.stop();
  };
}, [isHost, roomId, user?.id]);

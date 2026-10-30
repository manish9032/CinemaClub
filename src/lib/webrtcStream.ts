// src/lib/webrtcStream.ts
export type StreamRole = 'host' | 'viewer';

export interface StreamCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onIceConnectionState?: (state: RTCIceConnectionState) => void;
  onError?: (err: Error) => void;
  onStatus?: (status: string) => void;
}

/** Signaling adapter – Socket.io ya Supabase dono ke saath chalega */
export interface SignalingAdapter {
  send: (event: string, payload: any) => void;
  on: (event: string, handler: (payload: any) => void) => () => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

// Fix TypeScript types for captureStream
interface CaptureVideoElement extends HTMLVideoElement {
  captureStream(frameRate?: number): MediaStream;
  mozCaptureStream?(frameRate?: number): MediaStream;
}

/** Wait until video has real frames + audio ready */
function waitForVideoReady(video: HTMLVideoElement, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 3 && video.videoWidth > 0) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Video metadata / frames load timeout. File codec browser support nahi karta (MKV/H.265?).'));
    }, timeoutMs);

    const onReady = () => {
      if (video.videoWidth > 0 && video.readyState >= 2) {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('playing', onReady);
      video.removeEventListener('error', onError);
    };

    const onError = () => {
      cleanup();
      reject(new Error(video.error?.message || 'Video load error'));
    };

    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('playing', onReady);
    video.addEventListener('error', onError);

    onReady();
  });
}

export class WebRTCStream {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private senders: RTCRtpSender[] = [];
  private role: StreamRole;
  private userId: string;
  private callbacks: StreamCallbacks;
  private signaling: SignalingAdapter;
  private unsubscribers: Array<() => void> = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;

  constructor(
    role: StreamRole,
    userId: string,
    signaling: SignalingAdapter,
    callbacks: StreamCallbacks = {}
  ) {
    this.role = role;
    this.userId = userId;
    this.signaling = signaling;
    this.callbacks = callbacks;
  }

  // -------------------- HOST --------------------
  async startAsHost(videoElement: HTMLVideoElement) {
    if (this.role !== 'host') throw new Error('Only host');

    this.callbacks.onStatus?.('preparing-video');

    try {
      if (videoElement.paused) {
        await videoElement.play();
      }
    } catch (e) {
      videoElement.muted = true;
      await videoElement.play();
      videoElement.muted = false;
    }

    await waitForVideoReady(videoElement);

    const captureEl = videoElement as CaptureVideoElement;
    const stream = captureEl.captureStream
      ? captureEl.captureStream()
      : captureEl.mozCaptureStream?.();

    if (!stream) {
      throw new Error('captureStream not supported in this browser');
    }

    this.localStream = stream;

    stream.getTracks().forEach((track: MediaStreamTrack) => {
      track.enabled = true;
      if ('muted' in track && (track as any).muted) {
        console.warn('Track was muted, forcing enabled', track.kind);
      }
    });

    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();

    if (videoTracks.length === 0) {
      throw new Error(
        'No video track from captureStream. File codec unsupported (try H.264 MP4).'
      );
    }

    console.log('[Host] tracks', {
      video: videoTracks.map((t: MediaStreamTrack) => ({
        id: t.id,
        readyState: t.readyState,
        enabled: t.enabled,
        muted: (t as any).muted,
        settings: t.getSettings?.(),
      })),
      audio: audioTracks.map((t: MediaStreamTrack) => ({
        id: t.id,
        readyState: t.readyState,
        enabled: t.enabled,
      })),
    });

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.senders = [];
    stream.getTracks().forEach((track: MediaStreamTrack) => {
      const sender = this.pc!.addTrack(track, stream);
      this.senders.push(sender);
    });

    this.wirePeerConnection();
    this.wireSignaling();

    await this.createAndSendOffer();
    this.callbacks.onStatus?.('streaming');
  }

  async replaceSource(videoElement: HTMLVideoElement) {
    if (this.role !== 'host' || !this.pc) {
      throw new Error('replaceSource only after startAsHost');
    }

    if (videoElement.paused) {
      try {
        await videoElement.play();
      } catch {
        videoElement.muted = true;
        await videoElement.play();
        videoElement.muted = false;
      }
    }

    await waitForVideoReady(videoElement);

    const newStream = (videoElement as CaptureVideoElement).captureStream();
    newStream.getTracks().forEach((t: MediaStreamTrack) => (t.enabled = true));

    const newVideo = newStream.getVideoTracks()[0] || null;
    const newAudio = newStream.getAudioTracks()[0] || null;

    for (const sender of this.senders) {
      if (sender.track?.kind === 'video' && newVideo) {
        await sender.replaceTrack(newVideo);
      } else if (sender.track?.kind === 'audio' && newAudio) {
        await sender.replaceTrack(newAudio);
      }
    }

    if (newAudio && !this.senders.some((s) => s.track?.kind === 'audio')) {
      const s = this.pc.addTrack(newAudio, newStream);
      this.senders.push(s);
      await this.createAndSendOffer();
    }

    this.localStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    this.localStream = newStream;

    this.callbacks.onStatus?.('source-replaced');
  }

  // -------------------- VIEWER --------------------
  async startAsViewer() {
    if (this.role !== 'viewer') throw new Error('Only viewer');

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.wirePeerConnection();
    this.wireSignaling();
    this.callbacks.onStatus?.('waiting-for-host');
  }

  // -------------------- Internal --------------------
  private wirePeerConnection() {
    if (!this.pc) return;

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.signaling.send('ice-candidate', {
          candidate: ev.candidate.toJSON(),
          from: this.userId,
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc!.connectionState;
      this.callbacks.onConnectionState?.(s);
      this.callbacks.onStatus?.(s);
      if (s === 'failed') {
        this.callbacks.onError?.(new Error('Peer connection failed'));
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this.callbacks.onIceConnectionState?.(this.pc!.iceConnectionState);
    };

    this.pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      stream.getTracks().forEach((t: MediaStreamTrack) => (t.enabled = true));

      console.log('[Viewer] ontrack', {
        kind: ev.track.kind,
        readyState: ev.track.readyState,
        enabled: ev.track.enabled,
        muted: (ev.track as any).muted,
      });

      this.callbacks.onRemoteStream?.(stream);
      this.callbacks.onStatus?.('receiving');
    };
  }

  private wireSignaling() {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];

    this.unsubscribers.push(
      this.signaling.on('offer', async (data: any) => {
        if (data.from === this.userId) return;
        await this.handleOffer(data.sdp, data.from);
      })
    );

    this.unsubscribers.push(
      this.signaling.on('answer', async (data: any) => {
        if (data.from === this.userId) return;
        await this.handleAnswer(data.sdp);
      })
    );

    this.unsubscribers.push(
      this.signaling.on('ice-candidate', async (data: any) => {
        if (data.from === this.userId) return;
        await this.handleIceCandidate(data.candidate);
      })
    );
  }

  private async createAndSendOffer() {
    if (!this.pc) return;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await this.pc.setLocalDescription(offer);
      this.signaling.send('offer', {
        sdp: this.pc.localDescription,
        from: this.userId,
      });
    } finally {
      this.makingOffer = false;
    }
  }

  async handleOffer(offer: RTCSessionDescriptionInit, from?: string) {
    if (!this.pc) return;

    const readyForOffer =
      !this.makingOffer &&
      (this.pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);

    const offerCollision = !readyForOffer;
    this.ignoreOffer = this.role === 'host' && offerCollision;
    if (this.ignoreOffer) return;

    this.isSettingRemoteAnswerPending = true;
    await this.pc.setRemoteDescription(offer);
    this.isSettingRemoteAnswerPending = false;

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.signaling.send('answer', {
      sdp: this.pc.localDescription,
      from: this.userId,
      to: from,
    });
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    if (this.pc.signalingState === 'have-local-offer') {
      await this.pc.setRemoteDescription(answer);
    }
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      if (!this.ignoreOffer) {
        console.warn('addIceCandidate failed', e);
      }
    }
  }

  stop() {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    this.localStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    this.pc?.close();
    this.pc = null;
    this.localStream = null;
    this.senders = [];
  }
}

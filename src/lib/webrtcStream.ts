// src/lib/webrtcStream.ts
export type StreamRole = 'host' | 'viewer';

export interface StreamCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onError?: (err: Error) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // TURN servers (alag networks ke liye — free tier)
  { urls: 'turn:relay.metered.ca:80', username: 'free', credential: 'free' },
  { urls: 'turn:relay.metered.ca:443', username: 'free', credential: 'free' },
  { urls: 'turn:relay.metered.ca:5349', username: 'free', credential: 'free' },
];

export class WebRTCStream {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private role: StreamRole;
  private roomId: string;
  private userId: string;
  private callbacks: StreamCallbacks;
  private signalingChannel: any;

  constructor(
    role: StreamRole,
    roomId: string,
    userId: string,
    signalingChannel: any,
    callbacks: StreamCallbacks = {}
  ) {
    this.role = role;
    this.roomId = roomId;
    this.userId = userId;
    this.signalingChannel = signalingChannel;
    this.callbacks = callbacks;
  }

  async startAsHost(videoElement: HTMLVideoElement) {
    if (this.role !== 'host') throw new Error('Only host can start stream');

    this.localStream = videoElement.captureStream();
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.localStream.getTracks().forEach(track => {
      this.pc!.addTrack(track, this.localStream!);
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingChannel.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: event.candidate, from: this.userId, to: 'all' },
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      this.callbacks.onConnectionState?.(this.pc!.connectionState);
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signalingChannel.send({
      type: 'broadcast',
      event: 'offer',
      payload: { sdp: offer, from: this.userId },
    });
  }

  async startAsViewer() {
    if (this.role !== 'viewer') throw new Error('Only viewer');

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.ontrack = (event) => {
      const [stream] = event.streams;
      this.callbacks.onRemoteStream?.(stream);
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingChannel.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: event.candidate, from: this.userId },
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      this.callbacks.onConnectionState?.(this.pc!.connectionState);
    };
  }

  async handleOffer(offer: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signalingChannel.send({
      type: 'broadcast',
      event: 'answer',
      payload: { sdp: answer, from: this.userId },
    });
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(answer);
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) { console.warn('ICE candidate error', e); }
  }

  stop() {
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.pc = this.localStream = null;
  }
}

// src/lib/webrtcStream.ts
//
// Live P2P video streaming for the watch-party room.
//   HOST   : captures its own <video> element (captureStream) and sends the live
//            MediaStream to every viewer over WebRTC (one RTCPeerConnection per viewer).
//   VIEWER : receives the live MediaStream and hands the WHOLE stream to
//            `onRemoteStream`, so the page can bind it to `video.srcObject`.
//
// Whatever the host does (play / pause / seek) is mirrored automatically because
// viewers are watching the host's live output, not a downloaded file.

import { USE_LOCAL } from './mode';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamRole = 'host' | 'viewer';

export interface StreamCallbacks {
  /** Viewer: fired with the complete live MediaStream (tracks already enabled). */
  onRemoteStream?: (stream: MediaStream) => void;
  /** Viewer: host left / stopped sharing. */
  onRemoteStreamEnded?: () => void;
  /** Host: number of viewers currently negotiated. */
  onViewerCount?: (count: number) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onIceConnectionState?: (state: RTCIceConnectionState) => void;
  onError?: (err: Error) => void;
  onStatus?: (status: string) => void;
}

/** Every signaling message has this shape. */
export interface SignalMessage {
  from: string;
  to?: string;
  role?: StreamRole;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export type SignalHandler = (payload: SignalMessage) => void;

/** Signaling adapter – Supabase broadcast (or BroadcastChannel in local mode). */
export interface SignalingAdapter {
  send: (event: string, payload: SignalMessage) => void;
  on: (event: string, handler: SignalHandler) => () => void;
  /** Open the underlying channel (resolves once messages can flow). */
  connect?: () => Promise<void>;
  /** Close the underlying channel. */
  close?: () => void;
}

export interface HostStartOptions {
  /**
   * Try to call video.play() before capturing (falls back to a muted play).
   * Default false: the host presses play himself and viewers follow.
   */
  autoPlay?: boolean;
}

interface CaptureCapable {
  captureStream?: (frameRate?: number) => MediaStream;
  mozCaptureStream?: (frameRate?: number) => MediaStream;
}

interface HostPeer {
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

const CAPTURE_FPS = 30;
const CAPTURE_SETTLE_MS = 100; // let the browser initialise the captured tracks
const MAX_VIDEO_BITRATE = 4_000_000; // 4 Mbps
const VIEWER_RETRY_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Wait until the element has metadata + real dimensions. */
function waitForVideoReady(video: HTMLVideoElement, timeoutMs = 15000): Promise<void> {
  const isReady = (): boolean =>
    video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_METADATA;

  return new Promise<void>((resolve, reject) => {
    if (isReady()) {
      resolve();
      return;
    }

    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'] as const;

    const cleanup = (): void => {
      clearTimeout(timer);
      events.forEach((ev) => video.removeEventListener(ev, onReady));
      video.removeEventListener('error', onError);
    };

    const onReady = (): void => {
      if (isReady()) {
        cleanup();
        resolve();
      }
    };

    const onError = (): void => {
      cleanup();
      reject(new Error(video.error?.message || 'Video failed to load'));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'Video metadata did not load in time. The file codec may not be supported by this browser (MKV / H.265?). Try an H.264 MP4.'
        )
      );
    }, timeoutMs);

    events.forEach((ev) => video.addEventListener(ev, onReady));
    video.addEventListener('error', onError);
  });
}

/** play() with a muted fallback (host side, only used when autoPlay is requested). */
async function safePlay(video: HTMLVideoElement): Promise<void> {
  try {
    await video.play();
  } catch {
    const wasMuted = video.muted;
    video.muted = true;
    try {
      await video.play();
    } finally {
      video.muted = wasMuted;
    }
  }
}

/** Capture the element's output as a live MediaStream with all tracks enabled. */
function captureFromVideo(video: HTMLVideoElement): MediaStream {
  const el = video as unknown as CaptureCapable;
  const capture = el.captureStream ?? el.mozCaptureStream;
  if (typeof capture !== 'function') {
    throw new Error('captureStream() is not supported in this browser. Use Chrome, Edge or Firefox.');
  }

  const stream = capture.call(video, CAPTURE_FPS);
  stream.getTracks().forEach((track) => {
    track.enabled = true;
  });

  if (stream.getVideoTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('No video track could be captured. The file codec is probably unsupported (try H.264 MP4).');
  }
  return stream;
}

// ---------------------------------------------------------------------------
// Room signaling (Supabase broadcast, or BroadcastChannel when USE_LOCAL)
// ---------------------------------------------------------------------------

export function createRoomSignaling(roomId: string, userId: string): SignalingAdapter {
  const channelName = `cc-live:${roomId.toUpperCase()}`;
  const handlers = new Map<string, Set<SignalHandler>>();
  let bc: BroadcastChannel | null = null;
  let sb: ReturnType<typeof supabase.channel> | null = null;
  let ready = false;

  const dispatch = (event: string, payload: SignalMessage | undefined): void => {
    if (!payload || payload.from === userId) return;
    handlers.get(event)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (e) {
        console.error('[signaling] handler error', event, e);
      }
    });
  };

  return {
    send(event, payload) {
      if (USE_LOCAL) {
        bc?.postMessage({ event, payload });
        return;
      }
      if (sb && ready) {
        void sb.send({ type: 'broadcast', event: 'live', payload: { event, data: payload } });
      }
    },

    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set<SignalHandler>();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },

    async connect() {
      if (USE_LOCAL) {
        if (typeof BroadcastChannel === 'undefined') return;
        bc = new BroadcastChannel(channelName);
        bc.onmessage = (e: MessageEvent) => {
          const msg = e.data as { event?: string; payload?: SignalMessage } | null;
          if (msg && typeof msg.event === 'string') dispatch(msg.event, msg.payload);
        };
        ready = true;
        return;
      }

      const channel = supabase.channel(channelName, { config: { broadcast: { self: false } } });
      sb = channel;
      channel.on('broadcast', { event: 'live' }, ({ payload }) => {
        const msg = payload as { event?: string; data?: SignalMessage } | null;
        if (msg && typeof msg.event === 'string') dispatch(msg.event, msg.data);
      });

      await new Promise<void>((resolve) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            ready = true;
            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.error('[signaling] channel status', status);
            resolve();
          }
        });
      });
    },

    close() {
      handlers.clear();
      bc?.close();
      bc = null;
      if (sb) {
        void supabase.removeChannel(sb);
        sb = null;
      }
      ready = false;
    },
  };
}

// ---------------------------------------------------------------------------
// WebRTCStream
// ---------------------------------------------------------------------------

export class WebRTCStream {
  private readonly role: StreamRole;
  private readonly userId: string;
  private readonly signaling: SignalingAdapter;
  private readonly callbacks: StreamCallbacks;

  private unsubscribers: Array<() => void> = [];
  private stopped = false;

  // host state
  private localStream: MediaStream | null = null;
  private readonly peers = new Map<string, HostPeer>();
  private readonly connecting = new Set<string>();

  // viewer state
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteStream: MediaStream | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

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

  // ======================================================================
  // HOST
  // ======================================================================

  /** Start sharing `videoElement`. Safe to call once; use replaceSource() afterwards. */
  async startAsHost(videoElement: HTMLVideoElement, options: HostStartOptions = {}): Promise<void> {
    this.assertRole('host');
    this.stopped = false;
    this.callbacks.onStatus?.('preparing-video');

    // Listen first so no viewer request is missed while we prepare the video.
    this.wireHostSignaling();
    await this.signaling.connect?.();

    try {
      await this.attachSource(videoElement, options);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(errMsg(e));
      this.callbacks.onError?.(err);
      throw err;
    }
    this.callbacks.onStatus?.('streaming');
  }

  /**
   * Host picked another file: capture the element again and make every viewer
   * reconnect to the new stream.
   */
  async replaceSource(videoElement: HTMLVideoElement, options: HostStartOptions = {}): Promise<void> {
    this.assertRole('host');
    try {
      await this.attachSource(videoElement, options);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(errMsg(e));
      this.callbacks.onError?.(err);
      throw err;
    }
    this.callbacks.onStatus?.('source-replaced');
  }

  private async attachSource(video: HTMLVideoElement, options: HostStartOptions): Promise<void> {
    if (options.autoPlay && video.paused) {
      await safePlay(video);
    }

    await waitForVideoReady(video);
    // Race-condition guard: give the browser a moment to initialise the tracks.
    await delay(CAPTURE_SETTLE_MS);

    let next: MediaStream | null = null;
    for (let attempt = 0; attempt < 3 && !next; attempt++) {
      try {
        next = captureFromVideo(video);
      } catch (e) {
        if (attempt === 2) throw e;
        await delay(150);
      }
    }
    if (!next) throw new Error('Could not capture the video stream.');

    const previous = this.localStream;
    this.localStream = next;

    this.closeAllPeers();
    previous?.getTracks().forEach((track) => track.stop());

    // First source -> "host-ready". Later sources -> force viewers to reconnect.
    this.signaling.send(previous ? 'source-changed' : 'host-ready', {
      from: this.userId,
      role: 'host',
    });
  }

  private wireHostSignaling(): void {
    this.clearSignaling();

    this.unsubscribers.push(
      this.signaling.on('need-stream', (m) => {
        void this.createPeerForViewer(m.from);
      }),
      this.signaling.on('answer', (m) => {
        void this.handleHostAnswer(m);
      }),
      this.signaling.on('ice-candidate', (m) => {
        void this.handleHostIce(m);
      }),
      this.signaling.on('goodbye', (m) => {
        if (m.role === 'viewer') this.closePeer(m.from);
      })
    );
  }

  private async createPeerForViewer(viewerId: string): Promise<void> {
    const stream = this.localStream;
    if (!stream || this.stopped || this.connecting.has(viewerId)) return;

    this.connecting.add(viewerId);
    try {
      this.closePeer(viewerId);

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.peers.set(viewerId, { pc, pendingIce: [] });
      this.callbacks.onViewerCount?.(this.peers.size);

      stream.getTracks().forEach((track) => {
        track.enabled = true;
        pc.addTrack(track, stream);
      });

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this.signaling.send('ice-candidate', {
            from: this.userId,
            to: viewerId,
            role: 'host',
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (this.peers.get(viewerId)?.pc !== pc) return;
        this.callbacks.onConnectionState?.(pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this.closePeer(viewerId);
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (this.peers.get(viewerId)?.pc === pc) {
          this.callbacks.onIceConnectionState?.(pc.iceConnectionState);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.send('offer', {
        from: this.userId,
        to: viewerId,
        role: 'host',
        sdp: pc.localDescription?.toJSON() ?? offer,
      });

      this.tuneSenders(pc);
    } catch (e) {
      console.error('[host] failed to create peer', e);
      this.callbacks.onError?.(e instanceof Error ? e : new Error(errMsg(e)));
      this.closePeer(viewerId);
    } finally {
      this.connecting.delete(viewerId);
    }
  }

  private async handleHostAnswer(m: SignalMessage): Promise<void> {
    if (m.to !== this.userId || !m.sdp) return;
    const entry = this.peers.get(m.from);
    if (!entry || entry.pc.currentRemoteDescription) return;

    try {
      await entry.pc.setRemoteDescription(m.sdp);
      const queued = entry.pendingIce.splice(0);
      for (const candidate of queued) {
        try {
          await entry.pc.addIceCandidate(candidate);
        } catch {
          /* stale candidate */
        }
      }
    } catch (e) {
      console.error('[host] setRemoteDescription failed', e);
    }
  }

  private async handleHostIce(m: SignalMessage): Promise<void> {
    if (m.to !== this.userId || !m.candidate) return;
    const entry = this.peers.get(m.from);
    if (!entry) return;

    if (entry.pc.remoteDescription) {
      try {
        await entry.pc.addIceCandidate(m.candidate);
      } catch {
        /* stale candidate */
      }
    } else {
      entry.pendingIce.push(m.candidate);
    }
  }

  /** Smooth framerate for movies + a sensible bitrate cap. */
  private tuneSenders(pc: RTCPeerConnection): void {
    pc.getSenders().forEach((sender) => {
      const track = sender.track;
      if (!track || track.kind !== 'video') return;

      try {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion';
      } catch {
        /* not supported */
      }

      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
      params.encodings[0].maxFramerate = CAPTURE_FPS;
      sender.setParameters(params).catch(() => {
        /* browser may reject – harmless */
      });
    });
  }

  private closePeer(viewerId: string): void {
    const entry = this.peers.get(viewerId);
    if (!entry) return;
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.oniceconnectionstatechange = null;
    entry.pc.close();
    this.peers.delete(viewerId);
    this.callbacks.onViewerCount?.(this.peers.size);
  }

  private closeAllPeers(): void {
    Array.from(this.peers.keys()).forEach((id) => this.closePeer(id));
  }

  // ======================================================================
  // VIEWER
  // ======================================================================

  async startAsViewer(): Promise<void> {
    this.assertRole('viewer');
    this.stopped = false;
    this.callbacks.onStatus?.('waiting-for-host');

    this.wireViewerSignaling();
    await this.signaling.connect?.();

    this.requestStream();
    this.retryTimer = setInterval(() => {
      if (this.stopped) return;
      const state = this.pc?.connectionState;
      if (!this.pc || state === 'failed' || state === 'closed') this.requestStream();
    }, VIEWER_RETRY_MS);
  }

  private requestStream(): void {
    if (this.stopped) return;
    this.signaling.send('need-stream', { from: this.userId, role: 'viewer' });
    this.callbacks.onStatus?.('requesting');
  }

  private wireViewerSignaling(): void {
    this.clearSignaling();

    this.unsubscribers.push(
      this.signaling.on('offer', (m) => {
        void this.handleViewerOffer(m);
      }),
      this.signaling.on('ice-candidate', (m) => {
        void this.handleViewerIce(m);
      }),
      this.signaling.on('host-ready', () => {
        const state = this.pc?.connectionState;
        if (!this.pc || state === 'failed' || state === 'closed') this.requestStream();
      }),
      this.signaling.on('source-changed', () => {
        this.requestStream();
      }),
      this.signaling.on('goodbye', (m) => {
        if (m.role !== 'host') return;
        this.closeViewerPc();
        this.remoteStream = null;
        this.callbacks.onStatus?.('host-left');
        this.callbacks.onRemoteStreamEnded?.();
      })
    );
  }

  private async handleViewerOffer(m: SignalMessage): Promise<void> {
    if (m.to !== this.userId || !m.sdp || this.stopped) return;

    try {
      this.closeViewerPc();
      this.remoteStream = null;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.pc = pc;

      pc.ontrack = (ev: RTCTrackEvent) => {
        if (this.pc !== pc) return;

        const incoming = ev.streams[0];
        if (incoming) {
          this.remoteStream = incoming;
        } else {
          // Sender did not attach a stream id: build one ourselves.
          if (!this.remoteStream) this.remoteStream = new MediaStream();
          if (!this.remoteStream.getTracks().includes(ev.track)) {
            this.remoteStream.addTrack(ev.track);
          }
        }

        ev.track.enabled = true;
        this.remoteStream.getTracks().forEach((track) => {
          track.enabled = true;
        });

        this.callbacks.onRemoteStream?.(this.remoteStream);
        this.callbacks.onStatus?.('receiving');
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this.signaling.send('ice-candidate', {
            from: this.userId,
            to: m.from,
            role: 'viewer',
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (this.pc !== pc) return;
        this.callbacks.onConnectionState?.(pc.connectionState);
        if (pc.connectionState === 'failed') {
          this.callbacks.onError?.(new Error('Peer connection failed'));
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (this.pc === pc) this.callbacks.onIceConnectionState?.(pc.iceConnectionState);
      };

      this.callbacks.onStatus?.('connecting');
      await pc.setRemoteDescription(m.sdp);

      const queued = this.pendingIce.splice(0);
      for (const candidate of queued) {
        try {
          await pc.addIceCandidate(candidate);
        } catch {
          /* stale candidate */
        }
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send('answer', {
        from: this.userId,
        to: m.from,
        role: 'viewer',
        sdp: pc.localDescription?.toJSON() ?? answer,
      });
    } catch (e) {
      console.error('[viewer] offer handling failed', e);
      this.callbacks.onError?.(e instanceof Error ? e : new Error(errMsg(e)));
    }
  }

  private async handleViewerIce(m: SignalMessage): Promise<void> {
    if (m.to !== this.userId || !m.candidate) return;

    if (this.pc && this.pc.remoteDescription) {
      try {
        await this.pc.addIceCandidate(m.candidate);
      } catch {
        /* stale candidate */
      }
    } else {
      this.pendingIce.push(m.candidate);
    }
  }

  private closeViewerPc(): void {
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    this.pendingIce = [];
  }

  // ======================================================================
  // Shared
  // ======================================================================

  stop(): void {
    this.stopped = true;

    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }

    // Tell the other side we are leaving, then tear everything down.
    this.signaling.send('goodbye', { from: this.userId, role: this.role });

    this.clearSignaling();
    this.closeAllPeers();
    this.closeViewerPc();

    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.remoteStream = null;

    // Give the "goodbye" broadcast a moment to flush before closing the channel.
    const signaling = this.signaling;
    setTimeout(() => signaling.close?.(), 300);
  }

  private clearSignaling(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }

  private assertRole(expected: StreamRole): void {
    if (this.role !== expected) {
      throw new Error(`This method is only available for the ${expected} role`);
    }
  }
}

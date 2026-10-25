/**
 * Ephemeral WebRTC host→viewer media streaming.
 * Movie bytes never leave the host browser except as live WebRTC media tracks.
 * Nothing is uploaded or stored in the database.
 */

import { USE_LOCAL } from './mode';
import { supabase } from './supabase';

export type SignalMessage =
  | { type: 'offer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: 'need-stream'; from: string }
  | { type: 'host-ready'; from: string }
  | { type: 'goodbye'; from: string };

type SignalHandler = (msg: SignalMessage) => void;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** Signaling bus: BroadcastChannel (local) or Supabase Realtime broadcast (cloud). */
export function createSignaling(roomId: string, userId: string) {
  const id = roomId.toUpperCase();
  const channelName = `cc-webrtc:${id}`;
  const handlers = new Set<SignalHandler>();
  let bc: BroadcastChannel | null = null;
  let sbChannel: ReturnType<typeof supabase.channel> | null = null;
  let ready = false;

  const emit = (msg: SignalMessage) => {
    handlers.forEach((h) => {
      try {
        h(msg);
      } catch (e) {
        console.error('webrtc signal handler', e);
      }
    });
  };

  const send = (msg: SignalMessage) => {
    if (USE_LOCAL) {
      // Other tabs receive via BroadcastChannel. Do not emit locally —
      // same tab is almost never both host and viewer as two accounts.
      bc?.postMessage(msg);
      return;
    }
    if (sbChannel && ready) {
      void sbChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload: msg,
      });
    }
  };

  const subscribe = (handler: SignalHandler) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  const start = async () => {
    if (USE_LOCAL) {
      if (typeof BroadcastChannel === 'undefined') return;
      bc = new BroadcastChannel(channelName);
      bc.onmessage = (e) => {
        const msg = e.data as SignalMessage;
        if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
        // Ignore our own outbound signals echoed back
        if ('from' in msg && msg.from === userId) return;
        emit(msg);
      };
      ready = true;
      return;
    }

    sbChannel = supabase.channel(channelName, {
      config: { broadcast: { self: false } },
    });
    sbChannel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      const msg = payload as SignalMessage;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
      if ('from' in msg && msg.from === userId) return;
      emit(msg);
    });
    await new Promise<void>((resolve) => {
      sbChannel!.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          ready = true;
          resolve();
        }
      });
    });
  };

  const stop = () => {
    handlers.clear();
    bc?.close();
    bc = null;
    if (sbChannel) {
      void supabase.removeChannel(sbChannel);
      sbChannel = null;
    }
    ready = false;
  };

  return { start, stop, send, subscribe, get ready() { return ready; } };
}

export type PeerMap = Map<string, RTCPeerConnection>;

/** Host side: one RTCPeerConnection per viewer, tracks from captureStream(). */
export function createHostStreamer(opts: {
  roomId: string;
  hostId: string;
  getMediaStream: () => MediaStream | null;
  onViewerCount?: (n: number) => void;
}) {
  const peers: PeerMap = new Map();
  const signaling = createSignaling(opts.roomId, opts.hostId);
  let unsub: (() => void) | null = null;

  const closePeer = (viewerId: string) => {
    const pc = peers.get(viewerId);
    if (pc) {
      pc.close();
      peers.delete(viewerId);
      opts.onViewerCount?.(peers.size);
    }
  };

  const addTracks = (pc: RTCPeerConnection) => {
    const stream = opts.getMediaStream();
    if (!stream) return;
    const existing = new Set(pc.getSenders().map((s) => s.track?.id));
    stream.getTracks().forEach((track) => {
      if (!existing.has(track.id)) {
        pc.addTrack(track, stream);
      }
    });
  };

  const makePeer = async (viewerId: string) => {
    if (peers.has(viewerId)) closePeer(viewerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(viewerId, pc);
    opts.onViewerCount?.(peers.size);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        signaling.send({
          type: 'ice',
          from: opts.hostId,
          to: viewerId,
          candidate: ev.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        // keep disconnected briefly; failed → close
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          closePeer(viewerId);
        }
      }
    };

    addTracks(pc);

    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      signaling.send({
        type: 'offer',
        from: opts.hostId,
        to: viewerId,
        sdp: pc.localDescription!.toJSON(),
      });
    } catch (e) {
      console.error('createOffer failed', e);
      closePeer(viewerId);
    }
  };

  const replaceTracks = () => {
    const stream = opts.getMediaStream();
    if (!stream) return;
    peers.forEach((pc) => {
      const senders = pc.getSenders();
      stream.getTracks().forEach((track) => {
        const sender = senders.find((s) => s.track?.kind === track.kind);
        if (sender) {
          void sender.replaceTrack(track);
        } else {
          pc.addTrack(track, stream);
        }
      });
    });
  };

  const start = async () => {
    await signaling.start();
    unsub = signaling.subscribe(async (msg) => {
      if (msg.type === 'need-stream' || msg.type === 'host-ready') {
        // viewer is asking for stream
        if (msg.type === 'need-stream') {
          void makePeer(msg.from);
        }
        return;
      }
      if (msg.type === 'answer' && msg.to === opts.hostId) {
        const pc = peers.get(msg.from);
        if (pc && !pc.currentRemoteDescription) {
          try {
            await pc.setRemoteDescription(msg.sdp);
          } catch (e) {
            console.error('setRemoteDescription answer', e);
          }
        }
        return;
      }
      if (msg.type === 'ice' && msg.to === opts.hostId) {
        const pc = peers.get(msg.from);
        if (pc && msg.candidate) {
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch {
            /* ignore late candidates */
          }
        }
        return;
      }
      if (msg.type === 'goodbye') {
        closePeer(msg.from);
      }
    });

    // announce that host can stream
    signaling.send({ type: 'host-ready', from: opts.hostId });
  };

  const stop = () => {
    unsub?.();
    unsub = null;
    peers.forEach((pc) => pc.close());
    peers.clear();
    opts.onViewerCount?.(0);
    signaling.send({ type: 'goodbye', from: opts.hostId });
    signaling.stop();
  };

  return {
    start,
    stop,
    replaceTracks,
    /** Call when a new viewer is known to be in the room */
    offerTo: (viewerId: string) => void makePeer(viewerId),
    peerCount: () => peers.size,
  };
}

/** Viewer side: receives remote MediaStream via WebRTC. */
export function createViewerReceiver(opts: {
  roomId: string;
  viewerId: string;
  hostId: string;
  onStream: (stream: MediaStream | null) => void;
  onStatus?: (status: string) => void;
}) {
  let pc: RTCPeerConnection | null = null;
  const signaling = createSignaling(opts.roomId, opts.viewerId);
  let unsub: (() => void) | null = null;

  const cleanupPc = () => {
    if (pc) {
      pc.close();
      pc = null;
    }
    opts.onStream(null);
  };

  const ensurePc = () => {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      opts.onStream(stream);
      opts.onStatus?.('connected');
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        signaling.send({
          type: 'ice',
          from: opts.viewerId,
          to: opts.hostId,
          candidate: ev.candidate.toJSON(),
        });
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc?.connectionState;
      if (s === 'connected') opts.onStatus?.('connected');
      else if (s === 'connecting') opts.onStatus?.('connecting');
      else if (s === 'failed' || s === 'disconnected') {
        opts.onStatus?.(s);
        if (s === 'failed') {
          cleanupPc();
          // re-request
          signaling.send({ type: 'need-stream', from: opts.viewerId });
        }
      }
    };
    return pc;
  };

  const start = async () => {
    await signaling.start();
    unsub = signaling.subscribe(async (msg) => {
      if (msg.type === 'offer' && msg.to === opts.viewerId) {
        try {
          cleanupPc();
          const peer = ensurePc();
          await peer.setRemoteDescription(msg.sdp);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          signaling.send({
            type: 'answer',
            from: opts.viewerId,
            to: msg.from,
            sdp: peer.localDescription!.toJSON(),
          });
          opts.onStatus?.('connecting');
        } catch (e) {
          console.error('handle offer', e);
          opts.onStatus?.('error');
        }
        return;
      }
      if (msg.type === 'ice' && msg.to === opts.viewerId) {
        if (pc && msg.candidate) {
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (msg.type === 'host-ready' && msg.from === opts.hostId) {
        signaling.send({ type: 'need-stream', from: opts.viewerId });
        opts.onStatus?.('requesting');
        return;
      }
      if (msg.type === 'goodbye' && msg.from === opts.hostId) {
        cleanupPc();
        opts.onStatus?.('host-left');
      }
    });

    // ask host for stream
    signaling.send({ type: 'need-stream', from: opts.viewerId });
    opts.onStatus?.('requesting');
  };

  const stop = () => {
    unsub?.();
    unsub = null;
    signaling.send({ type: 'goodbye', from: opts.viewerId });
    cleanupPc();
    signaling.stop();
  };

  return { start, stop };
}

/** Detect captureStream support. */
export function canCaptureStream(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  return typeof (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream === 'function'
    || typeof (video as HTMLVideoElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream === 'function';
}

export function captureVideoStream(video: HTMLVideoElement): MediaStream | null {
  const v = video as HTMLVideoElement & {
    captureStream?: (fps?: number) => MediaStream;
    mozCaptureStream?: (fps?: number) => MediaStream;
  };
  try {
    if (typeof v.captureStream === 'function') return v.captureStream();
    if (typeof v.mozCaptureStream === 'function') return v.mozCaptureStream();
  } catch (e) {
    console.error('captureStream failed', e);
  }
  return null;
}

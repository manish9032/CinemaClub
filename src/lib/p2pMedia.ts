/**
 * CinemaClub P2P media layer
 * --------------------------
 * Dynamic video chunking over WebRTC data channels + smart buffer.
 * Movie bytes are NEVER uploaded or stored in the database — only live P2P
 * transfer while the room is active, then discarded.
 *
 * Supported formats (best to worst):
 * - MP4 (H.264 + AAC) with faststart → best
 * - WebM (VP8/VP9) → good progressive play
 * - MKV → limited browser support (Chrome may fail)
 * - MOV → works in some browsers
 */

import { USE_LOCAL } from './mode';
import { supabase } from './supabase';

// ---- Tunables ----
const CHUNK_SIZE_DEFAULT = 32 * 1024; // 32 KB (better speed, still safe)
const CHUNK_SIZE_MIN = 16 * 1024;
const CHUNK_SIZE_MAX = 64 * 1024;
/** Start playback after this much data (higher = better MP4 compatibility) */
const PLAY_WHEN_BUFFERED = 4 * 1024 * 1024; // 4 MB
const BUFFER_HIGH_WATER = 12 * 1024 * 1024;
const BUFFER_LOW_WATER = 2 * 1024 * 1024;

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

// ---- Signaling (room-scoped) ----
export type P2PSignal =
  | { type: 'offer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: 'need-media'; from: string }
  | { type: 'host-media-ready'; from: string; fileName: string; fileSize: number; mime: string }
  | { type: 'goodbye'; from: string };

type Handler = (msg: P2PSignal) => void;

function createSignaling(roomId: string, userId: string) {
  const channelName = `cc-p2p:${roomId.toUpperCase()}`;
  const handlers = new Set<Handler>();
  let bc: BroadcastChannel | null = null;
  let sb: ReturnType<typeof supabase.channel> | null = null;
  let ready = false;

  const emit = (msg: P2PSignal) => {
    handlers.forEach((h) => {
      try {
        h(msg);
      } catch (e) {
        console.error('p2p signal', e);
      }
    });
  };

  const send = (msg: P2PSignal) => {
    if (USE_LOCAL) {
      bc?.postMessage(msg);
      return;
    }
    if (sb && ready) {
      void sb.send({ type: 'broadcast', event: 'p2p', payload: msg });
    }
  };

  const subscribe = (h: Handler) => {
    handlers.add(h);
    return () => handlers.delete(h);
  };

  const start = async () => {
    if (USE_LOCAL) {
      if (typeof BroadcastChannel === 'undefined') return;
      bc = new BroadcastChannel(channelName);
      bc.onmessage = (e) => {
        const msg = e.data as P2PSignal;
        if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
        if ('from' in msg && msg.from === userId) return;
        emit(msg);
      };
      ready = true;
      return;
    }
    sb = supabase.channel(channelName, { config: { broadcast: { self: false } } });
    sb.on('broadcast', { event: 'p2p' }, ({ payload }) => {
      const msg = payload as P2PSignal;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
      if ('from' in msg && msg.from === userId) return;
      emit(msg);
    });
    await new Promise<void>((resolve) => {
      sb!.subscribe((status) => {
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
    if (sb) {
      void supabase.removeChannel(sb);
      sb = null;
    }
    ready = false;
  };

  return { start, stop, send, subscribe };
}

// ---- Binary protocol ----
type DcControl =
  | {
      t: 'meta';
      fileName: string;
      fileSize: number;
      mime: string;
      chunkSize: number;
      totalChunks: number;
    }
  | { t: 'chunk'; index: number; offset: number; size: number }
  | { t: 'done' }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'request'; fromIndex: number }
  | { t: 'nack'; index: number };

function encodeChunkPacket(index: number, data: ArrayBuffer): ArrayBuffer {
  const header = new ArrayBuffer(8);
  const view = new DataView(header);
  view.setUint32(0, index);
  view.setUint32(4, data.byteLength);
  const out = new Uint8Array(8 + data.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(data), 8);
  return out.buffer;
}

function decodeChunkPacket(buf: ArrayBuffer): { index: number; data: ArrayBuffer } | null {
  if (buf.byteLength < 8) return null;
  const view = new DataView(buf);
  const index = view.getUint32(0);
  const size = view.getUint32(4);
  if (buf.byteLength < 8 + size) return null;
  return { index, data: buf.slice(8, 8 + size) };
}

function detectMime(file: File): string {
  if (file.type) return file.type;
  const n = file.name.toLowerCase();
  if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4';
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.mkv')) return 'video/x-matroska';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.avi')) return 'video/x-msvideo';
  if (n.endsWith('.flv')) return 'video/x-flv';
  return 'video/mp4';
}

export function codecHint(mime: string, fileName: string): string {
  const m = (mime || '').toLowerCase();
  const n = fileName.toLowerCase();
  if (m.includes('webm') || n.endsWith('.webm')) return 'VP8/VP9 (WebM) — good progressive support';
  if (n.endsWith('.mkv')) return 'MKV — limited support in Chrome. Prefer MP4 (H.264)';
  if (n.endsWith('.avi')) return 'AVI — poor browser support';
  return 'Prefer H.264 + AAC MP4 (faststart) for best compatibility';
}

// ---- Host ----
export function createP2PHost(opts: {
  roomId: string;
  hostId: string;
  file: File;
  onViewerCount?: (n: number) => void;
  onProgress?: (viewerId: string, sentBytes: number, total: number) => void;
}) {
  const file = opts.file;
  const mime = detectMime(file);
  const fileSize = file.size;
  let chunkSize = CHUNK_SIZE_DEFAULT;
  if (fileSize < 10 * 1024 * 1024) chunkSize = CHUNK_SIZE_MIN;
  if (fileSize > 1 * 1024 * 1024 * 1024) chunkSize = CHUNK_SIZE_MAX;
  const totalChunks = Math.ceil(fileSize / chunkSize) || 1;

  const signaling = createSignaling(opts.roomId, opts.hostId);
  const peers = new Map<
    string,
    {
      pc: RTCPeerConnection;
      dc: RTCDataChannel | null;
      paused: boolean;
      nextIndex: number;
      sending: boolean;
    }
  >();
  let unsub: (() => void) | null = null;
  let stopped = false;

  const closePeer = (id: string) => {
    const p = peers.get(id);
    if (!p) return;
    try {
      p.dc?.close();
    } catch {
      /* */
    }
    p.pc.close();
    peers.delete(id);
    opts.onViewerCount?.(peers.size);
  };

  const sendControl = (dc: RTCDataChannel, msg: DcControl) => {
    if (dc.readyState === 'open') dc.send(JSON.stringify(msg));
  };

  const pumpChunks = async (viewerId: string) => {
    const p = peers.get(viewerId);
    if (!p || !p.dc || p.dc.readyState !== 'open' || p.sending || stopped) return;
    p.sending = true;
    try {
      while (!p.paused && p.nextIndex < totalChunks && p.dc.readyState === 'open') {
        while (p.dc.bufferedAmount > 4 * 1024 * 1024) {
          await new Promise((r) => setTimeout(r, 30));
          if (stopped || p.paused || p.dc.readyState !== 'open') break;
        }
        if (p.paused || p.dc.readyState !== 'open') break;

        const index = p.nextIndex;
        const offset = index * chunkSize;
        const size = Math.min(chunkSize, fileSize - offset);
        const blob = file.slice(offset, offset + size);
        const buf = await blob.arrayBuffer();
        if (stopped) break;

        sendControl(p.dc, { t: 'chunk', index, offset, size });
        p.dc.send(encodeChunkPacket(index, buf));
        p.nextIndex = index + 1;
        opts.onProgress?.(viewerId, Math.min(fileSize, p.nextIndex * chunkSize), fileSize);
      }
      if (p.nextIndex >= totalChunks && p.dc.readyState === 'open') {
        sendControl(p.dc, { t: 'done' });
      }
    } catch (e) {
      console.error('pumpChunks', e);
    } finally {
      p.sending = false;
    }
  };

  const setupDataChannel = (viewerId: string, dc: RTCDataChannel) => {
    const p = peers.get(viewerId);
    if (!p) return;
    p.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      sendControl(dc, {
        t: 'meta',
        fileName: file.name,
        fileSize,
        mime,
        chunkSize,
        totalChunks,
      });
      void pumpChunks(viewerId);
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const msg = JSON.parse(ev.data) as DcControl;
        if (msg.t === 'pause') p.paused = true;
        else if (msg.t === 'resume') {
          p.paused = false;
          void pumpChunks(viewerId);
        } else if (msg.t === 'request') {
          p.nextIndex = Math.max(0, msg.fromIndex);
          p.paused = false;
          void pumpChunks(viewerId);
        } else if (msg.t === 'nack') {
          void (async () => {
            const offset = msg.index * chunkSize;
            const size = Math.min(chunkSize, fileSize - offset);
            const blob = file.slice(offset, offset + size);
            const buf = await blob.arrayBuffer();
            sendControl(dc, { t: 'chunk', index: msg.index, offset, size });
            dc.send(encodeChunkPacket(msg.index, buf));
          })();
        }
      } catch {
        /* */
      }
    };
  };

  const makePeer = async (viewerId: string) => {
    if (peers.has(viewerId) || stopped) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = {
      pc,
      dc: null as RTCDataChannel | null,
      paused: false,
      nextIndex: 0,
      sending: false,
    };
    peers.set(viewerId, entry);
    opts.onViewerCount?.(peers.size);

    const dc = pc.createDataChannel('media', { ordered: true });
    setupDataChannel(viewerId, dc);

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
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closePeer(viewerId);
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signaling.send({
        type: 'offer',
        from: opts.hostId,
        to: viewerId,
        sdp: pc.localDescription!.toJSON(),
      });
    } catch (e) {
      console.error('p2p offer', e);
      closePeer(viewerId);
    }
  };

  const start = async () => {
    await signaling.start();
    unsub = signaling.subscribe(async (msg) => {
      if (msg.type === 'need-media') {
        void makePeer(msg.from);
        return;
      }
      if (msg.type === 'answer' && msg.to === opts.hostId) {
        const p = peers.get(msg.from);
        if (p && !p.pc.currentRemoteDescription) {
          try {
            await p.pc.setRemoteDescription(msg.sdp);
          } catch (e) {
            console.error(e);
          }
        }
        return;
      }
      if (msg.type === 'ice' && msg.to === opts.hostId) {
        const p = peers.get(msg.from);
        if (p && msg.candidate) {
          try {
            await p.pc.addIceCandidate(msg.candidate);
          } catch {
            /* */
          }
        }
        return;
      }
      if (msg.type === 'goodbye') closePeer(msg.from);
    });

    signaling.send({
      type: 'host-media-ready',
      from: opts.hostId,
      fileName: file.name,
      fileSize,
      mime,
    });
  };

  const stop = () => {
    stopped = true;
    unsub?.();
    unsub = null;
    peers.forEach((_, id) => closePeer(id));
    signaling.send({ type: 'goodbye', from: opts.hostId });
    signaling.stop();
  };

  return {
    start,
    stop,
    offerTo: (viewerId: string) => void makePeer(viewerId),
    peerCount: () => peers.size,
    fileName: file.name,
    fileSize,
    mime,
    codecHint: codecHint(mime, file.name),
  };
}

// ---- Viewer ----
export function createP2PViewer(opts: {
  roomId: string;
  viewerId: string;
  hostId: string;
  onPlayableUrl: (url: string | null, info?: { fileName: string; mime: string; complete: boolean }) => void;
  onStatus?: (status: string) => void;
  onBufferProgress?: (receivedBytes: number, totalBytes: number) => void;
}) {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  const signaling = createSignaling(opts.roomId, opts.viewerId);
  let unsub: (() => void) | null = null;
  let objectUrl: string | null = null;

  let meta: {
    fileName: string;
    fileSize: number;
    mime: string;
    chunkSize: number;
    totalChunks: number;
  } | null = null;
  const chunks = new Map<number, ArrayBuffer>();
  let receivedBytes = 0;
  let playableEmitted = false;
  let complete = false;
  let pausedDownload = false;

  const revokeUrl = () => {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  };

  const rebuildBlobUrl = (forceComplete = false) => {
    if (!meta) return;
    const ordered: BlobPart[] = [];
    for (let i = 0; i < meta.totalChunks; i++) {
      const c = chunks.get(i);
      if (!c) break;
      ordered.push(c);
    }
    const contiguousBytes = ordered.reduce((n, b) => n + (b as ArrayBuffer).byteLength, 0);
    const haveAll = chunks.size >= meta.totalChunks;
    complete = haveAll;

    const shouldPlay =
      forceComplete ||
      haveAll ||
      (!playableEmitted && contiguousBytes >= Math.min(PLAY_WHEN_BUFFERED, meta.fileSize));

    if (!shouldPlay && !playableEmitted) return;
    if (ordered.length === 0) return;

    revokeUrl();
    const blob = new Blob(ordered, { type: meta.mime || 'video/mp4' });
    objectUrl = URL.createObjectURL(blob);
    playableEmitted = true;
    opts.onPlayableUrl(objectUrl, {
      fileName: meta.fileName,
      mime: meta.mime,
      complete: haveAll,
    });
  };

  const maybeBackpressure = () => {
    if (!dc || dc.readyState !== 'open' || !meta) return;
    if (!pausedDownload && receivedBytes > BUFFER_HIGH_WATER && !complete) {
      pausedDownload = true;
      dc.send(JSON.stringify({ t: 'pause' } satisfies DcControl));
    } else if (pausedDownload && receivedBytes < BUFFER_LOW_WATER) {
      pausedDownload = false;
      dc.send(JSON.stringify({ t: 'resume' } satisfies DcControl));
    }
  };

  const reportPlayerBuffer = (bufferedAheadSeconds: number) => {
    if (!dc || dc.readyState !== 'open') return;
    if (bufferedAheadSeconds > 40 && !pausedDownload && !complete) {
      pausedDownload = true;
      dc.send(JSON.stringify({ t: 'pause' } satisfies DcControl));
    } else if (bufferedAheadSeconds < 10 && pausedDownload) {
      pausedDownload = false;
      dc.send(JSON.stringify({ t: 'resume' } satisfies DcControl));
    }
  };

  const handleControl = (raw: string) => {
    try {
      const msg = JSON.parse(raw) as DcControl;
      if (msg.t === 'meta') {
        meta = {
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          mime: msg.mime,
          chunkSize: msg.chunkSize,
          totalChunks: msg.totalChunks,
        };
        opts.onStatus?.('receiving');
        return;
      }
      if (msg.t === 'done') {
        complete = true;
        rebuildBlobUrl(true);
        opts.onStatus?.('complete');
        return;
      }
    } catch {
      /* */
    }
  };

  const handleBinary = (buf: ArrayBuffer) => {
    const parsed = decodeChunkPacket(buf);
    if (!parsed || !meta) return;
    if (chunks.has(parsed.index)) return;
    chunks.set(parsed.index, parsed.data);
    receivedBytes += parsed.data.byteLength;
    opts.onBufferProgress?.(receivedBytes, meta.fileSize);
    if (!playableEmitted && receivedBytes >= Math.min(PLAY_WHEN_BUFFERED, meta.fileSize)) {
      rebuildBlobUrl();
    } else if (playableEmitted) {
      if (parsed.index % 32 === 0) rebuildBlobUrl();
    }
    if (chunks.size >= meta.totalChunks) {
      complete = true;
      rebuildBlobUrl(true);
      opts.onStatus?.('complete');
    }
    maybeBackpressure();
  };

  const wireDc = (channel: RTCDataChannel) => {
    dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') handleControl(ev.data);
      else if (ev.data instanceof ArrayBuffer) handleBinary(ev.data);
      else if (ev.data instanceof Blob) {
        void ev.data.arrayBuffer().then(handleBinary);
      }
    };
    channel.onclose = () => opts.onStatus?.('channel-closed');
  };

  const ensurePc = () => {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.ondatachannel = (ev) => wireDc(ev.channel);
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
      else if (s === 'failed') {
        opts.onStatus?.('failed');
        signaling.send({ type: 'need-media', from: opts.viewerId });
      }
    };
    return pc;
  };

  const start = async () => {
    await signaling.start();
    unsub = signaling.subscribe(async (msg) => {
      if (msg.type === 'offer' && msg.to === opts.viewerId) {
        try {
          if (pc) {
            pc.close();
            pc = null;
          }
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
          console.error(e);
          opts.onStatus?.('error');
        }
        return;
      }
      if (msg.type === 'ice' && msg.to === opts.viewerId) {
        if (pc && msg.candidate) {
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch {
            /* */
          }
        }
        return;
      }
      if (msg.type === 'host-media-ready' && msg.from === opts.hostId) {
        signaling.send({ type: 'need-media', from: opts.viewerId });
        opts.onStatus?.('requesting');
        return;
      }
      if (msg.type === 'goodbye' && msg.from === opts.hostId) {
        cleanup();
        opts.onStatus?.('host-left');
        opts.onPlayableUrl(null);
      }
    });
    signaling.send({ type: 'need-media', from: opts.viewerId });
    opts.onStatus?.('requesting');
  };

  const cleanup = () => {
    try {
      dc?.close();
    } catch {
      /* */
    }
    dc = null;
    pc?.close();
    pc = null;
    chunks.clear();
    receivedBytes = 0;
    playableEmitted = false;
    complete = false;
    revokeUrl();
  };

  const stop = () => {
    unsub?.();
    unsub = null;
    signaling.send({ type: 'goodbye', from: opts.viewerId });
    cleanup();
    signaling.stop();
  };

  return { start, stop, reportPlayerBuffer };
}

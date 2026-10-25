/**
 * Local-only backend (no Supabase).
 * Data lives in localStorage. Realtime across tabs via BroadcastChannel.
 * Perfect for demos / offline / no-cloud setup.
 */

import type { Room, Participant, RoomMessage } from '../services/rooms';

const KEYS = {
  users: 'cc_local_users',
  session: 'cc_local_session',
  rooms: 'cc_local_rooms',
  participants: 'cc_local_participants',
  messages: 'cc_local_messages',
};

const CHANNEL_NAME = 'cinemaclub-local';

export type LocalUser = {
  id: string;
  email: string;
  password: string; // SHA-256 hex hash (never store plain)
  display_name: string;
};

type StoreShape = {
  rooms: Room[];
  participants: Participant[];
  messages: RoomMessage[];
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getStore(): StoreShape {
  return {
    rooms: read<Room[]>(KEYS.rooms, []),
    participants: read<Participant[]>(KEYS.participants, []),
    messages: read<RoomMessage[]>(KEYS.messages, []),
  };
}

function setStore(partial: Partial<StoreShape>) {
  const current = getStore();
  const next = { ...current, ...partial };
  if (partial.rooms) write(KEYS.rooms, next.rooms);
  if (partial.participants) write(KEYS.participants, next.participants);
  if (partial.messages) write(KEYS.messages, next.messages);
  broadcast({ type: 'store', data: next });
}

// ---- Realtime bus ----
type BusEvent =
  | { type: 'store'; data: StoreShape }
  | { type: 'room'; room: Room | null; roomId: string }
  | { type: 'participants'; roomId: string }
  | { type: 'messages'; roomId: string; message?: RoomMessage };

type Listener = (ev: BusEvent) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function getChannel() {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e) => {
      const ev = e.data as BusEvent;
      listeners.forEach((l) => l(ev));
    };
  }
  return channel;
}

function broadcast(ev: BusEvent) {
  getChannel()?.postMessage(ev);
  // also notify same-tab listeners
  listeners.forEach((l) => l(ev));
}

export function subscribeLocal(listener: Listener): () => void {
  getChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---- Auth ----
export function localGetUsers(): LocalUser[] {
  return read<LocalUser[]>(KEYS.users, []);
}

export function localSaveUsers(users: LocalUser[]) {
  write(KEYS.users, users);
}

export function localGetSession(): LocalUser | null {
  return read<LocalUser | null>(KEYS.session, null);
}

export function localSetSession(user: LocalUser | null) {
  if (user) write(KEYS.session, user);
  else localStorage.removeItem(KEYS.session);
}

async function sha256(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function localSignUp(email: string, password: string, displayName: string): Promise<{ user?: LocalUser; error?: string }> {
  const users = localGetUsers();
  if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return { error: 'Email already registered (local).' };
  }
  if (password.length < 6) return { error: 'Password must be at least 6 characters.' };
  const user: LocalUser = {
    id: crypto.randomUUID(),
    email: email.trim().toLowerCase(),
    password: await sha256(password),
    display_name: displayName.trim() || email.split('@')[0],
  };
  users.push(user);
  localSaveUsers(users);
  localSetSession({ ...user, password: '***' }); // never keep hash in session object long-term beyond id
  // session stores full user minus we still need id/email/name — strip hash from session
  localSetSession({ ...user, password: '' });
  return { user: { ...user, password: '' } };
}

export async function localSignIn(email: string, password: string): Promise<{ user?: LocalUser; error?: string }> {
  const users = localGetUsers();
  const hashed = await sha256(password);
  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return { error: 'Invalid email or password (local).' };
  // support legacy plain-text from older builds
  const ok = user.password === hashed || user.password === password;
  if (!ok) return { error: 'Invalid email or password (local).' };
  const safe = { ...user, password: '' };
  localSetSession(safe);
  return { user: safe };
}

export function localSignOut() {
  localSetSession(null);
}

// ---- Rooms API (mirrors services/rooms.ts) ----
function uid() {
  return crypto.randomUUID();
}

export function localGetMyActiveRoom(userId: string): Room | null {
  const { rooms } = getStore();
  const now = Date.now();
  return rooms.find((r) => r.host_id === userId && new Date(r.expires_at).getTime() > now) ?? null;
}

export function localCreateRoom(
  userId: string,
  hostName: string,
  passwordHash: string,
  roomId: string,
  expiresAt: string,
  options?: { movieId?: number; movieTitle?: string; moviePoster?: string }
): { room: Room; error?: string } {
  const existing = localGetMyActiveRoom(userId);
  if (existing) {
    return { room: existing, error: 'You already have an active room. Delete it first to create a new one.' };
  }

  const room: Room = {
    id: roomId,
    password_hash: passwordHash,
    host_id: userId,
    host_name: hostName.trim(),
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    movie_id: options?.movieId ?? null,
    movie_title: options?.movieTitle ?? null,
    movie_poster: options?.moviePoster ?? null,
    is_playing: false,
    current_time: 0,
    last_sync_at: new Date().toISOString(),
    video_src_type: null,
    video_src: null,
    local_file_name: null,
  };

  const store = getStore();
  store.rooms = [...store.rooms.filter((r) => r.id !== roomId), room];
  store.participants = [
    ...store.participants.filter((p) => !(p.room_id === roomId && p.user_id === userId)),
    {
      id: uid(),
      room_id: roomId,
      user_id: userId,
      name: hostName.trim(),
      is_host: true,
      is_active: true,
      joined_at: new Date().toISOString(),
    },
  ];
  store.messages = [
    ...store.messages,
    {
      id: uid(),
      room_id: roomId,
      participant_id: null,
      participant_name: 'System',
      text: `${hostName.trim()} created the room`,
      type: 'system',
      created_at: new Date().toISOString(),
    },
  ];
  setStore(store);
  broadcast({ type: 'room', room, roomId });
  return { room };
}

export function localJoinRoom(
  roomId: string,
  passwordHash: string,
  userId: string,
  displayName: string
): { room: Room | null; error?: string } {
  const id = roomId.toUpperCase();
  const store = getStore();
  const room = store.rooms.find((r) => r.id === id) ?? null;
  if (!room) return { room: null, error: 'Room not found.' };
  if (new Date(room.expires_at) < new Date()) return { room: null, error: 'This room has expired.' };
  if (room.password_hash !== passwordHash) return { room: null, error: 'Incorrect password.' };

  const others = store.participants.filter((p) => !(p.room_id === id && p.user_id === userId));
  const participant: Participant = {
    id: uid(),
    room_id: id,
    user_id: userId,
    name: displayName.trim(),
    is_host: room.host_id === userId,
    is_active: true,
    joined_at: new Date().toISOString(),
  };
  const msg: RoomMessage = {
    id: uid(),
    room_id: id,
    participant_id: userId,
    participant_name: 'System',
    text: `${displayName.trim()} joined the room`,
    type: 'system',
    created_at: new Date().toISOString(),
  };
  setStore({
    participants: [...others, participant],
    messages: [...store.messages, msg],
  });
  broadcast({ type: 'participants', roomId: id });
  broadcast({ type: 'messages', roomId: id, message: msg });
  return { room };
}

export function localGetRoom(roomId: string): Room | null {
  const id = roomId.toUpperCase();
  const room = getStore().rooms.find((r) => r.id === id) ?? null;
  if (!room) return null;
  if (new Date(room.expires_at) < new Date()) return null;
  return room;
}

export function localDeleteRoom(roomId: string, userId: string): { error?: string } {
  const id = roomId.toUpperCase();
  const store = getStore();
  const room = store.rooms.find((r) => r.id === id);
  if (!room || room.host_id !== userId) return { error: 'Only the host can delete the room.' };
  setStore({
    rooms: store.rooms.filter((r) => r.id !== id),
    participants: store.participants.filter((p) => p.room_id !== id),
    messages: store.messages.filter((m) => m.room_id !== id),
  });
  broadcast({ type: 'room', room: null, roomId: id });
  return {};
}

export function localLeaveRoom(roomId: string, userId: string) {
  const id = roomId.toUpperCase();
  const store = getStore();
  const p = store.participants.find((x) => x.room_id === id && x.user_id === userId);
  const participants = store.participants.map((x) =>
    x.room_id === id && x.user_id === userId ? { ...x, is_active: false } : x
  );
  let messages = store.messages;
  if (p) {
    const msg: RoomMessage = {
      id: uid(),
      room_id: id,
      participant_id: userId,
      participant_name: 'System',
      text: `${p.name} left the room`,
      type: 'system',
      created_at: new Date().toISOString(),
    };
    messages = [...messages, msg];
    broadcast({ type: 'messages', roomId: id, message: msg });
  }
  setStore({ participants, messages });
  broadcast({ type: 'participants', roomId: id });
}

/** Re-activate a participant after page refresh (keeps them in the room). */
export function localReactivateParticipant(
  roomId: string,
  userId: string,
  displayName: string
): void {
  const id = roomId.toUpperCase();
  const store = getStore();
  const room = store.rooms.find((r) => r.id === id);
  if (!room) return;
  if (new Date(room.expires_at) < new Date()) return;

  const existing = store.participants.find((p) => p.room_id === id && p.user_id === userId);
  if (existing && existing.is_active) return;

  const others = store.participants.filter((p) => !(p.room_id === id && p.user_id === userId));
  const participant: Participant = {
    id: existing?.id ?? uid(),
    room_id: id,
    user_id: userId,
    name: displayName.trim() || existing?.name || 'User',
    is_host: room.host_id === userId,
    is_active: true,
    joined_at: existing?.joined_at ?? new Date().toISOString(),
  };
  setStore({ participants: [...others, participant] });
  broadcast({ type: 'participants', roomId: id });
}

export function localGetParticipants(roomId: string): Participant[] {
  const id = roomId.toUpperCase();
  return getStore()
    .participants.filter((p) => p.room_id === id && p.is_active)
    .sort((a, b) => a.joined_at.localeCompare(b.joined_at));
}

export function localGetMessages(roomId: string, limit = 100): RoomMessage[] {
  const id = roomId.toUpperCase();
  return getStore()
    .messages.filter((m) => m.room_id === id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-limit);
}

export function localSendMessage(
  roomId: string,
  userId: string,
  participantName: string,
  text: string
): RoomMessage | null {
  const id = roomId.toUpperCase();
  const msg: RoomMessage = {
    id: uid(),
    room_id: id,
    participant_id: userId,
    participant_name: participantName,
    text: text.trim(),
    type: 'message',
    created_at: new Date().toISOString(),
  };
  const store = getStore();
  setStore({ messages: [...store.messages, msg] });
  broadcast({ type: 'messages', roomId: id, message: msg });
  return msg;
}

export function localSyncPlayback(roomId: string, userId: string, isPlaying: boolean, currentTime: number) {
  const id = roomId.toUpperCase();
  const store = getStore();
  const room = store.rooms.find((r) => r.id === id);
  const isActiveMember = store.participants.some((p) => p.room_id === id && p.user_id === userId && p.is_active);
  if (!room || !isActiveMember) return;
  const updated: Room = {
    ...room,
    is_playing: isPlaying,
    current_time: currentTime,
    last_sync_at: new Date().toISOString(),
  };
  setStore({ rooms: store.rooms.map((r) => (r.id === id ? updated : r)) });
  broadcast({ type: 'room', room: updated, roomId: id });
}

export function localSetVideoSource(
  roomId: string,
  userId: string,
  srcType: 'stream' | 'local' | 'youtube',
  streamUrl?: string,
  localFileName?: string
): { error?: string } {
  const id = roomId.toUpperCase();
  const store = getStore();
  const room = store.rooms.find((r) => r.id === id);
  if (!room || room.host_id !== userId) return { error: 'Only the host can change the video source.' };

  const updated: Room = {
    ...room,
    video_src_type: srcType,
    video_src: srcType === 'stream' || srcType === 'youtube' ? streamUrl || null : null,
    local_file_name: srcType === 'local' ? localFileName || null : null,
    last_sync_at: new Date().toISOString(),
  };
  const msg: RoomMessage = {
    id: uid(),
    room_id: id,
    participant_id: null,
    participant_name: 'System',
    text:
      srcType === 'local'
        ? `Host is sharing a local file: "${localFileName}"`
        : srcType === 'youtube'
          ? `Host set a YouTube video`
          : `Host set a stream source`,
    type: 'system',
    created_at: new Date().toISOString(),
  };
  setStore({
    rooms: store.rooms.map((r) => (r.id === id ? updated : r)),
    messages: [...store.messages, msg],
  });
  broadcast({ type: 'room', room: updated, roomId: id });
  broadcast({ type: 'messages', roomId: id, message: msg });
  return {};
}

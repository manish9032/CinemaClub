import { supabase } from '../lib/supabase';
import { hashPassword, genRoomId, grantRoomAccess } from '../utils/hash';
import { USE_LOCAL } from '../lib/mode';
import * as local from '../lib/localStore';

const ROOM_TTL_HOURS = 48;

// Never select password_hash from the client-facing rooms table. The column is
// intentionally withheld by the Supabase grants in supabase-schema.sql.
const SAFE_ROOM_COLUMNS = 'id,host_id,host_name,created_at,expires_at,movie_id,movie_title,movie_poster,is_playing,current_time,last_sync_at,video_src_type,video_src,local_file_name' as const;

export interface Room {
  id: string;
  password_hash?: string;
  host_id: string;
  host_name: string;
  created_at: string;
  expires_at: string;
  movie_id: number | null;
  movie_title: string | null;
  movie_poster: string | null;
  is_playing: boolean;
  current_time: number;
  last_sync_at: string;
  /** stream = direct mp4/hls URL; local = P2P file; youtube = YouTube video id/url in video_src */
  video_src_type: 'stream' | 'local' | 'youtube' | null;
  video_src: string | null;
  local_file_name: string | null;
}

export interface Participant {
  id: string;
  room_id: string;
  user_id: string;
  name: string;
  is_host: boolean;
  is_active: boolean;
  joined_at: string;
}

export interface RoomMessage {
  id: string;
  room_id: string;
  participant_id: string | null;
  participant_name: string;
  text: string;
  type: 'message' | 'system';
  created_at: string;
}

/** Check if current user already has an active room */
export async function getMyActiveRoom(userId: string): Promise<Room | null> {
  if (USE_LOCAL) return local.localGetMyActiveRoom(userId);

  const { data, error } = await supabase
    .from('rooms')
    .select(SAFE_ROOM_COLUMNS)
    .eq('host_id', userId)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) {
    console.error('getMyActiveRoom', error);
    return null;
  }
  return data as Room | null;
}

/** Create a private room. Enforces one room per user. */
export async function createRoom(
  userId: string,
  hostName: string,
  password: string,
  options?: { movieId?: number; movieTitle?: string; moviePoster?: string }
): Promise<{ room: Room; error?: string }> {
  const roomId = genRoomId();
  const now = new Date();
  const expires = new Date(now.getTime() + ROOM_TTL_HOURS * 60 * 60 * 1000);

  if (USE_LOCAL) {
    const passwordHash = await hashPassword(password);
    const result = local.localCreateRoom(userId, hostName, passwordHash, roomId, expires.toISOString(), options);
    if (!result.error) grantRoomAccess(roomId);
    return result;
  }

  const { data, error } = await (supabase as any).rpc('create_room', {
    p_room_id: roomId,
    p_password: password,
    p_host_name: hostName.trim(),
    p_movie_id: options?.movieId ?? null,
    p_movie_title: options?.movieTitle ?? null,
    p_movie_poster: options?.moviePoster ?? null,
  });

  if (error || !data || typeof data !== 'object') {
    console.error('createRoom', error);
    return { room: null as unknown as Room, error: error?.message || 'Could not create room.' };
  }

  const room = data as Room;
  grantRoomAccess(roomId);
  return { room };
}

/** Join a room with password */
export async function joinRoom(
  roomId: string,
  password: string,
  userId: string,
  displayName: string
): Promise<{ room: Room | null; error?: string }> {
  if (USE_LOCAL) {
    const passwordHash = await hashPassword(password);
    const result = local.localJoinRoom(roomId, passwordHash, userId, displayName);
    if (result.room && !result.error) grantRoomAccess(roomId);
    return result;
  }

  const id = roomId.toUpperCase();
  const { data, error } = await (supabase as any).rpc('join_room_with_password', {
    p_room_id: id,
    p_password: password,
    p_display_name: displayName.trim(),
  });

  if (error || !data || typeof data !== 'object') {
    // Do not disclose whether a room code exists separately from password validity.
    return { room: null, error: 'Room not found, expired, or password is incorrect.' };
  }

  const room = data as Room;
  grantRoomAccess(id);
  return { room };
}

export async function getRoom(roomId: string): Promise<Room | null> {
  if (USE_LOCAL) return local.localGetRoom(roomId);

  const { data, error } = await supabase
    .from('rooms')
    .select(SAFE_ROOM_COLUMNS)
    .eq('id', roomId.toUpperCase())
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return data as Room;
}

export async function deleteRoom(roomId: string, userId: string): Promise<{ error?: string }> {
  if (USE_LOCAL) return local.localDeleteRoom(roomId, userId);

  const { data: room } = await supabase
    .from('rooms')
    .select('host_id')
    .eq('id', roomId.toUpperCase())
    .maybeSingle();

  if (!room || room.host_id !== userId) {
    return { error: 'Only the host can delete the room.' };
  }

  const { error } = await supabase.from('rooms').delete().eq('id', roomId.toUpperCase());
  if (error) return { error: error.message };
  return {};
}

export async function leaveRoom(roomId: string, userId: string): Promise<void> {
  if (USE_LOCAL) {
    local.localLeaveRoom(roomId, userId);
    return;
  }

  await supabase
    .from('room_participants')
    .update({ is_active: false })
    .eq('room_id', roomId.toUpperCase())
    .eq('user_id', userId);
}

/** After refresh: mark user active again if they already had access / are host. */
export async function reactivateParticipant(
  roomId: string,
  userId: string,
  displayName: string,
  _isHost = false
): Promise<void> {
  if (USE_LOCAL) {
    local.localReactivateParticipant(roomId, userId, displayName);
    return;
  }

  const id = roomId.toUpperCase();
  // Only reactivate an existing participant row. Creating membership must go
  // through join_room_with_password so a direct table write cannot bypass the password.
  await supabase
    .from('room_participants')
    .update({ is_active: true })
    .eq('room_id', id)
    .eq('user_id', userId);
}

export async function getParticipants(roomId: string): Promise<Participant[]> {
  if (USE_LOCAL) return local.localGetParticipants(roomId);

  const { data } = await supabase
    .from('room_participants')
    .select('*')
    .eq('room_id', roomId.toUpperCase())
    .eq('is_active', true)
    .order('joined_at', { ascending: true });
  return (data as Participant[]) || [];
}

export async function getMessages(roomId: string, limit = 100): Promise<RoomMessage[]> {
  if (USE_LOCAL) return local.localGetMessages(roomId, limit);

  const { data } = await supabase
    .from('room_messages')
    .select('*')
    .eq('room_id', roomId.toUpperCase())
    .order('created_at', { ascending: true })
    .limit(limit);
  return (data as RoomMessage[]) || [];
}

export async function sendMessage(
  roomId: string,
  userId: string,
  participantName: string,
  text: string
): Promise<RoomMessage | null> {
  const cleanText = text.trim();
  if (!cleanText || cleanText.length > 1000) return null;
  if (USE_LOCAL) return local.localSendMessage(roomId, userId, participantName, cleanText);

  const { data, error } = await supabase
    .from('room_messages')
    .insert({
      room_id: roomId.toUpperCase(),
      participant_id: userId,
      participant_name: participantName,
      text: cleanText,
      type: 'message',
    })
    .select()
    .single();

  if (error) {
    console.error('sendMessage', error);
    return null;
  }
  return data as RoomMessage;
}

export async function syncPlayback(
  roomId: string,
  userId: string,
  isPlaying: boolean,
  currentTime: number
): Promise<void> {
  if (USE_LOCAL) {
    local.localSyncPlayback(roomId, userId, isPlaying, currentTime);
    return;
  }

  const { error } = await (supabase as any).rpc('sync_room_playback', {
    p_room_id: roomId.toUpperCase(),
    p_is_playing: isPlaying,
    p_current_time: Math.max(0, Number.isFinite(currentTime) ? currentTime : 0),
  });
  if (error) console.error('syncPlayback', error);
}

export async function setVideoSource(
  roomId: string,
  userId: string,
  srcType: 'stream' | 'local' | 'youtube',
  streamUrl?: string,
  localFileName?: string
): Promise<{ error?: string }> {
  if (USE_LOCAL) {
    return local.localSetVideoSource(roomId, userId, srcType, streamUrl, localFileName);
  }

  const { data: room } = await supabase
    .from('rooms')
    .select('host_id')
    .eq('id', roomId.toUpperCase())
    .maybeSingle();

  if (!room || room.host_id !== userId) {
    return { error: 'Only the host can change the video source.' };
  }

  const update: Partial<Room> = {
    video_src_type: srcType,
    last_sync_at: new Date().toISOString(),
  };

  if (srcType === 'stream' || srcType === 'youtube') {
    update.video_src = streamUrl || null;
    update.local_file_name = null;
  } else {
    update.local_file_name = localFileName || null;
    update.video_src = null;
  }

  const { error } = await supabase
    .from('rooms')
    .update(update)
    .eq('id', roomId.toUpperCase());

  if (error) return { error: error.message };

  return {};
}

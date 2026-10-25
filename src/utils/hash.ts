/** Room code helpers + password hashing (SHA-256 via Web Crypto). */

export function genRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // Use Web Crypto so room IDs are not based on Math.random(). Room IDs are
  // identifiers, not authorization credentials; server-side membership still protects rooms.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join('');
}

export function validateRoomId(id: string): boolean {
  return /^[A-HJ-NP-Z2-9]{6}$/.test(id.toUpperCase());
}

/** Async SHA-256 hex hash for passwords (room + local auth). */
export async function hashPassword(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** @deprecated Use hashPassword — kept only for reading very old local data */
export function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = (h << 5) - h + c;
    h |= 0;
  }
  return Math.abs(h).toString(36).padStart(8, '0');
}

/**
 * Room access grant — stored in localStorage so it survives page refresh.
 * Valid for 24 hours (aligned with room TTL). Password is still required
 * the first time; after that, refresh keeps you in the room.
 */
const GRANT_PREFIX = 'cc_room_grant_';
const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export function grantRoomAccess(roomId: string) {
  try {
    const key = GRANT_PREFIX + roomId.toUpperCase();
    const payload = JSON.stringify({ at: Date.now() });
    localStorage.setItem(key, payload);
    // Also write sessionStorage for same-tab consistency
    sessionStorage.setItem(key, payload);
  } catch { /* private mode */ }
}

export function hasRoomAccess(roomId: string): boolean {
  try {
    const key = GRANT_PREFIX + roomId.toUpperCase();
    const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
    if (!raw) return false;
    try {
      const { at } = JSON.parse(raw) as { at: number };
      if (Date.now() - at > GRANT_TTL_MS) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
        return false;
      }
      return true;
    } catch {
      // legacy plain timestamp string
      const at = Number(raw);
      if (!at || Date.now() - at > GRANT_TTL_MS) return false;
      return true;
    }
  } catch {
    return false;
  }
}

export function revokeRoomAccess(roomId: string) {
  try {
    const key = GRANT_PREFIX + roomId.toUpperCase();
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } catch { /* */ }
}

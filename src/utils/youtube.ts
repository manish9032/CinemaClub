/** Parse YouTube video ID from common URL / share formats. */

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function extractYouTubeId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ID_RE.test(raw)) return raw;

  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = url.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id && ID_RE.test(id) ? id : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = url.searchParams.get('v');
      if (v && ID_RE.test(v)) return v;

      // /embed/ID, /shorts/ID, /live/ID, /v/ID
      const parts = url.pathname.split('/').filter(Boolean);
      const markers = ['embed', 'shorts', 'live', 'v', 'watch'];
      for (let i = 0; i < parts.length; i++) {
        if (markers.includes(parts[i]) && parts[i + 1] && ID_RE.test(parts[i + 1])) {
          return parts[i + 1];
        }
      }
    }
  } catch {
    /* not a URL */
  }

  // Fallback: find 11-char token
  const m = raw.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:[&?#/]|$)/);
  return m && ID_RE.test(m[1]) ? m[1] : null;
}

export function youtubeThumb(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

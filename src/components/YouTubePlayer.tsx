import { useEffect, useRef, useState, useCallback } from 'react';

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId: string;
          width?: string | number;
          height?: string | number;
          playerVars?: Record<string, number | string>;
          events?: {
            onReady?: (e: { target: YTPlayer }) => void;
            onStateChange?: (e: { data: number; target: YTPlayer }) => void;
            onError?: (e: { data: number }) => void;
          };
        }
      ) => YTPlayer;
      PlayerState: {
        UNSTARTED: number;
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YTPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  mute: () => void;
  unMute: () => void;
  setVolume: (v: number) => void;
  destroy: () => void;
};

type Props = {
  videoId: string;
  /** Apply external room sync (viewers + host after remote update) */
  externalTime?: number;
  externalPlaying?: boolean;
  /** Host (or any controller) reports local play state */
  onPlayState?: (playing: boolean, time: number) => void;
  onReady?: (duration: number) => void;
  className?: string;
};

let apiPromise: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      document.head.appendChild(tag);
    }
    // Poll in case API already loading
    const t = setInterval(() => {
      if (window.YT?.Player) {
        clearInterval(t);
        resolve();
      }
    }, 100);
  });
  return apiPromise;
}

export default function YouTubePlayer({
  videoId,
  externalTime,
  externalPlaying,
  onPlayState,
  onReady,
  className = '',
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const syncing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const onPlayStateRef = useRef(onPlayState);
  const onReadyRef = useRef(onReady);
  onPlayStateRef.current = onPlayState;
  onReadyRef.current = onReady;

  const report = useCallback(() => {
    const p = playerRef.current;
    if (!p || syncing.current) return;
    try {
      const state = p.getPlayerState();
      const playing = state === 1; // PLAYING
      onPlayStateRef.current?.(playing, p.getCurrentTime() || 0);
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    let destroyed = false;
    let player: YTPlayer | null = null;

    (async () => {
      setError(null);
      await loadYouTubeApi();
      if (destroyed || !mountRef.current || !window.YT?.Player) return;

      // Clear previous iframe
      mountRef.current.innerHTML = '';
      const el = document.createElement('div');
      mountRef.current.appendChild(el);

      player = new window.YT.Player(el, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          origin: typeof window !== 'undefined' ? window.location.origin : '',
        },
        events: {
          onReady: (e) => {
            if (destroyed) return;
            playerRef.current = e.target;
            try {
              onReadyRef.current?.(e.target.getDuration() || 0);
            } catch {
              /* */
            }
          },
          onStateChange: (e) => {
            if (destroyed || syncing.current) return;
            // 1 playing, 2 paused, 0 ended
            if (e.data === 1 || e.data === 2 || e.data === 0) {
              report();
            }
          },
          onError: (e) => {
            const codes: Record<number, string> = {
              2: 'Invalid YouTube video id.',
              5: 'HTML5 player error.',
              100: 'Video not found or private.',
              101: 'Embedding disabled by the uploader.',
              150: 'Embedding disabled by the uploader.',
            };
            setError(codes[e.data] || `YouTube error (${e.data})`);
          },
        },
      });
      playerRef.current = player;
    })();

    return () => {
      destroyed = true;
      try {
        player?.destroy();
      } catch {
        /* */
      }
      playerRef.current = null;
    };
  }, [videoId, report]);

  // External time sync
  useEffect(() => {
    const p = playerRef.current;
    if (!p || externalTime === undefined) return;
    try {
      const now = p.getCurrentTime();
      if (Math.abs(now - externalTime) > 1.5) {
        syncing.current = true;
        p.seekTo(externalTime, true);
        setTimeout(() => {
          syncing.current = false;
        }, 500);
      }
    } catch {
      /* */
    }
  }, [externalTime]);

  // External play/pause
  useEffect(() => {
    const p = playerRef.current;
    if (!p || externalPlaying === undefined) return;
    try {
      const state = p.getPlayerState();
      const playing = state === 1;
      if (externalPlaying && !playing) {
        syncing.current = true;
        p.playVideo();
        setTimeout(() => {
          syncing.current = false;
        }, 400);
      } else if (!externalPlaying && playing) {
        syncing.current = true;
        p.pauseVideo();
        setTimeout(() => {
          syncing.current = false;
        }, 400);
      }
    } catch {
      /* */
    }
  }, [externalPlaying]);

  // Periodic time report while playing (for host sync)
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        if (p.getPlayerState() === 1) report();
      } catch {
        /* */
      }
    }, 2500);
    return () => clearInterval(id);
  }, [report, videoId]);

  return (
    <div className={`relative w-full h-full min-h-[240px] ${className}`}>
      <div ref={mountRef} className="absolute inset-0 w-full h-full [&>div]:w-full [&>div]:h-full [&_iframe]:w-full [&_iframe]:h-full" />
      {error && (
        <div className="absolute inset-x-4 top-4 z-10 rounded-lg border border-red-400/40 bg-black/85 px-3 py-2 text-sm text-red-100">
          {error}
        </div>
      )}
    </div>
  );
}

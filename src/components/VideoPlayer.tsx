import { useRef, useState, useEffect, useCallback, type ReactNode } from 'react';

type Props = {
  src: string | null;
  title?: string;
  /** When true, host sync callbacks fire */
  isHost?: boolean;
  onPlayState?: (playing: boolean, time: number) => void;
  onSeek?: (time: number) => void;
  /** External sync from host */
  externalTime?: number;
  externalPlaying?: boolean;
  /** Extra layer drawn on top of the video (also visible in fullscreen) */
  overlay?: ReactNode;
  className?: string;
};

function formatTime(s: number) {
  if (!isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function VideoPlayer({
  src,
  title,
  isHost,
  onPlayState,
  onSeek,
  externalTime,
  externalPlaying,
  overlay,
  className = '',
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const syncing = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showUi, setShowUi] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [resolvedQuality, setResolvedQuality] = useState<string>('');
  /** fit = letterbox (contain), fill = crop to cover screen */
  const [fitMode, setFitMode] = useState<'fit' | 'fill'>('fit');

  const bumpUi = useCallback(() => {
    setShowUi(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowUi(false);
    }, 2800);
  }, []);

  // Load new source
  useEffect(() => {
    setError(null);
    setCurrent(0);
    setDuration(0);
    setPlaying(false);
    setResolvedQuality('');
    const v = videoRef.current;
    if (!v || !src) return;
    v.load();
  }, [src]);

  // External sync (room mode)
  useEffect(() => {
    const v = videoRef.current;
    if (!v || isHost || externalTime === undefined) return;
    const drift = Math.abs(v.currentTime - externalTime);
    if (drift > 1.5) {
      syncing.current = true;
      v.currentTime = externalTime;
      setTimeout(() => {
        syncing.current = false;
      }, 400);
    }
  }, [externalTime, isHost]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || isHost || externalPlaying === undefined) return;
    if (externalPlaying && v.paused) v.play().catch(() => {});
    if (!externalPlaying && !v.paused) v.pause();
  }, [externalPlaying, isHost]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const v = videoRef.current;
      if (!v || !src) return;
      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          if (v.paused) v.play().catch(() => {});
          else v.pause();
          bumpUi();
          break;
        case 'f':
          e.preventDefault();
          toggleFs();
          break;
        case 'm':
          e.preventDefault();
          v.muted = !v.muted;
          setMuted(v.muted);
          bumpUi();
          break;
        case 'arrowleft':
          e.preventDefault();
          seek(Math.max(0, v.currentTime - 10));
          bumpUi();
          break;
        case 'arrowright':
          e.preventDefault();
          seek(Math.min(v.duration || 0, v.currentTime + 10));
          bumpUi();
          break;
        case 'arrowup':
          e.preventDefault();
          {
            const nv = Math.min(1, (v.volume || 0) + 0.1);
            v.volume = nv;
            setVolume(nv);
            setMuted(false);
            v.muted = false;
          }
          bumpUi();
          break;
        case 'arrowdown':
          e.preventDefault();
          {
            const nv = Math.max(0, (v.volume || 0) - 0.1);
            v.volume = nv;
            setVolume(nv);
            if (nv === 0) setMuted(true);
          }
          bumpUi();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, bumpUi]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch((e) => setError(e?.message || 'Playback blocked — click again'));
    } else {
      v.pause();
    }
  };

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    setCurrent(t);
    onSeek?.(t);
    if (isHost) onPlayState?.(!v.paused, t);
  };

  const toggleFs = async () => {
    const el = shellRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if ((el as any).webkitRequestFullscreen) await (el as any).webkitRequestFullscreen();
      } else {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if ((document as any).webkitExitFullscreen) await (document as any).webkitExitFullscreen();
      }
    } catch {
      /* ignore */
    }
  };

  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await v.requestPictureInPicture();
      }
    } catch {
      /* ignore */
    }
  };

  if (!src) {
    return (
      <div className={`bg-black flex items-center justify-center text-muted text-sm ${className}`}>
        No video loaded
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className={`relative bg-black flex items-center justify-center overflow-hidden select-none ${className}`}
      onMouseMove={bumpUi}
      onTouchStart={bumpUi}
      onDoubleClick={toggleFs}
    >
      <video
        ref={videoRef}
        src={src}
        className={`w-full h-full max-h-full ${
          fitMode === 'fill' ? 'object-cover' : 'object-contain'
        }`}
        playsInline
        preload="metadata"
        onClick={togglePlay}
        onPlay={() => {
          setPlaying(true);
          if (!syncing.current && isHost && videoRef.current) {
            onPlayState?.(true, videoRef.current.currentTime);
          }
        }}
        onPause={() => {
          setPlaying(false);
          if (!syncing.current && isHost && videoRef.current) {
            onPlayState?.(false, videoRef.current.currentTime);
          }
        }}
        onTimeUpdate={() => {
          if (videoRef.current && !syncing.current) {
            setCurrent(videoRef.current.currentTime);
          }
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (!v) return;
          setDuration(v.duration);
          const w = v.videoWidth;
          const h = v.videoHeight;
          if (w && h) {
            let label = `${w}×${h}`;
            if (h >= 2160) label = '4K · ' + label;
            else if (h >= 1440) label = '1440p · ' + label;
            else if (h >= 1080) label = '1080p · ' + label;
            else if (h >= 720) label = '720p · ' + label;
            else if (h >= 480) label = '480p · ' + label;
            setResolvedQuality(label);
          }
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onError={() => {
          setError(
            'Video failed to load. Re-select the file. MKV may not play in Chrome — convert to MP4 or try Edge/Firefox.'
          );
          setBuffering(false);
        }}
      />

      {/* Buffering */}
      {buffering && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-12 h-12 border-2 border-violet border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6">
          <div className="max-w-md text-center space-y-3">
            <p className="text-crimson text-sm">{error}</p>
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => {
                setError(null);
                videoRef.current?.load();
                videoRef.current?.play().catch(() => {});
              }}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Center play when paused */}
      {!playing && !error && !buffering && (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/20"
          aria-label="Play"
        >
          <span className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-violet/90 flex items-center justify-center shadow-lg">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}

      {/* Controls bar */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black via-black/85 to-transparent px-3 sm:px-5 pt-12 pb-3 sm:pb-4 transition-opacity duration-200 ${
          showUi || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {title && (
          <p className="text-xs text-white/70 mb-2 truncate sm:hidden">{title}</p>
        )}

        {/* Progress */}
        <input
          type="range"
          min={0}
          max={duration || 100}
          step={0.1}
          value={current}
          onChange={(e) => seek(Number(e.target.value))}
          className="w-full h-1.5 accent-violet cursor-pointer mb-2.5"
        />

        <div className="flex items-center gap-1.5 sm:gap-3 flex-wrap">
          <button type="button" onClick={togglePlay} className="text-white hover:text-violet-light p-1">
            {playing ? (
              <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            onClick={() => seek(Math.max(0, current - 10))}
            className="text-white/80 hover:text-white text-xs px-1"
            title="-10s"
          >
            −10
          </button>
          <button
            type="button"
            onClick={() => seek(Math.min(duration, current + 10))}
            className="text-white/80 hover:text-white text-xs px-1"
            title="+10s"
          >
            +10
          </button>

          <span className="text-[11px] sm:text-xs text-white/80 font-mono tabular-nums">
            {formatTime(current)} / {formatTime(duration)}
          </span>

          <div className="flex-1 min-w-[8px]" />

          {/* Fit / Fill (half vs full screen crop) */}
          <button
            type="button"
            onClick={() => setFitMode((m) => (m === 'fit' ? 'fill' : 'fit'))}
            className="text-[11px] text-white/80 hover:text-white border border-white/20 rounded px-2 py-0.5"
            title={fitMode === 'fit' ? 'Switch to Fill (crop to screen)' : 'Switch to Fit (show full frame)'}
          >
            {fitMode === 'fit' ? 'Fit' : 'Fill'}
          </button>

          {/* Speed */}
          <select
            value={playbackRate}
            onChange={(e) => {
              const r = Number(e.target.value);
              setPlaybackRate(r);
              if (videoRef.current) videoRef.current.playbackRate = r;
            }}
            className="bg-transparent text-white/80 text-[11px] border border-white/20 rounded px-1 py-0.5"
            title="Speed"
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
              <option key={r} value={r} className="bg-surface text-text">
                {r}x
              </option>
            ))}
          </select>

          {/* Quality (source resolution — local files have no adaptive streams) */}
          {resolvedQuality && (
            <span
              className="text-[10px] text-white/60 border border-white/15 rounded px-1.5 py-0.5"
              title="File resolution. Local files play as-is; no quality switching."
            >
              {resolvedQuality}
            </span>
          )}

          {/* Volume */}
          <button
            type="button"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              v.muted = !v.muted;
              setMuted(v.muted);
            }}
            className="text-white/80 hover:text-white text-xs p-1"
            title="Mute (M)"
          >
            {muted || volume === 0 ? (
              <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
            ) : (
              <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const val = Number(e.target.value);
              setVolume(val);
              setMuted(val === 0);
              if (videoRef.current) {
                videoRef.current.volume = val;
                videoRef.current.muted = val === 0;
              }
            }}
            className="w-14 sm:w-20 h-1 accent-violet hidden sm:block"
          />

          {/* PiP */}
          <button
            type="button"
            onClick={togglePip}
            className="text-white/80 hover:text-white text-[11px] hidden sm:inline px-1"
            title="Picture in picture"
          >
            PiP
          </button>

          {/* Fullscreen */}
          <button
            type="button"
            onClick={toggleFs}
            className="text-white hover:text-violet-light p-1.5"
            title={isFs ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          >
            {isFs ? (
              <svg width="22" height="22" fill="currentColor" viewBox="0 0 24 24">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg width="22" height="22" fill="currentColor" viewBox="0 0 24 24">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {overlay}
    </div>
  );
}

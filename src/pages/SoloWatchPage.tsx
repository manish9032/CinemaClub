import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import VideoPlayer from '../components/VideoPlayer';

export default function SoloWatchPage() {
  const [src, setSrc] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [localName, setLocalName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const blobRef = useRef<string | null>(null);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    const url = URL.createObjectURL(file);
    blobRef.current = url;
    setLocalName(file.name);
    setSrc(url);
    setTitle(file.name);
  };

  const clear = () => {
    setSrc(null);
    setTitle('');
    setLocalName('');
    if (blobRef.current) {
      URL.revokeObjectURL(blobRef.current);
      blobRef.current = null;
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  // Full cinema mode — only the player
  if (src) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        <div className="h-11 flex items-center justify-between px-3 sm:px-4 border-b border-white/10 bg-black/90 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={clear}
              className="text-sm text-white/70 hover:text-white"
            >
              ← Back
            </button>
            <span className="text-sm text-white truncate">{title}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="text-xs text-white/60 hover:text-white"
            >
              Change file
            </button>
            <Link to="/browse" className="text-xs text-white/60 hover:text-white">
              Browse
            </Link>
          </div>
        </div>
        <div className="flex-1 min-h-0 relative">
          <VideoPlayer src={src} title={title} className="w-full h-full" />
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="video/*,.mkv,.avi,.mp4,.webm,.mov,.m4v"
          className="hidden"
          onChange={onFile}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-obsidian pt-20 pb-16">
      <div className="max-w-lg mx-auto px-4 animate-float-in">
        <h1 className="font-display text-3xl font-semibold text-text text-center">Watch alone</h1>
        <p className="text-muted text-sm text-center mt-2 mb-8">
          Load a video from your device. Files never leave your browser — nothing is uploaded.
        </p>

        <div className="glass rounded-2xl p-5 sm:p-6 space-y-5">
          <div>
            <p className="text-xs mono-label text-muted mb-2">Your video file</p>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="btn-primary w-full py-3.5 text-base"
            >
              Choose video file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="video/*,.mkv,.avi,.mp4,.webm,.mov,.m4v"
              className="hidden"
              onChange={onFile}
            />
            <p className="text-[11px] text-subtle mt-3 leading-relaxed">
              Supported: MP4, WebM, MOV (MKV may not play in Chrome). Local files stay on your device
              only. After refresh you must choose the file again (browser security).
              {localName && (
                <span className="block text-violet-light mt-1">Selected: {localName}</span>
              )}
            </p>
          </div>

          <div className="text-center pt-1 border-t border-border">
            <p className="text-xs text-subtle mb-2 mt-4">Or pick a title from catalog (still play from your file)</p>
            <Link to="/browse" className="btn-ghost text-sm">
              Browse
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

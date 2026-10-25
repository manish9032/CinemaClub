import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { joinRoom } from '../services/rooms';
import { validateRoomId } from '../utils/hash';

export default function JoinRoomPage() {
  const { user, displayName, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const params = useParams<{ roomId?: string }>();

  // Prefill from /join/ABC123 or /join-room?code=ABC123
  const prefill =
    (params.roomId || searchParams.get('code') || searchParams.get('room') || '')
      .trim()
      .toUpperCase();

  const [roomId, setRoomId] = useState(prefill);
  const [password, setPassword] = useState('');
  const [name, setName] = useState(displayName);
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      const returnTo = prefill
        ? `/join/${prefill}`
        : '/join-room';
      navigate('/auth', { state: { from: returnTo } });
    }
  }, [user, authLoading, navigate, prefill]);

  useEffect(() => {
    if (displayName) setName(displayName);
  }, [displayName]);

  useEffect(() => {
    if (prefill && validateRoomId(prefill)) {
      setRoomId(prefill);
    }
  }, [prefill]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError('');

    const id = roomId.trim().toUpperCase();
    if (!validateRoomId(id)) {
      setError('Room code must be 6 characters (letters & numbers).');
      return;
    }
    if (!password || password.length < 8) {
      setError('Enter the room password (at least 8 characters).');
      return;
    }
    if (!name.trim() || name.trim().length < 2) {
      setError('Display name must be at least 2 characters.');
      return;
    }

    setJoining(true);
    const { room, error: err } = await joinRoom(id, password, user.id, name.trim());
    setJoining(false);

    if (err || !room) {
      setError(err || 'Could not join room.');
      return;
    }
    navigate(`/room/${room.id}`);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-obsidian pt-24 flex items-center justify-center text-muted">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-obsidian pt-20 pb-20 flex items-start justify-center">
      <div className="w-full max-w-lg px-4 sm:px-0 animate-float-in">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-muted hover:text-text text-sm mb-8 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Back
        </button>

        <div className="glass rounded-2xl p-6 sm:p-8">
          <h1 className="font-display text-2xl font-semibold text-text mb-1">Join a room</h1>
          <p className="text-muted text-sm mb-6">
            {prefill
              ? `Room ${prefill} — enter the password shared by the host.`
              : 'Enter the 6-character room code and password shared by the host.'}
          </p>

          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="block text-xs mono-label text-muted mb-1.5">Room code</label>
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                className="input-field font-mono tracking-widest text-center text-lg uppercase"
                placeholder="ABC123"
                maxLength={6}
                required
                readOnly={!!prefill && validateRoomId(prefill)}
              />
            </div>

            <div>
              <label className="block text-xs mono-label text-muted mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-field"
                placeholder="Room password"
                autoFocus={!!prefill}
                required
              />
            </div>

            <div>
              <label className="block text-xs mono-label text-muted mb-1.5">Your display name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-field"
                maxLength={20}
                required
              />
            </div>

            {error && (
              <div className="text-sm text-crimson bg-crimson/10 border border-crimson/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button type="submit" disabled={joining} className="btn-primary w-full py-3 mt-2">
              {joining ? 'Joining…' : 'Join room'}
            </button>
          </form>

          <p className="text-center text-xs text-subtle mt-6">
            Want to host instead?{' '}
            <Link to="/create-room" className="text-violet-light hover:underline">
              Create a room
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

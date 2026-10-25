import { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { createRoom, getMyActiveRoom } from '../services/rooms';
import { posterUrl } from '../services/tmdb';

export default function CreateRoomPage() {
  const { user, displayName, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state || {}) as {
    movieId?: number;
    movieTitle?: string;
    moviePoster?: string | null;
  };

  const [hostName, setHostName] = useState(displayName);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [existingRoom, setExistingRoom] = useState<{ id: string } | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate('/auth', { state: { from: '/create-room' } });
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (displayName) setHostName(displayName);
  }, [displayName]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const room = await getMyActiveRoom(user.id);
      setExistingRoom(room ? { id: room.id } : null);
      setChecking(false);
    })();
  }, [user]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!hostName.trim() || hostName.trim().length < 2) e.hostName = 'Name must be at least 2 characters.';
    if (hostName.trim().length > 20) e.hostName = 'Name must be 20 characters or less.';
    if (!password || password.length < 8) e.password = 'Password must be at least 8 characters.';
    if (password.length > 72) e.password = 'Password too long (max 72).';
    if (password !== confirmPassword) e.confirmPassword = 'Passwords do not match.';
    return e;
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setCreating(true);
    const { room, error } = await createRoom(user.id, hostName.trim(), password, {
      movieId: state.movieId,
      movieTitle: state.movieTitle,
      moviePoster: state.moviePoster ?? undefined,
    });

    setCreating(false);
    if (error) {
      setErrors({ form: error });
      if (room) setExistingRoom({ id: room.id });
      return;
    }
    navigate(`/room/${room.id}`);
  };

  if (authLoading || checking) {
    return (
      <div className="min-h-screen bg-obsidian pt-24 flex items-center justify-center text-muted">
        Loading…
      </div>
    );
  }

  if (existingRoom) {
    return (
      <div className="min-h-screen bg-obsidian pt-24 pb-16 flex items-start justify-center px-4">
        <div className="w-full max-w-lg glass rounded-2xl p-8 text-center animate-float-in">
          <div className="text-4xl mb-4">🔒</div>
          <h1 className="font-display text-2xl font-semibold text-text mb-2">
            You already have a room
          </h1>
          <p className="text-muted text-sm mb-6">
            One active room per account. Delete your current room before creating a new one.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link to={`/room/${existingRoom.id}`} className="btn-primary">
              Go to room {existingRoom.id}
            </Link>
            <Link to="/" className="btn-ghost">
              Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const posterSrc = state.moviePoster ? posterUrl(state.moviePoster, 'w185') : null;

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
          <h1 className="font-display text-2xl font-semibold text-text mb-1">Create private room</h1>
          <p className="text-muted text-sm mb-6">
            Share the room code and password with friends. Only one room per account.
          </p>

          {posterSrc && state.movieTitle && (
            <div className="flex items-center gap-3 mb-6 p-3 rounded-xl bg-surface border border-border">
              <img src={posterSrc} alt="" className="w-12 h-[72px] object-cover rounded-md" />
              <div>
                <p className="text-xs text-subtle mono-label">Watching</p>
                <p className="text-sm font-medium text-text line-clamp-2">{state.movieTitle}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-xs mono-label text-muted mb-1.5">Your display name</label>
              <input
                type="text"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                className="input-field"
                maxLength={20}
                required
              />
              {errors.hostName && <p className="text-xs text-crimson mt-1">{errors.hostName}</p>}
            </div>

            <div>
              <label className="block text-xs mono-label text-muted mb-1.5">Room password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-field pr-12"
                  minLength={8}
                  maxLength={72}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle hover:text-muted text-xs"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              {errors.password && <p className="text-xs text-crimson mt-1">{errors.password}</p>}
            </div>

            <div>
              <label className="block text-xs mono-label text-muted mb-1.5">Confirm password</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input-field"
                required
              />
              {errors.confirmPassword && (
                <p className="text-xs text-crimson mt-1">{errors.confirmPassword}</p>
              )}
            </div>

            {errors.form && (
              <div className="text-sm text-crimson bg-crimson/10 border border-crimson/30 rounded-lg px-3 py-2">
                {errors.form}
              </div>
            )}

            <button type="submit" disabled={creating} className="btn-primary w-full py-3 mt-2">
              {creating ? 'Creating…' : 'Create room'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

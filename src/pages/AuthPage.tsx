import { useState, useEffect } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AuthPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn, signUp, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: string } | null)?.from ||
    '/';

  useEffect(() => {
    if (authLoading) return;
    if (user) {
      navigate(from.startsWith('/') ? from : '/', { replace: true });
    }
  }, [user, authLoading, navigate, from]);

  if (authLoading || user) {
    return (
      <div className="min-h-screen bg-obsidian flex items-center justify-center text-muted">
        Loading…
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (mode === 'signup') {
      if (!displayName.trim() || displayName.trim().length < 2) {
        setError('Display name must be at least 2 characters.');
        setLoading(false);
        return;
      }
      const { error: err } = await signUp(email, password, displayName);
      if (err) {
        setError(err);
        setLoading(false);
        return;
      }
      // Supabase may require email confirm; try sign-in path if still no session
      navigate(from.startsWith('/') ? from : '/', { replace: true });
      setLoading(false);
      return;
    }

    const { error: err } = await signIn(email, password);
    if (err) {
      setError(err);
      setLoading(false);
      return;
    }
    navigate(from.startsWith('/') ? from : '/', { replace: true });
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-obsidian pt-24 pb-16 flex items-start justify-center px-4">
      <div className="w-full max-w-md animate-float-in">
        <div className="text-center mb-8">
          <span className="text-4xl">🎬</span>
          <h1 className="font-display text-3xl font-semibold mt-3 text-text">
            {mode === 'signin' ? 'Welcome back' : 'Create account'}
          </h1>
          <p className="text-muted text-sm mt-2">
            {mode === 'signin'
              ? 'Sign in to create or join private watch rooms'
              : 'Join CinemaClub to watch movies together'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="glass rounded-2xl p-6 sm:p-8 space-y-5">
          {mode === 'signup' && (
            <div>
              <label className="block text-xs mono-label text-muted mb-1.5">Display name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input-field"
                placeholder="How others see you"
                maxLength={20}
                required
              />
            </div>
          )}

          <div>
            <label className="block text-xs mono-label text-muted mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </div>

          <div>
            <label className="block text-xs mono-label text-muted mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              placeholder="••••••••"
              minLength={6}
              required
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </div>

          {error && (
            <div className="text-sm text-crimson bg-crimson/10 border border-crimson/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} className="btn-primary w-full py-3">
            {loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>

          <p className="text-center text-sm text-muted">
            {mode === 'signin' ? (
              <>
                No account?{' '}
                <button
                  type="button"
                  onClick={() => setMode('signup')}
                  className="text-violet-light hover:underline"
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => setMode('signin')}
                  className="text-violet-light hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </form>

        <p className="text-center text-xs text-subtle mt-6">
          <Link to="/" className="hover:text-muted">
            ← Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}

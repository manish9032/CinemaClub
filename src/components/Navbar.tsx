import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Navbar() {
  const { user, displayName, signOut, loading, isLocalMode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Hide chrome on immersive player routes
  const hideNav =
    location.pathname.startsWith('/room/') ||
    (location.pathname === '/solo' && typeof document !== 'undefined');
  // solo page manages its own bar when playing — always show nav on picker
  const isRoom = location.pathname.startsWith('/room/');

  if (isRoom) return null;

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 group min-w-0">
          <span className="text-xl sm:text-2xl flex-shrink-0">🎬</span>
          <span className="font-display text-lg sm:text-xl font-semibold tracking-tight text-text group-hover:text-violet-light transition-colors truncate">
            CinemaClub
          </span>
          {isLocalMode && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 flex-shrink-0"
              title="Running without Supabase — data stays in this browser"
            >
              Local
            </span>
          )}
        </Link>

        {/* Desktop links */}
        <div className="hidden sm:flex items-center gap-3 sm:gap-5">
          <Link to="/browse" className="text-sm text-muted hover:text-text transition-colors">
            Browse
          </Link>
          <Link to="/solo" className="text-sm text-muted hover:text-text transition-colors">
            Watch alone
          </Link>
          <Link to="/create-room" className="text-sm text-muted hover:text-text transition-colors">
            Create Room
          </Link>
          <Link to="/join-room" className="text-sm text-muted hover:text-text transition-colors">
            Join Room
          </Link>

          {!loading && (
            user ? (
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted hidden md:inline max-w-[120px] truncate">
                  {displayName}
                </span>
                <button
                  onClick={async () => {
                    await signOut();
                    navigate('/');
                  }}
                  className="btn-ghost text-xs py-1.5 px-3"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <Link to="/auth" className="btn-primary text-xs py-1.5 px-4">
                Sign in
              </Link>
            )
          )}
        </div>

        {/* Mobile: hamburger */}
        <div className="flex sm:hidden items-center gap-2">
          {!loading && !user && (
            <Link to="/auth" className="btn-primary text-xs py-1.5 px-3">
              Sign in
            </Link>
          )}
          <button
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="p-2 rounded-lg border border-border text-muted hover:text-text hover:border-border-light"
          >
            {menuOpen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div className="sm:hidden border-t border-border bg-surface/95 backdrop-blur-md px-4 py-3 space-y-1">
          <Link
            to="/browse"
            className="block px-3 py-2.5 rounded-lg text-sm text-text hover:bg-card"
          >
            Browse movies
          </Link>
          <Link
            to="/solo"
            className="block px-3 py-2.5 rounded-lg text-sm text-text hover:bg-card"
          >
            Watch alone
          </Link>
          <Link
            to="/create-room"
            className="block px-3 py-2.5 rounded-lg text-sm text-text hover:bg-card"
          >
            Create Room
          </Link>
          <Link
            to="/join-room"
            className="block px-3 py-2.5 rounded-lg text-sm text-text hover:bg-card"
          >
            Join Room
          </Link>
          {user && (
            <>
              <div className="px-3 py-2 text-xs text-muted truncate">{displayName}</div>
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                  setMenuOpen(false);
                  navigate('/');
                }}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-crimson hover:bg-card"
              >
                Sign out
              </button>
            </>
          )}
        </div>
      )}
    </nav>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import MovieCard from '../components/MovieCard';
import { getTrending, getPopular, getNowPlaying, type TMDBMovie } from '../services/tmdb';
import { useAuth } from '../contexts/AuthContext';

export default function HomePage() {
  const [trending, setTrending] = useState<TMDBMovie[]>([]);
  const [popular, setPopular] = useState<TMDBMovie[]>([]);
  const [nowPlaying, setNowPlaying] = useState<TMDBMovie[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, p, n] = await Promise.all([
          getTrending(1),
          getPopular(1),
          getNowPlaying(1),
        ]);
        if (!cancelled) {
          setTrending(t.results.slice(0, 12));
          setPopular(p.results.slice(0, 12));
          setNowPlaying(n.results.slice(0, 12));
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-screen bg-obsidian pt-16">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-violet-dim/30 via-obsidian to-obsidian" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 py-20 sm:py-28 text-center">
          <h1 className="font-display text-4xl sm:text-6xl font-semibold tracking-tight text-text leading-tight">
            Watch movies<br />
            <span className="text-violet-light">together, privately</span>
          </h1>
          <p className="mt-5 text-muted text-base sm:text-lg max-w-xl mx-auto leading-relaxed">
            Create a private room, invite friends with a code & password, and sync playback in real time.
            Powered by TMDB + Supabase.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to={user ? '/create-room' : '/auth'} className="btn-primary text-base px-6 py-3">
              Create a room
            </Link>
            <Link to="/join-room" className="btn-ghost text-base px-6 py-3">
              Join a room
            </Link>
            <Link to="/browse" className="btn-ghost text-base px-6 py-3">
              Browse movies
            </Link>
          </div>
        </div>
      </section>

      {/* Rows */}
      {loading ? (
        <div className="max-w-7xl mx-auto px-4 py-16 text-center text-muted">Loading movies…</div>
      ) : (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-12 pb-20">
          <MovieRow title="Trending this week" movies={trending} />
          <MovieRow title="Popular" movies={popular} />
          <MovieRow title="Now Playing" movies={nowPlaying} />
        </div>
      )}
    </div>
  );
}

function MovieRow({ title, movies }: { title: string; movies: TMDBMovie[] }) {
  if (!movies.length) return null;
  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-xl sm:text-2xl font-semibold text-text">{title}</h2>
        <Link to="/browse" className="text-sm text-violet-light hover:underline">See all</Link>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-4 -mx-1 px-1 scrollbar-thin">
        {movies.map((m) => (
          <MovieCard key={m.id} movie={m} />
        ))}
      </div>
    </section>
  );
}

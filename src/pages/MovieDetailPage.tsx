import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getMovie, posterUrl, backdropUrl, type TMDBMovie } from '../services/tmdb';
import { useAuth } from '../contexts/AuthContext';

export default function MovieDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [movie, setMovie] = useState<TMDBMovie | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getMovie(Number(id));
        if (!cancelled) setMovie(data);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Failed to load movie');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-obsidian pt-24 flex items-center justify-center text-muted">
        Loading…
      </div>
    );
  }

  if (error || !movie) {
    return (
      <div className="min-h-screen bg-obsidian pt-24 flex flex-col items-center justify-center gap-4">
        <p className="text-crimson">{error || 'Movie not found'}</p>
        <Link to="/browse" className="btn-ghost">Back to browse</Link>
      </div>
    );
  }

  const genres = movie.genres?.map((g) => g.name).join(' · ') || '';
  const year = movie.release_date?.slice(0, 4) || '';
  const runtime = movie.runtime ? `${Math.floor(movie.runtime / 60)}h ${movie.runtime % 60}m` : '';

  return (
    <div className="min-h-screen bg-obsidian">
      {/* Backdrop */}
      <div className="relative h-[50vh] min-h-[320px]">
        {movie.backdrop_path && (
          <img
            src={backdropUrl(movie.backdrop_path)}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-obsidian/70 to-obsidian/30" />
        <div className="absolute inset-0 bg-gradient-to-r from-obsidian/80 to-transparent" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 -mt-40 pb-20">
        <div className="flex flex-col sm:flex-row gap-8">
          <img
            src={posterUrl(movie.poster_path, 'w500')}
            alt={movie.title}
            className="w-48 sm:w-56 rounded-xl shadow-2xl border border-border flex-shrink-0 mx-auto sm:mx-0"
          />

          <div className="flex-1 pt-2">
            <h1 className="font-display text-3xl sm:text-4xl font-semibold text-text leading-tight">
              {movie.title}
            </h1>
            {movie.tagline && (
              <p className="text-muted italic mt-2 text-sm">“{movie.tagline}”</p>
            )}

            <div className="flex flex-wrap items-center gap-3 mt-4 text-sm text-muted">
              <span className="text-amber font-medium">★ {movie.vote_average?.toFixed(1)}</span>
              {year && <span>{year}</span>}
              {runtime && <span>{runtime}</span>}
              {genres && <span className="text-subtle">{genres}</span>}
            </div>

            <p className="mt-5 text-muted leading-relaxed max-w-2xl">
              {movie.overview || 'No overview available.'}
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                onClick={() => {
                  if (!user) {
                    navigate('/auth');
                    return;
                  }
                  navigate('/create-room', {
                    state: {
                      movieId: movie.id,
                      movieTitle: movie.title,
                      moviePoster: movie.poster_path,
                    },
                  });
                }}
                className="btn-primary"
              >
                Create watch room
              </button>
              <Link to="/solo" className="btn-ghost">
                Watch alone
              </Link>
              <Link to="/browse" className="btn-ghost">
                Back to browse
              </Link>
            </div>
            <p className="mt-3 text-xs text-subtle max-w-xl">
              TMDB only lists movies — it does not host video files. Use <strong>Watch alone</strong> or
              a room with your own file / stream URL to play.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

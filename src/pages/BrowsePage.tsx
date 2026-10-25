import { useEffect, useState, useCallback } from 'react';
import MovieCard from '../components/MovieCard';
import {
  getPopular, getTopRated, getUpcoming, searchMovies, getMoviesByGenre,
  GENRE_MAP, type TMDBMovie,
} from '../services/tmdb';

const CATEGORIES = [
  { key: 'popular', label: 'Popular' },
  { key: 'top_rated', label: 'Top Rated' },
  { key: 'upcoming', label: 'Upcoming' },
] as const;

export default function BrowsePage() {
  const [movies, setMovies] = useState<TMDBMovie[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [category, setCategory] = useState<string>('popular');
  const [genreId, setGenreId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const load = useCallback(async (p = 1, reset = false) => {
    setLoading(true);
    try {
      let res;
      if (query.trim()) {
        res = await searchMovies(query.trim(), p);
      } else if (genreId) {
        res = await getMoviesByGenre(genreId, p);
      } else if (category === 'top_rated') {
        res = await getTopRated(p);
      } else if (category === 'upcoming') {
        res = await getUpcoming(p);
      } else {
        res = await getPopular(p);
      }
      setMovies((prev) => (reset ? res.results : [...prev, ...res.results]));
      setTotalPages(res.total_pages);
      setPage(p);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [query, genreId, category]);

  useEffect(() => {
    load(1, true);
  }, [load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setQuery(searchInput);
    setGenreId(null);
    setCategory('popular');
  };

  return (
    <div className="min-h-screen bg-obsidian pt-20 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <h1 className="font-display text-3xl font-semibold text-text mb-6">Browse</h1>

        {/* Search */}
        <form onSubmit={handleSearch} className="mb-6 flex gap-2">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search movies…"
            className="input-field flex-1 max-w-md"
          />
          <button type="submit" className="btn-primary">Search</button>
        </form>

        {/* Categories */}
        <div className="flex flex-wrap gap-2 mb-4">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              onClick={() => {
                setCategory(c.key);
                setGenreId(null);
                setQuery('');
                setSearchInput('');
              }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                category === c.key && !genreId && !query
                  ? 'bg-violet text-white'
                  : 'bg-card border border-border text-muted hover:border-border-light'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Genres */}
        <div className="flex flex-wrap gap-1.5 mb-8">
          {Object.entries(GENRE_MAP).map(([id, name]) => (
            <button
              key={id}
              onClick={() => {
                setGenreId(Number(id));
                setCategory('popular');
                setQuery('');
                setSearchInput('');
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] transition-all ${
                genreId === Number(id)
                  ? 'bg-violet/30 text-violet-light border border-violet/50'
                  : 'bg-surface text-subtle border border-border hover:text-muted'
              }`}
            >
              {name}
            </button>
          ))}
        </div>

        {/* Grid */}
        {loading && movies.length === 0 ? (
          <p className="text-muted text-center py-16">Loading…</p>
        ) : movies.length === 0 ? (
          <div className="text-center py-16 px-4 space-y-3">
            <p className="text-muted">No movies found.</p>
            {!import.meta.env.VITE_TMDB_API_KEY && (
              <p className="text-xs text-subtle max-w-md mx-auto">
                TMDB API key missing. Add <code className="text-violet-light">VITE_TMDB_API_KEY</code> in
                your <code className="text-violet-light">.env</code> file (get a free key at{' '}
                <a
                  href="https://www.themoviedb.org/settings/api"
                  target="_blank"
                  rel="noreferrer"
                  className="text-violet-light underline"
                >
                  themoviedb.org
                </a>
                ). Browse is optional — you can still create rooms and play local files.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
              {movies.map((m) => (
                <MovieCard key={m.id} movie={m} size="sm" />
              ))}
            </div>
            {page < totalPages && (
              <div className="mt-10 text-center">
                <button
                  onClick={() => load(page + 1)}
                  disabled={loading}
                  className="btn-ghost"
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

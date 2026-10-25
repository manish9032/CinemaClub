import { Link } from 'react-router-dom';
import { posterUrl, genreName, type TMDBMovie } from '../services/tmdb';

interface MovieCardProps {
  movie: TMDBMovie;
  size?: 'sm' | 'md' | 'lg';
}

export default function MovieCard({ movie, size = 'md' }: MovieCardProps) {
  const width = size === 'sm' ? 'w-32' : size === 'lg' ? 'w-48' : 'w-40';
  const genres = (movie.genre_ids || []).slice(0, 2).map(genreName).join(' · ');

  return (
    <Link
      to={`/movie/${movie.id}`}
      className={`${width} flex-shrink-0 group`}
    >
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-card border border-border group-hover:border-violet/50 transition-all duration-300 group-hover:shadow-[0_0_24px_rgba(124,58,237,0.25)]">
        <img
          src={posterUrl(movie.poster_path, size === 'lg' ? 'w500' : 'w342')}
          alt={movie.title}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-obsidian/90 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        <div className="absolute bottom-0 left-0 right-0 p-3 translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
          <p className="text-xs font-medium text-text line-clamp-2 leading-tight">{movie.title}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-amber flex items-center gap-0.5">
              ★ {movie.vote_average?.toFixed(1) ?? '—'}
            </span>
            {movie.release_date && (
              <span className="text-[10px] text-subtle">
                {movie.release_date.slice(0, 4)}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2 px-0.5">
        <p className="text-sm font-medium text-text line-clamp-1 group-hover:text-violet-light transition-colors">
          {movie.title}
        </p>
        {genres && <p className="text-[11px] text-subtle mt-0.5 line-clamp-1">{genres}</p>}
      </div>
    </Link>
  );
}

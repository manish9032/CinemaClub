const API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const BASE = 'https://api.themoviedb.org/3';

if (!API_KEY) {
  console.warn('VITE_TMDB_API_KEY missing — browse will not load movies.');
}
const IMG_BASE = 'https://image.tmdb.org/t/p';

export interface TMDBMovie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  vote_count: number;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  runtime?: number;
  tagline?: string;
  adult?: boolean;
}

export interface TMDBResponse<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

const GENRE_MAP: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
};

export function genreName(id: number): string {
  return GENRE_MAP[id] ?? 'Unknown';
}

export function posterUrl(path: string | null | undefined, size: 'w92' | 'w154' | 'w185' | 'w342' | 'w500' | 'w780' | 'original' = 'w342'): string {
  if (!path) return 'https://via.placeholder.com/342x513/111118/475569?text=No+Poster';
  return `${IMG_BASE}/${size}${path}`;
}

export function backdropUrl(path: string | null | undefined, size: 'w300' | 'w780' | 'w1280' | 'original' = 'w1280'): string {
  if (!path) return '';
  return `${IMG_BASE}/${size}${path}`;
}

async function fetchTMDB<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  if (!API_KEY) {
    return { page: 1, results: [], total_pages: 0, total_results: 0 } as T;
  }
  const url = new URL(`${BASE}${endpoint}`);
  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('language', 'en-US');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      console.warn(`TMDB ${res.status} for ${endpoint}`);
      return { page: 1, results: [], total_pages: 0, total_results: 0 } as T;
    }
    return res.json();
  } catch (e) {
    // Network blocked / timed out — browse stays empty, rest of app still works
    console.warn('TMDB unreachable (network). Browse may be empty.', e);
    return { page: 1, results: [], total_pages: 0, total_results: 0 } as T;
  }
}

export async function getTrending(page = 1): Promise<TMDBResponse<TMDBMovie>> {
  return fetchTMDB('/trending/movie/week', { page: String(page) });
}

export async function getPopular(page = 1): Promise<TMDBResponse<TMDBMovie>> {
  return fetchTMDB('/movie/popular', { page: String(page) });
}

export async function getTopRated(page = 1): Promise<TMDBResponse<TMDBMovie>> {
  return fetchTMDB('/movie/top_rated', { page: String(page) });
}

export async function getNowPlaying(page = 1): Promise<TMDBResponse<TMDBMovie>> {
  return fetchTMDB('/movie/now_playing', { page: String(page) });
}

export async function getUpcoming(page = 1): Promise<TMDBResponse<TMDBMovie>> {
  return fetchTMDB('/movie/upcoming', { page: String(page) });
}

export async function searchMovies(query: string, page = 1): Promise<TMDBResponse<TMDBMovie>> {
  return fetchTMDB('/search/movie', { query, page: String(page), include_adult: 'false' });
}

export async function getMovie(id: number): Promise<TMDBMovie> {
  return fetchTMDB(`/movie/${id}`, { append_to_response: 'credits,videos,similar' });
}

export async function getMoviesByGenre(genreId: number, page = 1): Promise<TMDBResponse<TMDBMovie>> {
  return fetchTMDB('/discover/movie', {
    with_genres: String(genreId),
    page: String(page),
    sort_by: 'popularity.desc',
  });
}

export { GENRE_MAP };

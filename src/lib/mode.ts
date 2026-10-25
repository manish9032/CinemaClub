/**
 * App mode: local (no Supabase) vs cloud (Supabase).
 * Set VITE_USE_LOCAL=false in .env to use Supabase (recommended for persistence).
 * Local only when VITE_USE_LOCAL is explicitly true/1.
 */
export const USE_LOCAL =
  import.meta.env.VITE_USE_LOCAL === 'true' ||
  import.meta.env.VITE_USE_LOCAL === '1';

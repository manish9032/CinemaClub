import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase env vars missing. Auth and rooms will not work.');
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    },
  }
);

export type Database = {
  public: {
    Tables: {
      rooms: {
        Row: {
          id: string;
          host_id: string;
          host_name: string;
          created_at: string;
          expires_at: string;
          movie_id: number | null;
          movie_title: string | null;
          movie_poster: string | null;
          is_playing: boolean;
          current_time: number;
          last_sync_at: string;
          video_src_type: 'stream' | 'local' | 'youtube' | null;
          video_src: string | null;
          local_file_name: string | null;
        };
        Insert: Omit<Database['public']['Tables']['rooms']['Row'], 'created_at' | 'is_playing' | 'current_time' | 'last_sync_at'> & {
          created_at?: string;
          is_playing?: boolean;
          current_time?: number;
          last_sync_at?: string;
        };
        Update: Partial<Database['public']['Tables']['rooms']['Row']>;
      };
      room_participants: {
        Row: {
          id: string;
          room_id: string;
          user_id: string;
          name: string;
          is_host: boolean;
          is_active: boolean;
          joined_at: string;
        };
        Insert: Omit<Database['public']['Tables']['room_participants']['Row'], 'id' | 'joined_at' | 'is_active'> & {
          id?: string;
          joined_at?: string;
          is_active?: boolean;
        };
        Update: Partial<Database['public']['Tables']['room_participants']['Row']>;
      };
      room_messages: {
        Row: {
          id: string;
          room_id: string;
          participant_id: string | null;
          participant_name: string;
          text: string;
          type: 'message' | 'system';
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['room_messages']['Row'], 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['room_messages']['Row']>;
      };
    };
  };
};

# CinemaClub — Full-Stack Private Movie Watch Platform

Watch movies together in private rooms with real-time playback sync and chat.
Built with **React + Vite + TypeScript**, **Supabase** (Auth + Database + Realtime), and **TMDB API**.

## Features

- **TMDB integration** — Browse trending, popular, top-rated, upcoming movies; search & genre filters; movie detail pages
- **Supabase Auth** — Email/password sign-up and sign-in
- **Private rooms** — Create a password-protected room (one active room per user)
- **Real-time sync** — Playback position & play/pause synced via Supabase Realtime
- **Chat** — Live room chat
- **Participants list** — See who is in the room
- **Video sources**
  - Demo open-source streams
  - Custom stream URL (mp4/hls where supported)
  - **Local file** (stays on your device — never uploaded or stored in the database)
- **One room per user** — You cannot create a second room until you delete the first


## Local mode (no Supabase)

By default the app runs in **local mode** (`VITE_USE_LOCAL=true`):

- Auth, rooms, chat, playback sync → **localStorage + BroadcastChannel**
- No Supabase project / SQL schema needed
- Works offline / for demos
- Multi-tab works in the **same browser** (open two tabs, sign up as two users)

To use Supabase instead:

1. Set `VITE_USE_LOCAL=false` in `.env`
2. Run `supabase-schema.sql` in the Supabase SQL Editor
3. Enable Email auth in Supabase Dashboard

## Setup (Supabase only)

### 1. Supabase schema

1. Open your Supabase project: https://lwxnyvurnhlnbzwhwisl.supabase.co  
2. Go to **SQL Editor** → New query  
3. Paste the contents of `supabase-schema.sql` and run it  
4. (Optional) Confirm Realtime is enabled for `rooms`, `room_participants`, `room_messages` under **Database → Replication**

### 2. Auth settings

In Supabase Dashboard → **Authentication → Providers**:

- Enable **Email** provider  
- For local testing you can disable “Confirm email” under Auth → Settings

### 3. Environment

`.env` is already filled with your credentials:

```
VITE_SUPABASE_URL=https://lwxnyvurnhlnbzwhwisl.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_6-h43XQdH-ZMl5VnDN_J6w_Lmc8xOKb
VITE_TMDB_API_KEY=db19b509c93374c42c282767fc5629e
VITE_TMDB_ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9...
```

### 4. Install & run

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Project structure

```
cinemaclub/
├── src/
│   ├── components/     # Navbar, MovieCard
│   ├── contexts/       # AuthContext
│   ├── lib/            # Supabase client
│   ├── pages/          # Home, Browse, Movie, Auth, Create/Join/Watch Room
│   ├── services/       # tmdb.ts, rooms.ts
│   └── utils/          # hash helpers
├── supabase-schema.sql
├── .env
└── package.json
```

## Notes on local files

When the host selects a **local video file**, only the **filename** is stored in the database so other participants know which file to load. The actual video file is **never uploaded** or stored in Supabase/storage. Each participant must load their own copy of the same file to watch in sync.

## Tech stack

- React 19 + Vite 6 + TypeScript
- Tailwind CSS v4
- Supabase JS v2 (Auth, Postgres, Realtime)
- TMDB API v3
- React Router v7

## License

MIT — for educational / personal use.

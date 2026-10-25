# CinemaClub — Security Review and Deployment Notes

**Updated:** 2026-10-24  
**Scope:** Uploaded React/Vite client, room services, local demo store, and supplied Supabase SQL. This is a static source review; the SQL has not been applied to a live database and no penetration test has been performed.

## Current safeguards added in this patch

- Room password hashes are moved into a private `room_passwords` table, outside the Realtime-published `rooms` table.
- New room passwords are salted/bcrypt-hashed in PostgreSQL using `pgcrypto`; legacy SHA-256 hashes are migrated privately and upgraded on successful join.
- Room creation and password-based joining go through security-definer RPCs instead of exposing room hashes to browser code.
- Room, participant, and chat reads are scoped to room membership by RLS. Inactive users can still read their own participant row to support account state, but cannot read room content as an active member.
- Clients cannot directly create participant rows or create system messages. Ordinary chat inserts must match the authenticated user and their room participant name.
- Shared playback changes go through a membership-checking RPC.
- `.env` and `.env.*` are ignored by Git while `.env.example` remains tracked. The supplied `.env` was removed from the project deliverable.
- Vite production source maps are disabled in `vite.config.ts`.

## Important limitations and open items

| Area | Status | Notes |
|---|---|---|
| SQL injection | Low risk in current client queries | Supabase JS query builder parameterizes values; review any future raw SQL/RPC input. |
| XSS | No obvious direct HTML injection found in reviewed paths | Keep chat rendered as ordinary React text; do not add `dangerouslySetInnerHTML` for user content. |
| CSRF/session storage | Review required for threat model | Supabase browser sessions normally use browser storage. Local demo mode is not suitable for hostile multi-tenant production use. |
| Room privacy / IDOR | SQL fix authored, **not live-verified** | Apply schema to staging and test with multiple accounts before deployment. Client-side localStorage grants are not an authorization boundary. |
| Chat spoofing | SQL fix authored, **not live-verified** | System messages are written only by security-definer RPCs; user messages are identity-checked by RLS. |
| Password guessing/rate limiting | Open | Add server-side rate limiting and monitoring for failed room joins. A client-side delay is not sufficient. |
| Password hashing | Improved for Supabase rooms | New passwords use bcrypt; legacy SHA-256 is only supported for migration and upgraded on successful join. Local demo account hashes remain SHA-256 and are demo-only. |
| Secrets | Open until deployment review | Never put Supabase service-role keys, TURN credentials, or other secrets in `VITE_*` variables. Rotate any real credential that was committed or shared unintentionally. |
| CORS / CSP / headers | Hosting configuration required | Restrict allowed origins and set appropriate CSP/security headers at the host. |
| File handling | Local-only in current implementation | The host's video file is not uploaded or streamed to other members yet. |
| WebRTC signaling | Not implemented | Before adding it, use private Supabase Realtime channels with membership RLS; validate sender/target and add STUN/TURN fallback. |
| Dependency vulnerabilities | Not checked | `npm audit` could not be run because the supplied dependency installation is incomplete and registry access is unavailable. |

## Required rollout steps

1. Review `supabase-schema.sql`, apply it to a **staging** Supabase project, and verify the migration before production.
2. Test room creation, wrong password, expired room, private room reads, participant reads, chat writes, room deletion, and playback synchronization with at least two distinct authenticated users.
3. Confirm no service-role key is present in `.env`, frontend bundles, commit history, or issue attachments. Rotate exposed credentials where appropriate.
4. Install dependencies from a network-enabled environment, run `npm ci`, `npm run build`, and `npm audit`.
5. Add rate limiting to room-password verification.
6. Implement and test WebRTC media transport before advertising host-to-viewer streaming. See `STREAMING_PLAN.md`.

## Local demo mode

Local mode stores demo users and rooms in browser storage. A user controlling the browser can inspect or modify this data. Treat local mode as a UI/demo convenience only, never as a production security boundary.

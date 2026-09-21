# DATABASE.md — Data Model

> Phase 0 deliverable. Entity definitions for PostgreSQL (system of record).
> Descriptive only — migrations are written in Phase 1–3. No application code.

## Conventions

- Primary keys: `uuid` (`gen_random_uuid()`), except where noted.
- Every table: `id`, `created_at`, `updated_at` (timestamptz, UTC).
- Soft delete (`deleted_at`) on user-facing content: artists, albums, tracks,
  playlists. Hard delete only for ephemeral rows (sessions, tokens).
- Money stored as integer minor units (`amount_cents`) + ISO `currency`.
- All foreign keys `ON DELETE RESTRICT` by default; cascades only where
  explicitly noted (playlist items, likes on user deletion per privacy policy).
- Time-series tables (play events) are range-partitioned by month.

---

## Entities

### users

A listener account. Identity proof lives with the OIDC provider; this row is
the product profile.

- `id` (uuid, pk)
- `auth_subject` (text, unique) — OIDC `sub` claim; the join key to the provider
- `email` (citext, unique), `email_verified` (bool)
- `display_name` (text), `avatar_url` (text, nullable)
- `role` (enum: `listener`, `artist`, `admin`) — default `listener`; a user can
  be both listener and artist
- `country_code` (char(2)) — for licensing/catalog availability later
- `deleted_at` (timestamptz, nullable)

### artists

The public creator identity. One user may own multiple artist profiles
(bands, side projects).

- `id` (uuid, pk)
- `owner_user_id` (fk → users, nullable for label-imported artists)
- `name` (text), `bio` (text), `image_url` (text, nullable)
- `verified` (bool) — editorial/claim verification
- `deleted_at` (timestamptz, nullable)
- Index: `name` trigram (for search), `(owner_user_id)`

### albums

- `id` (uuid, pk)
- `artist_id` (fk → artists)
- `title` (text), `album_type` (enum: `album`, `single`, `ep`, `compilation`)
- `release_date` (date), `cover_art_url` (text)
- `deleted_at` (timestamptz, nullable)
- Index: `(artist_id, release_date desc)`

### tracks

The core playable entity. One row per song/recording.

- `id` (uuid, pk)
- `album_id` (fk → albums, nullable for loose singles)
- `artist_id` (fk → artists) — primary artist (features handled via join later)
- `title` (text), `duration_ms` (int, from validated audio — never client input)
- `track_number` (int, nullable), `disc_number` (int, default 1)
- `isrc` (text, nullable, unique) — set when known
- `status` (enum: `processing`, `ready`, `failed`, `takedown`) — default `processing`
- `play_count` (bigint, cached counter — reconciled, not authoritative)
- `deleted_at` (timestamptz, nullable)
- Indexes: `(album_id, track_number)`, `(artist_id)`, FTS vector on
  `(title)` composed with artist/album names in a materialized search document
  (see `search_documents` below)

### audio_files

Every stored audio object: the original upload and each transcoded rendition.

- `id` (uuid, pk)
- `track_id` (fk → tracks, cascade)
- `kind` (enum: `original`, `rendition`)
- `codec` (text, e.g. `flac`, `aac`), `bitrate_kbps` (int, nullable for originals)
- `container`/`protocol` (text, e.g. `hls`) for renditions
- `storage_key` (text, unique) — object-store path; never a public URL
- `byte_size` (bigint), `checksum_sha256` (text)
- `variant_label` (text, e.g. `hls-256k`) for renditions
- Index: `(track_id, kind)`

### upload_sessions

Artist upload intake state machine (Phase 4 owns the transitions).

- `id` (uuid, pk)
- `artist_id` (fk → artists), `created_by_user_id` (fk → users)
- `status` (enum: `created`, `uploading`, `validating`, `transcoding`, `ready`, `failed`)
- `original_filename` (text), `mime_type` (text)
- `failure_reason` (text, nullable)
- `idempotency_key` (text, unique)

### playlists

- `id` (uuid, pk)
- `owner_user_id` (fk → users, cascade on user delete)
- `title` (text), `description` (text), `cover_art_url` (text, nullable)
- `visibility` (enum: `private`, `public`, `unlisted`) — default `private`
- `deleted_at` (timestamptz, nullable)
- Index: `(owner_user_id, updated_at desc)`

### playlist_items

Ordered membership. Position managed as fractional rank (no renumbering storms).

- `id` (uuid, pk)
- `playlist_id` (fk → playlists, cascade)
- `track_id` (fk → tracks)
- `position` (double) — fractional ordering key
- `added_by_user_id` (fk → users)
- Unique: `(playlist_id, track_id, position)` not enforced — duplicates allowed
  deliberately (same track twice in a playlist is legal); uniqueness on
  `(playlist_id, id)` only
- Index: `(playlist_id, position)`

### likes (track hearts)

- `user_id` (fk → users, cascade), `track_id` (fk → tracks)
- pk: `(user_id, track_id)`

### follows (user → artist)

- `user_id` (fk → users, cascade), `artist_id` (fk → artists)
- pk: `(user_id, artist_id)`

### plans

Catalog of sellable products. Seeded, rarely mutated.

- `id` (text, pk, e.g. `premium-monthly`) — stable, referenced by clients
- `name` (text), `billing_interval` (enum: `month`, `year`)
- `amount_cents` (int), `currency` (char(3))
- `store` (enum: `apple`, `google`, `stripe`) + `store_product_id` (text)
- `features` (jsonb) — e.g. `{"offline": true, "hq_audio": true}`
- `active` (bool)

### subscriptions

One row per purchase lifecycle; history preserved (never updated in place for
renewals — new rows or status transitions with audit).

- `id` (uuid, pk)
- `user_id` (fk → users)
- `plan_id` (fk → plans)
- `store` (enum: `apple`, `google`, `stripe`), `store_subscription_id` (text)
- `status` (enum: `active`, `past_due`, `canceled`, `expired`)
- `current_period_start` / `current_period_end` (timestamptz)
- Unique: `(store, store_subscription_id)`
- Index: `(user_id, status)` — hot path for entitlement checks

### entitlements

Denormalized "what can this user do right now", rebuilt from subscription
webhooks. The streaming module reads this, not subscription history.

- `user_id` (uuid, pk → users)
- `tier` (enum: `free`, `premium`)
- `premium_since` / `premium_until` (timestamptz, nullable)
- `source` (enum: `apple`, `google`, `stripe`, `promo`)

### playback_sessions

Audit trail for stream authorization (abuse detection, royalty input).

- `id` (uuid, pk)
- `user_id` (fk → users), `track_id` (fk → tracks)
- `tier_at_play` (enum), `started_at` (timestamptz), `completed` (bool)
- Partitioned by month; TTL 13 months, then aggregate into `play_counts_daily`

### search_documents (materialized)

Denormalized FTS document per searchable entity, refreshed on catalog writes.

- `entity_type` (enum: `track`, `album`, `artist`, `playlist`)
- `entity_id` (uuid)
- `document` (tsvector), `display_text` (text)
- pk: `(entity_type, entity_id)`; GIN index on `document`

---

## Relationships (summary)

```
users 1───* artists (owner_user_id)
users 1───* playlists
users *───* tracks      (likes)
users *───* artists     (follows)
artists 1───* albums
artists 1───* tracks
albums 1───* tracks
tracks 1───* audio_files
artists 1───* upload_sessions
playlists 1───* playlist_items *───1 tracks
users 1───* subscriptions *───1 plans
users 1───1 entitlements
users 1───* playback_sessions *───1 tracks
```

## Phase 2 implementation notes (2026-09-21)

Implemented with Prisma in `services/api/prisma/schema.prisma`
(migration `20260921081734_phase2_foundation`). Entities shipped:
`users`, `artists`, `artist_profiles` (1:1, new vs. Phase 0 sketch),
`albums`, `tracks`, `genres` + `track_genres`, `playlists`,
`playlist_tracks`, `likes`, `follows`, `listening_history`,
`subscriptions`.

Deliberate deviations from the Phase 0 sketch, per Phase 2 scope
(no auth / payments / streaming / royalties yet):

- `playback_sessions` → simplified `listening_history`
  (`played_at`, `progress_ms`, `completed`); monthly partitioning deferred.
- `plans` / `entitlements` tables deferred to Phase 8 (billing);
  `subscriptions.plan_id` is a plain string until then.
- `audio_files` / `upload_sessions` arrive with Phase 4 (ingestion).
- `search_documents` arrives with Phase 6 (search).
- `users.auth_subject` (OIDC `sub`) is nullable until Phase 2-auth lands.

All tables: uuid PKs, `created_at`/`updated_at`, soft delete on
user-facing content, `created_by`/`updated_by` audit fields (plain uuid,
no FK — attribution only). Email uses `citext`. FKs `ON DELETE RESTRICT`
except cascades: user-owned rows (playlists, likes, follows,
listening_history, subscriptions), playlist→items, artist→profile,
track→track_genres.

- **Availability/licensing** (territory restrictions) is intentionally absent
  from v1; `users.country_code` reserves the seam.
- **Royalties:** `playback_sessions` → `play_counts_daily` aggregates feed
  payout reports in a later phase; money movement stays in `billing`.
- **Offline downloads:** client-side concern; server only needs to authorize
  renditions for download via the same signed-URL flow (Phase 9).
- **Migrations:** versioned, forward-only, reviewed like code (Phase 1).

// Phase 13 — artist management API wrappers (write paths).
//
// Thin wrappers over the existing Phase 4 artist/album/track write
// endpoints. Every call requires an authenticated client; the backend
// enforces ARTIST/ADMIN roles plus ownership (canManageArtist) — the
// client sends no role or ownership logic of its own. Reads reuse the
// catalog wrappers (listAlbums/listTracks with artistId, getArtist).

import type { ApiClient } from './client';
import type {
  AlbumDetail,
  AlbumType,
  ArtistDetail,
  ArtistListItem,
  ArtistProfile,
  Page,
  TrackDetail,
  TrackStatus,
} from './types';

export interface CreateArtistInput {
  name: string;
}

export interface UpdateArtistInput {
  name: string;
}

export interface UpdateArtistProfileInput {
  bio?: string | null;
  imageUrl?: string | null;
  bannerUrl?: string | null;
  website?: string | null;
  socialLinks?: Record<string, string> | null;
}

export interface CreateAlbumInput {
  title: string;
  artistId: string;
  albumType?: AlbumType;
  /** YYYY-MM-DD */
  releaseDate?: string | null;
  coverArtUrl?: string | null;
}

export interface UpdateAlbumInput {
  title?: string;
  albumType?: AlbumType;
  /** YYYY-MM-DD, or null to clear */
  releaseDate?: string | null;
  coverArtUrl?: string | null;
}

export interface CreateTrackInput {
  title: string;
  artistId: string;
  albumId?: string | null;
  durationMs: number;
  trackNumber?: number | null;
  discNumber?: number;
  isrc?: string | null;
  status?: TrackStatus;
}

export interface UpdateTrackInput {
  title?: string;
  albumId?: string | null;
  durationMs?: number;
  trackNumber?: number | null;
  discNumber?: number;
  isrc?: string | null;
  status?: TrackStatus;
}

// --- Artist identity -------------------------------------------------------

/** Artists owned by the caller, newest first. Any authenticated role. */
export function listMyArtists(client: ApiClient) {
  return client.get<Page<ArtistListItem>>('/v1/me/artists');
}

/** Create an artist owned by the caller. ARTIST/ADMIN only. */
export function createArtist(client: ApiClient, input: CreateArtistInput) {
  return client.post<ArtistDetail>('/v1/artists', input);
}

/** Rename an artist. Owner or admin only. */
export function updateArtist(client: ApiClient, id: string, input: UpdateArtistInput) {
  return client.patch<ArtistDetail>(`/v1/artists/${id}`, input);
}

/** Soft-delete an artist. Owner or admin only; 409 while albums/tracks exist. */
export function deleteArtist(client: ApiClient, id: string) {
  return client.delete<void>(`/v1/artists/${id}`);
}

/** Create or replace the artist's extended profile. Owner or admin only. */
export function updateArtistProfile(
  client: ApiClient,
  id: string,
  input: UpdateArtistProfileInput,
) {
  return client.put<ArtistProfile>(`/v1/artists/${id}/profile`, input);
}

// --- Albums ----------------------------------------------------------------

/** Create an album for an owned artist. ARTIST/ADMIN + ownership. */
export function createAlbum(client: ApiClient, input: CreateAlbumInput) {
  return client.post<AlbumDetail>('/v1/albums', input);
}

/** Update an album of an owned artist. */
export function updateAlbum(client: ApiClient, id: string, input: UpdateAlbumInput) {
  return client.patch<AlbumDetail>(`/v1/albums/${id}`, input);
}

/** Soft-delete an album. 409 while it still has tracks. */
export function deleteAlbum(client: ApiClient, id: string) {
  return client.delete<void>(`/v1/albums/${id}`);
}

// --- Tracks ----------------------------------------------------------------

/** Create a track for an owned artist. ARTIST/ADMIN + ownership. */
export function createTrack(client: ApiClient, input: CreateTrackInput) {
  return client.post<TrackDetail>('/v1/tracks', input);
}

/** Update a track of an owned artist (metadata, album, status). */
export function updateTrack(client: ApiClient, id: string, input: UpdateTrackInput) {
  return client.patch<TrackDetail>(`/v1/tracks/${id}`, input);
}

/** Soft-delete a track. 409 while it sits in any playlist. */
export function deleteTrack(client: ApiClient, id: string) {
  return client.delete<void>(`/v1/tracks/${id}`);
}

// Phase 13 — artist track management.
//
// Lists the caller's own tracks (paginated, artistId-scoped) with their
// draft/published status badges, plus an inline create/edit form and
// per-row delete. Track status (PROCESSING/READY/FAILED/TAKEDOWN) is the
// model's draft/published distinction: new tracks default to
// PROCESSING (draft) until the artist marks them READY.

import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import {
  apiErrorMessage,
  createTrack,
  deleteTrack,
  listAlbums,
  listMyArtists,
  listTracks,
  updateTrack,
  type AlbumListItem,
  type TrackListItem,
  type TrackStatus,
} from '../api';
import { useAuth } from '../auth';
import { TrackRow } from '../catalog';
import { StatusBadge } from '../artist';
import { Button, EmptyState, ErrorState, LoadingState, Screen, TextInput } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

const STATUSES: TrackStatus[] = ['PROCESSING', 'READY', 'FAILED', 'TAKEDOWN'];
const STATUS_LABELS: Record<TrackStatus, string> = {
  PROCESSING: 'Draft',
  READY: 'Published',
  FAILED: 'Failed',
  TAKEDOWN: 'Taken down',
};

type LoadState = 'loading' | 'ready' | 'error';

export function ArtistTracksScreen() {
  const { api } = useAuth();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [artistId, setArtistId] = useState<string | null>(null);
  const [artistAlbums, setArtistAlbums] = useState<AlbumListItem[]>([]);
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  // Form state (shared by create and edit).
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState('');
  const [trackNumber, setTrackNumber] = useState('');
  const [isrc, setIsrc] = useState('');
  const [status, setStatus] = useState<TrackStatus>('PROCESSING');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadPage = useCallback(
    async (id: string, nextPage: number, append: boolean) => {
      const result = await listTracks(api, { artistId: id, page: nextPage, limit: 20 });
      setTracks((prev) => (append ? [...prev, ...result.data] : result.data));
      setTotal(result.pagination.total);
      setPage(nextPage);
    },
    [api],
  );

  const load = useCallback(async () => {
    setLoadState('loading');
    setError(null);
    try {
      const id = (await listMyArtists(api)).data[0]?.id;
      if (!id) {
        setArtistId(null);
        setLoadState('ready');
        return;
      }
      setArtistId(id);
      const [albumsPage] = await Promise.all([
        listAlbums(api, { artistId: id, limit: 100 }),
        loadPage(id, 1, false),
      ]);
      setArtistAlbums(albumsPage.data);
      setLoadState('ready');
    } catch (e) {
      setError(apiErrorMessage(e));
      setLoadState('error');
    }
  }, [api, loadPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setTitle('');
    setAlbumId(null);
    setDurationSeconds('');
    setTrackNumber('');
    setIsrc('');
    setStatus('PROCESSING');
    setFieldErrors({});
    setFormError(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback(
    (track: TrackListItem) => {
      setEditingId(track.id);
      setTitle(track.title);
      setAlbumId(track.albumId);
      setDurationSeconds(String(Math.round(track.durationMs / 1000)));
      setTrackNumber(track.trackNumber ? String(track.trackNumber) : '');
      setIsrc('');
      setStatus(track.status);
      setFieldErrors({});
      setFormError(null);
      setFormOpen(true);
    },
    [],
  );

  const validate = useCallback(() => {
    const errors: Record<string, string> = {};
    if (!title.trim()) errors.title = 'Title is required.';
    else if (title.trim().length > 200) errors.title = 'Title must be 200 characters or fewer.';
    const seconds = Number(durationSeconds);
    if (!durationSeconds.trim() || !Number.isFinite(seconds) || seconds <= 0) {
      errors.durationSeconds = 'Enter a duration in seconds.';
    } else if (seconds * 1000 > 7200000) {
      errors.durationSeconds = 'Tracks are limited to 2 hours.';
    }
    if (trackNumber.trim()) {
      const n = Number(trackNumber);
      if (!Number.isInteger(n) || n < 1) errors.trackNumber = 'Must be a positive integer.';
    }
    if (isrc.trim() && isrc.trim().length > 32) {
      errors.isrc = 'ISRC must be 32 characters or fewer.';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [title, durationSeconds, trackNumber, isrc]);

  const handleSave = useCallback(async () => {
    if (!artistId || !validate()) return;
    setFormError(null);
    setSaving(true);
    try {
      const durationMs = Math.round(Number(durationSeconds) * 1000);
      const body = {
        title: title.trim(),
        albumId: albumId ?? null,
        durationMs,
        trackNumber: trackNumber.trim() ? Number(trackNumber) : null,
        isrc: isrc.trim() ? isrc.trim() : null,
        status,
      };
      if (editingId) {
        await updateTrack(api, editingId, body);
      } else {
        await createTrack(api, { artistId, ...body });
      }
      setFormOpen(false);
      await load();
    } catch (e) {
      setFormError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [
    api,
    albumId,
    artistId,
    durationSeconds,
    editingId,
    isrc,
    load,
    status,
    title,
    trackNumber,
    validate,
  ]);

  const handleDelete = useCallback(
    (track: TrackListItem) => {
      Alert.alert('Delete track', `Delete "${track.title}"? This cannot be undone.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteTrack(api, track.id);
              await load();
            } catch (e) {
              Alert.alert('Could not delete', apiErrorMessage(e));
            }
          },
        },
      ]);
    },
    [api, load],
  );

  const loadMore = useCallback(async () => {
    if (!artistId || loadingMore || tracks.length >= total) return;
    setLoadingMore(true);
    try {
      await loadPage(artistId, page + 1, true);
    } catch {
      // Keep the loaded page; a full reload is available via retry.
    } finally {
      setLoadingMore(false);
    }
  }, [artistId, loadPage, loadingMore, page, total, tracks.length]);

  if (loadState === 'loading') {
    return (
      <Screen testID="artist-tracks-screen">
        <LoadingState message="Loading your tracks…" />
      </Screen>
    );
  }

  if (loadState === 'error') {
    return (
      <Screen testID="artist-tracks-screen">
        <ErrorState message={error ?? 'Something went wrong.'} onRetry={load} />
      </Screen>
    );
  }

  if (!artistId) {
    return (
      <Screen testID="artist-tracks-screen">
        <EmptyState
          title="No artist profile"
          message="Create your artist profile from the dashboard first."
        />
      </Screen>
    );
  }

  return (
    <Screen testID="artist-tracks-screen" scrollable={false} padded={false}>
      <View style={styles.header}>
        <Button title="New track" onPress={openCreate} testID="new-track-button" />
      </View>

      {formOpen ? (
        <View style={styles.form} testID="track-form">
          <Text style={styles.formTitle}>{editingId ? 'Edit track' : 'New track'}</Text>
          <TextInput
            label="Title"
            value={title}
            onChangeText={setTitle}
            error={fieldErrors.title}
            placeholder="Track title"
            testID="track-title"
          />
          <Text style={styles.fieldLabel}>Album (optional)</Text>
          <View style={styles.chips}>
            <Button
              title="No album"
              size="md"
              variant={albumId === null ? 'primary' : 'secondary'}
              onPress={() => setAlbumId(null)}
              testID="track-album-none"
            />
            {artistAlbums.map((a) => (
              <Button
                key={a.id}
                title={a.title}
                size="md"
                variant={albumId === a.id ? 'primary' : 'secondary'}
                onPress={() => setAlbumId(a.id)}
                testID={`track-album-${a.id}`}
              />
            ))}
          </View>
          <TextInput
            label="Duration (seconds)"
            value={durationSeconds}
            onChangeText={setDurationSeconds}
            error={fieldErrors.durationSeconds}
            placeholder="180"
            keyboardType="numeric"
            testID="track-duration"
          />
          <TextInput
            label="Track number (optional)"
            value={trackNumber}
            onChangeText={setTrackNumber}
            error={fieldErrors.trackNumber}
            placeholder="1"
            keyboardType="numeric"
            testID="track-number"
          />
          <TextInput
            label="ISRC (optional)"
            value={isrc}
            onChangeText={setIsrc}
            error={fieldErrors.isrc}
            placeholder="US-ABC-26-00001"
            autoCapitalize="characters"
            testID="track-isrc"
          />
          <Text style={styles.fieldLabel}>Status</Text>
          <View style={styles.chips}>
            {STATUSES.map((s) => (
              <Button
                key={s}
                title={STATUS_LABELS[s]}
                size="md"
                variant={status === s ? 'primary' : 'secondary'}
                onPress={() => setStatus(s)}
                testID={`track-status-${s}`}
              />
            ))}
          </View>
          {formError ? <Text style={styles.formError}>{formError}</Text> : null}
          <View style={styles.formActions}>
            <Button title="Cancel" variant="secondary" onPress={() => setFormOpen(false)} />
            <Button
              title={saving ? 'Saving…' : editingId ? 'Save changes' : 'Create track'}
              onPress={handleSave}
              disabled={saving}
              testID="track-save"
            />
          </View>
        </View>
      ) : null}

      {tracks.length === 0 ? (
        <EmptyState title="No tracks yet" message="Create your first track above." />
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(t) => t.id}
          testID="artist-tracks-list"
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          renderItem={({ item }) => (
            <View style={styles.row} testID={`track-row-${item.id}`}>
              <View style={styles.rowMain}>
                <TrackRow track={item} onPress={() => openEdit(item)} />
              </View>
              <StatusBadge status={item.status} />
              <View style={styles.rowActions}>
                <Button title="Edit" size="md" variant="secondary" onPress={() => openEdit(item)} />
                <Button
                  title="Delete"
                  size="md"
                  variant="secondary"
                  onPress={() => handleDelete(item)}
                  testID={`track-delete-${item.id}`}
                />
              </View>
            </View>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    padding: spacing.md,
    paddingBottom: spacing.sm,
  },
  form: {
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: 12,
    margin: spacing.md,
    marginTop: 0,
  },
  formTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  fieldLabel: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  formActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  formError: {
    color: colors.error,
    fontSize: fontSize.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  rowMain: {
    flex: 1,
  },
  rowActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginLeft: spacing.sm,
  },
});

// Phase 13 — artist album management.
//
// Lists the caller's own albums (paginated, artistId-scoped) with an
// inline create/edit form and per-row delete. All writes go through the
// Phase 4 endpoints; ownership and the 409 "album still has tracks" rule
// are enforced server-side and surfaced here.

import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import {
  apiErrorMessage,
  createAlbum,
  deleteAlbum,
  listAlbums,
  listMyArtists,
  updateAlbum,
  type AlbumListItem,
  type AlbumType,
} from '../api';
import { useAuth } from '../auth';
import { AlbumRow } from '../catalog';
import { Button, EmptyState, ErrorState, LoadingState, Screen, TextInput } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

const ALBUM_TYPES: AlbumType[] = ['ALBUM', 'SINGLE', 'EP', 'COMPILATION'];

type LoadState = 'loading' | 'ready' | 'error';

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function ArtistAlbumsScreen() {
  const { api } = useAuth();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [artistId, setArtistId] = useState<string | null>(null);
  const [albums, setAlbums] = useState<AlbumListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  // Form state (shared by create and edit).
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [albumType, setAlbumType] = useState<AlbumType>('ALBUM');
  const [releaseDate, setReleaseDate] = useState('');
  const [coverArtUrl, setCoverArtUrl] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadPage = useCallback(
    async (id: string, nextPage: number, append: boolean) => {
      const result = await listAlbums(api, { artistId: id, page: nextPage, limit: 20 });
      setAlbums((prev) => (append ? [...prev, ...result.data] : result.data));
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
      await loadPage(id, 1, false);
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
    setAlbumType('ALBUM');
    setReleaseDate('');
    setCoverArtUrl('');
    setFieldErrors({});
    setFormError(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((album: AlbumListItem) => {
    setEditingId(album.id);
    setTitle(album.title);
    setAlbumType(album.albumType);
    setReleaseDate(album.releaseDate ? album.releaseDate.slice(0, 10) : '');
    setCoverArtUrl(album.coverArtUrl ?? '');
    setFieldErrors({});
    setFormError(null);
    setFormOpen(true);
  }, []);

  const validate = useCallback(() => {
    const errors: Record<string, string> = {};
    if (!title.trim()) errors.title = 'Title is required.';
    else if (title.trim().length > 200) errors.title = 'Title must be 200 characters or fewer.';
    if (releaseDate.trim() && !isValidDate(releaseDate.trim())) {
      errors.releaseDate = 'Use YYYY-MM-DD.';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [title, releaseDate]);

  const handleSave = useCallback(async () => {
    if (!artistId || !validate()) return;
    setFormError(null);
    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        albumType,
        releaseDate: releaseDate.trim() ? releaseDate.trim() : null,
        coverArtUrl: coverArtUrl.trim() ? coverArtUrl.trim() : null,
      };
      if (editingId) {
        await updateAlbum(api, editingId, body);
      } else {
        await createAlbum(api, { artistId, ...body });
      }
      setFormOpen(false);
      await load();
    } catch (e) {
      setFormError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [api, albumType, artistId, coverArtUrl, editingId, load, releaseDate, title, validate]);

  const handleDelete = useCallback(
    (album: AlbumListItem) => {
      Alert.alert('Delete album', `Delete "${album.title}"? This cannot be undone.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAlbum(api, album.id);
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
    if (!artistId || loadingMore || albums.length >= total) return;
    setLoadingMore(true);
    try {
      await loadPage(artistId, page + 1, true);
    } catch {
      // Keep the loaded page; a full reload is available via retry.
    } finally {
      setLoadingMore(false);
    }
  }, [albums.length, artistId, loadPage, loadingMore, page, total]);

  if (loadState === 'loading') {
    return (
      <Screen testID="artist-albums-screen">
        <LoadingState message="Loading your albums…" />
      </Screen>
    );
  }

  if (loadState === 'error') {
    return (
      <Screen testID="artist-albums-screen">
        <ErrorState message={error ?? 'Something went wrong.'} onRetry={load} />
      </Screen>
    );
  }

  if (!artistId) {
    return (
      <Screen testID="artist-albums-screen">
        <EmptyState
          title="No artist profile"
          message="Create your artist profile from the dashboard first."
        />
      </Screen>
    );
  }

  return (
    <Screen testID="artist-albums-screen" scrollable={false} padded={false}>
      <View style={styles.header}>
        <Button title="New album" onPress={openCreate} testID="new-album-button" />
      </View>

      {formOpen ? (
        <View style={styles.form} testID="album-form">
          <Text style={styles.formTitle}>{editingId ? 'Edit album' : 'New album'}</Text>
          <TextInput
            label="Title"
            value={title}
            onChangeText={setTitle}
            error={fieldErrors.title}
            placeholder="Album title"
            testID="album-title"
          />
          <Text style={styles.fieldLabel}>Type</Text>
          <View style={styles.chips}>
            {ALBUM_TYPES.map((t) => (
              <Button
                key={t}
                title={t}
                size="md"
                variant={albumType === t ? 'primary' : 'secondary'}
                onPress={() => setAlbumType(t)}
                testID={`album-type-${t}`}
              />
            ))}
          </View>
          <TextInput
            label="Release date"
            value={releaseDate}
            onChangeText={setReleaseDate}
            error={fieldErrors.releaseDate}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            testID="album-release-date"
          />
          <TextInput
            label="Cover art URL"
            value={coverArtUrl}
            onChangeText={setCoverArtUrl}
            placeholder="https://example.com/cover.jpg"
            autoCapitalize="none"
            keyboardType="url"
            testID="album-cover-url"
          />
          {formError ? <Text style={styles.formError}>{formError}</Text> : null}
          <View style={styles.formActions}>
            <Button title="Cancel" variant="secondary" onPress={() => setFormOpen(false)} />
            <Button
              title={saving ? 'Saving…' : editingId ? 'Save changes' : 'Create album'}
              onPress={handleSave}
              disabled={saving}
              testID="album-save"
            />
          </View>
        </View>
      ) : null}

      {albums.length === 0 ? (
        <EmptyState title="No albums yet" message="Create your first release above." />
      ) : (
        <FlatList
          data={albums}
          keyExtractor={(a) => a.id}
          testID="artist-albums-list"
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          renderItem={({ item }) => (
            <View style={styles.row} testID={`album-row-${item.id}`}>
              <View style={styles.rowMain}>
                <AlbumRow album={item} onPress={() => openEdit(item)} />
              </View>
              <View style={styles.rowActions}>
                <Button title="Edit" size="md" variant="secondary" onPress={() => openEdit(item)} />
                <Button
                  title="Delete"
                  size="md"
                  variant="secondary"
                  onPress={() => handleDelete(item)}
                  testID={`album-delete-${item.id}`}
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
  },
});

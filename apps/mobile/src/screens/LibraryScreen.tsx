// Phase 11 — library overview: the authenticated user's personal
// collection. Five independent sections (liked tracks, recently played, my
// playlists, followed artists, public playlists), each with its own
// loading/error/empty state and a drill-down route. Track rows play through
// the shared queue; playlist management lives on the drill-down screens.

import { useCallback, useState, type ReactNode } from 'react';import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { Page, PlaylistDetail } from '../api';
import {
  apiErrorMessage,
  createPlaylist,
  listFollowedArtists,
  listHistory,
  listLikedTracks,
  listMyPlaylists,
  listPublicPlaylists,
} from '../api';
import { useAuth } from '../auth';
import { useQueueActions } from '../player';
import {
  ArtistRow,
  PlaylistRow,
  SectionHeader,
  TrackRow,
  useCatalogDetail,
  type CatalogDetail,
} from '../catalog';
import { Button, EmptyState, Screen } from '../components';
import { LikeButton, PlaylistForm, type PlaylistFormValues } from '../library';
import { colors, fontSize, fontWeight, spacing } from '../theme';

const PREVIEW_LIMIT = 5;

interface SectionProps<T> {
  title: string;
  testID: string;
  detail: CatalogDetail<Page<T>>;
  emptyTitle: string;
  emptyMessage: string;
  onSeeAll: () => void;
  renderPreview: (items: T[]) => ReactNode;
  headerAction?: ReactNode;
}

function Section<T>({
  title,
  testID,
  detail,
  emptyTitle,
  emptyMessage,
  onSeeAll,
  renderPreview,
  headerAction,
}: SectionProps<T>) {
  return (
    <View style={styles.section} testID={testID}>
      <View style={styles.sectionHeaderRow}>
        <View style={styles.sectionTitleWrap}>
          <SectionHeader title={title} onSeeAll={onSeeAll} testID={`${testID}-header`} />
        </View>
        {headerAction}
      </View>
      {detail.loading ? (
        <ActivityIndicator
          color={colors.primary}
          style={styles.inlineLoader}
          testID={`${testID}-loading`}
        />
      ) : detail.error || !detail.data ? (
        <View style={styles.inlineErrorWrap} testID={`${testID}-error`}>
          <Text style={styles.inlineError}>{apiErrorMessage(detail.error)}</Text>
          <Button title="Retry" variant="secondary" size="md" onPress={detail.retry} />
        </View>
      ) : detail.data.data.length === 0 ? (
        <View testID={`${testID}-empty`}>
          <EmptyState title={emptyTitle} message={emptyMessage} />
        </View>
      ) : (
        <View testID={`${testID}-content`}>{renderPreview(detail.data.data)}</View>
      )}
    </View>
  );
}

export function LibraryScreen() {
  const { api } = useAuth();
  const router = useRouter();
  const { playTracks, addToQueue } = useQueueActions();
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [formVisible, setFormVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const liked = useCatalogDetail(() => listLikedTracks(api, { limit: PREVIEW_LIMIT }), [
    api,
    refreshKey,
  ]);
  const history = useCatalogDetail(() => listHistory(api, { limit: PREVIEW_LIMIT }), [
    api,
    refreshKey,
  ]);
  const mine = useCatalogDetail(() => listMyPlaylists(api, { limit: PREVIEW_LIMIT }), [
    api,
    refreshKey,
  ]);
  const followed = useCatalogDetail(() => listFollowedArtists(api, { limit: PREVIEW_LIMIT }), [
    api,
    refreshKey,
  ]);
  const publicPlaylists = useCatalogDetail(() => listPublicPlaylists(api, { limit: PREVIEW_LIMIT }), [
    api,
    refreshKey,
  ]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
    // The detail hooks reload from the refreshKey dep; clear the spinner on
    // the next tick once new loads have started.
    setTimeout(() => setRefreshing(false), 500);
  }, []);

  const createNewPlaylist = useCallback(
    async (values: PlaylistFormValues) => {
      setSaving(true);
      setFormError(null);
      try {
        const created: PlaylistDetail = await createPlaylist(api, {
          title: values.title,
          description: values.description,
          visibility: values.visibility,
        });
        setFormVisible(false);
        router.push(`/playlist/${created.id}`);
      } catch (err) {
        setFormError(apiErrorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [api, router],
  );

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="library-screen">
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        <View style={styles.heading}>
          <Text style={styles.headingText}>Your Library</Text>
        </View>

        <Section
          title="Liked tracks"
          testID="library-section-liked"
          detail={liked}
          emptyTitle="No liked tracks yet"
          emptyMessage="Tap the heart on any track to keep it here."
          onSeeAll={() => router.push('/liked-tracks')}
          renderPreview={(items) =>
            items.map((item, i) => (
              <View key={item.trackId} style={styles.trackRowWrap}>
                <View style={styles.trackRowFlex}>
                  <TrackRow
                    track={item.track}
                    onPress={() =>
                      void playTracks(
                        items.map((entry) => entry.track),
                        i,
                      )
                    }
                    onLongPress={() => void addToQueue(item.track)}
                  />
                </View>
                <LikeButton trackId={item.trackId} />
              </View>
            ))
          }
        />

        <Section
          title="Recently played"
          testID="library-section-history"
          detail={history}
          emptyTitle="Nothing played yet"
          emptyMessage="Tracks you play will show up here."
          onSeeAll={() => router.push('/recently-played')}
          renderPreview={(items) =>
            items.map((item, i) => (
              <View key={item.id} style={styles.trackRowWrap}>
                <View style={styles.trackRowFlex}>
                  <TrackRow
                    track={item.track}
                    onPress={() =>
                      void playTracks(
                        items.map((entry) => entry.track),
                        i,
                      )
                    }
                    onLongPress={() => void addToQueue(item.track)}
                  />
                </View>
                <LikeButton trackId={item.trackId} />
              </View>
            ))
          }
        />

        <Section
          title="My playlists"
          testID="library-section-mine"
          detail={mine}
          emptyTitle="No playlists yet"
          emptyMessage="Create your first playlist to organize your music."
          onSeeAll={() => router.push('/my-playlists')}
          headerAction={
            <Pressable
              onPress={() => setFormVisible(true)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Create playlist"
              style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}
              testID="library-new-playlist"
            >
              <Ionicons name="add" size={fontSize.lg} color={colors.primary} />
              <Text style={styles.newButtonText}>New</Text>
            </Pressable>
          }
          renderPreview={(items) =>
            items.map((playlist) => (
              <PlaylistRow
                key={playlist.id}
                playlist={playlist}
                onPress={() =>
                  router.push(`/playlist/${playlist.id}`)
                }
              />
            ))
          }
        />

        <Section
          title="Followed artists"
          testID="library-section-followed"
          detail={followed}
          emptyTitle="Not following anyone yet"
          emptyMessage="Follow artists to see them here."
          onSeeAll={() => router.push('/followed-artists')}
          renderPreview={(items) =>
            items.map((item) => (
              <ArtistRow
                key={item.artistId}
                artist={{
                  id: item.artist.id,
                  name: item.artist.name,
                  verified: item.artist.verified,
                  followerCount: 0,
                  createdAt: item.createdAt,
                }}
                onPress={() =>
                  router.push(`/artist/${item.artistId}`)
                }
              />
            ))
          }
        />

        <Section
          title="Public playlists"
          testID="library-section-public"
          detail={publicPlaylists}
          emptyTitle="No public playlists"
          emptyMessage="Public playlists from the community will appear here."
          onSeeAll={() => router.push('/playlists')}
          renderPreview={(items) =>
            items.map((playlist) => (
              <PlaylistRow
                key={playlist.id}
                playlist={playlist}
                onPress={() =>
                  router.push(`/playlist/${playlist.id}`)
                }
              />
            ))
          }
        />
      </ScrollView>

      <PlaylistForm
        visible={formVisible}
        mode="create"
        saving={saving}
        error={formError}
        onSubmit={(input) => void createNewPlaylist(input)}
        onClose={() => {
          if (!saving) {
            setFormVisible(false);
          }
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl },
  heading: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  headingText: {
    color: colors.text,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
  },
  section: { marginTop: spacing.lg },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: spacing.lg,
  },
  sectionTitleWrap: { flex: 1 },
  newButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.xs,
  },
  newButtonText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  pressed: { opacity: 0.6 },
  inlineLoader: { paddingVertical: spacing.lg },
  inlineErrorWrap: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  inlineError: {
    color: colors.error,
    fontSize: fontSize.sm,
    textAlign: 'center',
  },
  trackRowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.lg,
  },
  trackRowFlex: { flex: 1 },
});

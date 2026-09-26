// Phase 6 — artist detail: profile header plus the artist's albums and
// top tracks. The artist drives the full-screen states; related rails
// degrade to inline errors so one failing request never hides the profile.

import { useCallback, useEffect, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type { AlbumListItem, ApiClient, ArtistDetail, ArtistPost, TrackListItem } from '../api';
import { apiErrorMessage, getArtist, listAlbums, listArtistPosts, listTracks } from '../api';
import { useAuth } from '../auth';
import { useQueueActions } from '../player';
import { usePlayback } from '../playback';
import { FollowButton } from '../library';
import {
  AlbumCard,
  ArtworkImage,
  TrackRow,
  formatAlbumCount,
  formatFollowerCount,
  formatTrackCount,
} from '../catalog';
import { PostCard } from '../community/components/PostCard';
import { useReactionToggle } from '../community/hooks/useReactionToggle';
import { EmptyState, ErrorState, LoadingState, Screen } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

interface ArtistDetailData {
  artist: ArtistDetail;
  albums: AlbumListItem[];
  tracks: TrackListItem[];
  posts: ArtistPost[];
  postsTotal: number;
  relatedError: unknown;
}

async function loadArtistDetail(api: ApiClient, artistId: string): Promise<ArtistDetailData> {
  const artist = await getArtist(api, artistId);
  const [albumsResult, tracksResult, postsResult] = await Promise.allSettled([
    listAlbums(api, { artistId, limit: 10 }).then((p) => p.data),
    listTracks(api, { artistId, limit: 5 }).then((p) => p.data),
    listArtistPosts(api, artistId, { page: 1, limit: 3 }),
  ]);
  return {
    artist,
    albums: albumsResult.status === 'fulfilled' ? albumsResult.value : [],
    tracks: tracksResult.status === 'fulfilled' ? tracksResult.value : [],
    posts: postsResult.status === 'fulfilled' ? postsResult.value.data : [],
    postsTotal: postsResult.status === 'fulfilled' ? postsResult.value.pagination.total : 0,
    relatedError:
      albumsResult.status === 'rejected'
        ? albumsResult.reason
        : tracksResult.status === 'rejected'
          ? tracksResult.reason
          : postsResult.status === 'rejected'
            ? postsResult.reason
            : null,
  };
}

export function ArtistDetailScreen({ artistId }: { artistId: string }) {
  const { api } = useAuth();
  const router = useRouter();
  // Phase 9 — tapping a top track plays it (the visible tracks become the
  // queue); long-press appends it to the current queue.
  const { playTracks, addToQueue } = useQueueActions();
  const { setQueue } = usePlayback();
  // Phase 29 — reactions on the profile's post preview cards.
  const { applyOverrides, pending, toggle } = useReactionToggle(api);
  const [data, setData] = useState<ArtistDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loadArtistDetail(api, artistId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [api, artistId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="artist-detail-screen">
        <LoadingState message="Loading artist…" />
      </Screen>
    );
  }

  if (error || !data) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="artist-detail-screen">
        <ErrorState message={apiErrorMessage(error)} onRetry={load} />
      </Screen>
    );
  }

  const { artist } = data;
  const profile = artist.profile;

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="artist-detail-screen">
      <Stack.Screen options={{ title: artist.name }} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <ArtworkImage
            uri={profile?.imageUrl}
            title={artist.name}
            seed={artist.id}
            size={120}
            shape="circle"
          />
          <View style={styles.nameRow}>
            <Text style={styles.name}>{artist.name}</Text>
            {artist.verified ? (
              <Ionicons name="checkmark-circle" size={fontSize.lg} color={colors.primary} />
            ) : null}
          </View>
          <Text style={styles.counts}>
            {formatAlbumCount(artist.counts.albums)} • {formatTrackCount(artist.counts.tracks)} •{' '}
            {formatFollowerCount(artist.counts.followers)}
          </Text>
          <View style={styles.followWrap}>
            <FollowButton artistId={artist.id} />
          </View>
          {profile?.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}
        </View>

        {data.relatedError ? (
          <Text style={styles.inlineError}>{apiErrorMessage(data.relatedError)}</Text>
        ) : null}

        {data.albums.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Albums</Text>
            <FlatList
              horizontal
              data={data.albums}
              keyExtractor={(a) => a.id}
              renderItem={({ item }) => (
                <AlbumCard album={item} onPress={() => router.push(`/album/${item.id}`)} />
              )}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.railContent}
            />
          </View>
        ) : null}

        {data.posts.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitleBare}>Posts</Text>
              {data.postsTotal > data.posts.length ? (
                <Text
                  style={styles.seeAll}
                  onPress={() => router.push(`/artist-posts/${artist.id}`)}
                >
                  See all
                </Text>
              ) : null}
            </View>
            {data.posts.map((post) => (
              <View key={post.id} style={styles.postCardWrap}>
                <PostCard
                  post={applyOverrides(post)}
                  onOpen={(p) => router.push(`/post/${p.id}`)}
                  onToggleReaction={toggle}
                  onPlayTrack={(p) => {
                    if (p.track) {
                      void setQueue(
                        [
                          {
                            trackId: p.track.id,
                            title: p.track.title,
                            artistName: p.track.artistName,
                            albumTitle: p.track.albumTitle,
                            durationMs: p.track.durationMs,
                          },
                        ],
                        0,
                      );
                    }
                  }}
                  reactionPending={pending[post.id] === true}
                />
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitleBare}>Tracks</Text>
            {data.tracks.length > 0 ? (
              <Text
                style={styles.seeAll}
                onPress={() =>
                  router.push({
                    pathname: '/tracks',
                    params: { artistId: artist.id, artistName: artist.name },
                  })
                }
              >
                See all
              </Text>
            ) : null}
          </View>
          {data.tracks.length === 0 ? (
            <EmptyState title="No tracks yet" message="This artist hasn't released any tracks." />
          ) : (
            data.tracks.map((track, i) => (
              <TrackRow
                key={track.id}
                track={track}
                index={i + 1}
                onPress={() => void playTracks(data.tracks, i)}
                onLongPress={() => void addToQueue(track)}
              />
            ))
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl },
  header: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  followWrap: {
    marginTop: spacing.md,
  },
  name: {
    color: colors.text,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
  },
  counts: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  },
  bio: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.6,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  inlineError: {
    color: colors.error,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  section: { marginTop: spacing.xl },
  postCardWrap: {
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionTitleBare: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  seeAll: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  railContent: { paddingHorizontal: spacing.lg },
});

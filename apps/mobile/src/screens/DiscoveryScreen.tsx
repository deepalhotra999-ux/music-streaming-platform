// Phase 26 — Discover screen: the For You feed, natural-language
// discovery, and the emerging-artist spotlight.
//
// Honesty rules (enforced by tests):
// - When the backend reports policy.personalized === false, the feed shows
//   the ColdStartBanner and never "for you" language.
// - Reasons are server-provided strings rendered verbatim; the client
//   never invents a reason.
// - The AI-fallback notice appears when policy.aiProvider reports the
//   deterministic fallback, so users know the NL query was not AI-read.
//
// Playback goes through the shared engine via useQueueActions (tap plays
// the section as a queue, long-press offers queue / add-to-playlist).
// Adding to a playlist always asks for confirmation first.

import { useCallback, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  ApiError,
  apiErrorMessage,
  addTrackToPlaylist,
  listMyPlaylists,
  type TrackSummary,
} from '../api';
import { useAuth } from '../auth';
import { EmptyState, ErrorState, LoadingState, Screen } from '../components';
import { useQueueActions } from '../player';
import { colors, fontSize, fontWeight, spacing } from '../theme';
import {
  ColdStartBanner,
  DiscoveryTrackRow,
  EmergingArtistRow,
  QueryBar,
  REASON_SECTION_TITLES,
  feedHeading,
  useDiscoveryQuery,
  useEmergingArtists,
  useRecommendations,
  type DiscoveryTrack,
  type ReasonKind,
  type RecommendationItem,
  type RecommendationsResponse,
} from '../discovery';

/** Map the discovery track DTO onto the playback TrackSummary shape. */
function toTrackSummary(track: DiscoveryTrack): TrackSummary {
  return {
    id: track.id,
    title: track.title,
    durationMs: track.durationMs,
    status: 'READY',
    artistId: track.artist.id,
    artistName: track.artist.name,
    albumId: track.album?.id ?? null,
    albumTitle: track.album?.title ?? null,
  };
}

interface Section {
  kind: ReasonKind;
  items: RecommendationItem[];
}

/** Group items by reasonKind, preserving first-appearance order. */
export function groupByReasonKind(items: RecommendationItem[]): Section[] {
  const groups = new Map<ReasonKind, RecommendationItem[]>();
  for (const item of items) {
    const list = groups.get(item.reasonKind);
    if (list) {
      list.push(item);
    } else {
      groups.set(item.reasonKind, [item]);
    }
  }
  return [...groups.entries()].map(([kind, sectionItems]) => ({ kind, items: sectionItems }));
}

/** True when the AI layer fell back to deterministic interpretation. */
export function isAIFallback(response: RecommendationsResponse | null): boolean {
  return response?.policy.aiProvider === 'deterministic-fallback';
}

function errorMessageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isNetworkError) {
      return "You're offline. Check your connection and try again.";
    }
    if (error.status === 429) {
      return 'Too many requests. Slow down a little and try again soon.';
    }
  }
  return apiErrorMessage(error);
}

export function DiscoveryScreen() {
  const { api } = useAuth();
  const router = useRouter();
  const { playTracks, addToQueue } = useQueueActions();
  const feed = useRecommendations(api);
  const emerging = useEmergingArtists(api);
  const nlQuery = useDiscoveryQuery(api);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    feed.refresh();
    // Emerging artists refresh on their own cadence; the feed is the
    // user-visible refresh target.
    setTimeout(() => setRefreshing(false), 600);
  }, [feed]);

  const playSection = useCallback(
    (items: RecommendationItem[], index: number) => {
      void playTracks(
        items.map((i) => toTrackSummary(i.track)),
        index,
      );
    },
    [playTracks],
  );

  const confirmAddToPlaylist = useCallback(
    (track: DiscoveryTrack) => {
      void (async () => {
        let playlists: { id: string; title: string }[];
        try {
          const page = await listMyPlaylists(api, { limit: 25 });
          playlists = page.data;
        } catch (err) {
          Alert.alert('Playlists unavailable', apiErrorMessage(err));
          return;
        }
        if (playlists.length === 0) {
          Alert.alert(
            'No playlists yet',
            'Create a playlist in your library first, then add tracks to it.',
          );
          return;
        }
        Alert.alert('Add to playlist', `Choose a playlist for “${track.title}”.`, [
          ...playlists.slice(0, 6).map((p) => ({
            text: p.title,
            onPress: () => {
              Alert.alert(
                'Add this track?',
                `Add “${track.title}” by ${track.artist.name} to “${p.title}”?`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Add',
                    onPress: () => {
                      void addTrackToPlaylist(api, p.id, { trackId: track.id })
                        .then(() => {
                          Alert.alert('Added', `“${track.title}” was added to “${p.title}”.`);
                        })
                        .catch((err: unknown) => {
                          Alert.alert('Could not add track', apiErrorMessage(err));
                        });
                    },
                  },
                ],
              );
            },
          })),
          { text: 'Cancel', style: 'cancel' },
        ]);
      })();
    },
    [api],
  );

  const onTrackLongPress = useCallback(
    (track: DiscoveryTrack) => {
      Alert.alert(`“${track.title}”`, 'What would you like to do?', [
        {
          text: 'Add to queue',
          onPress: () => {
            void addToQueue(toTrackSummary(track));
          },
        },
        {
          text: 'Add to playlist…',
          onPress: () => confirmAddToPlaylist(track),
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [addToQueue, confirmAddToPlaylist],
  );

  const sections = useMemo(
    () => (feed.response ? groupByReasonKind(feed.response.items) : []),
    [feed.response],
  );
  const coldStart = feed.response !== null && !feed.response.policy.personalized;
  const feedFallback = isAIFallback(feed.response);
  const queryFallback = isAIFallback(nlQuery.response);

  return (
    <Screen scrollable={false} padded={false} testID="discovery-screen">
      <View style={styles.queryWrap}>
        <QueryBar onSubmit={nlQuery.submit} loading={nlQuery.state === 'loading'} />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {nlQuery.state !== 'idle' ? (
          <QueryResultsBlock
            queryState={nlQuery.state}
            submittedQuery={nlQuery.submittedQuery}
            response={nlQuery.response}
            error={nlQuery.error}
            fallback={queryFallback}
            onRetry={nlQuery.retry}
            onClear={nlQuery.clear}
            onPlay={playSection}
            onLongPress={onTrackLongPress}
          />
        ) : null}

        <Text style={styles.heading} accessibilityRole="header">
          {feedHeading(!coldStart)}
        </Text>
        {feed.state === 'loading' ? (
          <LoadingState message="Finding music for you…" testID="discovery-loading" />
        ) : feed.state === 'error' ? (
          <ErrorState
            message={errorMessageFor(feed.error)}
            onRetry={feed.retry}
            testID="discovery-error"
          />
        ) : feed.response ? (
          <View>
            {coldStart ? <ColdStartBanner /> : null}
            {feedFallback ? <FallbackNotice testID="discovery-feed-fallback" /> : null}
            {sections.length === 0 ? (
              <EmptyState
                title="Nothing to recommend yet"
                message="Listen to some music and this feed will fill up."
                testID="discovery-empty"
              />
            ) : (
              sections.map((section) => (
                <View key={section.kind} style={styles.section}>
                  <Text style={styles.sectionTitle} accessibilityRole="header">
                    {REASON_SECTION_TITLES[section.kind]}
                  </Text>
                  {section.items.map((item, index) => (
                    <DiscoveryTrackRow
                      key={item.track.id}
                      item={item}
                      index={index}
                      onPress={() => playSection(section.items, index)}
                      onLongPress={() => onTrackLongPress(item.track)}
                    />
                  ))}
                </View>
              ))
            )}
          </View>
        ) : null}

        <Text style={styles.heading} accessibilityRole="header">
          Emerging artists
        </Text>
        {emerging.state === 'loading' ? (
          <LoadingState message="Spotting rising artists…" testID="emerging-loading" />
        ) : emerging.state === 'error' ? (
          <ErrorState
            message={errorMessageFor(emerging.error)}
            onRetry={emerging.retry}
            testID="emerging-error"
          />
        ) : emerging.artists.length === 0 ? (
          <EmptyState
            title="No emerging artists right now"
            message="Check back soon — this list updates as new artists grow."
            testID="emerging-empty"
          />
        ) : (
          <View>
            {emerging.artists.map((artist, index) => (
              <EmergingArtistRow
                key={artist.artistId}
                artist={artist}
                index={index}
                onPress={() => router.push(`/artist/${artist.artistId}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function FallbackNotice({ testID }: { testID?: string }) {
  return (
    <View style={styles.fallback} testID={testID}>
      <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
      <Text style={styles.fallbackText}>
        Smart matching was unavailable — showing standard picks instead.
      </Text>
    </View>
  );
}

interface QueryResultsBlockProps {
  queryState: 'loading' | 'ready' | 'error';
  submittedQuery: string;
  response: RecommendationsResponse | null;
  error: unknown;
  fallback: boolean;
  onRetry: () => void;
  onClear: () => void;
  onPlay: (items: RecommendationItem[], index: number) => void;
  onLongPress: (track: DiscoveryTrack) => void;
}

function QueryResultsBlock({
  queryState,
  submittedQuery,
  response,
  error,
  fallback,
  onRetry,
  onClear,
  onPlay,
  onLongPress,
}: QueryResultsBlockProps) {
  const sections = useMemo(() => (response ? groupByReasonKind(response.items) : []), [response]);
  return (
    <View style={styles.queryResults} testID="discovery-query-results">
      <View style={styles.queryHeader}>
        <Text style={styles.sectionTitle} accessibilityRole="header" numberOfLines={1}>
          Results for “{submittedQuery}”
        </Text>
        <Text
          onPress={onClear}
          style={styles.clear}
          accessibilityRole="button"
          accessibilityLabel="Clear search results"
        >
          Clear
        </Text>
      </View>
      {fallback ? <FallbackNotice testID="discovery-query-fallback" /> : null}
      {queryState === 'loading' ? (
        <LoadingState message="Reading your vibe…" testID="discovery-query-loading" />
      ) : queryState === 'error' ? (
        <ErrorState
          message={errorMessageFor(error)}
          onRetry={onRetry}
          testID="discovery-query-error"
        />
      ) : sections.length === 0 ? (
        <EmptyState
          title="No matches"
          message="Try describing a different mood, genre, or activity."
          testID="discovery-query-empty"
        />
      ) : (
        sections.map((section) => (
          <View key={section.kind}>
            {section.items.map((item, index) => (
              <DiscoveryTrackRow
                key={item.track.id}
                item={item}
                index={index}
                onPress={() => onPlay(section.items, index)}
                onLongPress={() => onLongPress(item.track)}
              />
            ))}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  queryWrap: {
    paddingTop: spacing.sm,
  },
  content: {
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
  heading: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  section: {
    marginBottom: spacing.md,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    flex: 1,
  },
  queryResults: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.md,
    marginBottom: spacing.sm,
  },
  queryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.lg,
    marginBottom: spacing.xs,
  },
  clear: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    padding: spacing.sm,
  },
  fallback: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: 8,
  },
  fallbackText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    flex: 1,
  },
});

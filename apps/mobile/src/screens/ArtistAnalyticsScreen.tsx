// Phase 15 — Artist Analytics screen (ARTIST-only area).
//
// Server-computed playback analytics for the artist's own catalog:
// headline totals, a streams trend chart, top tracks/albums, and recent
// completed plays. All metrics come from the Phase 15 analytics endpoints
// (computed server-side from the play_events stream); this screen only
// picks the artist, the date range, and renders. Every section carries
// loading/empty/error states via the design-system state views.

import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  apiErrorMessage,
  getArtistAlbumStats,
  getArtistOverview,
  getArtistRecentActivity,
  getArtistTrackStats,
  getArtistTrend,
  listMyArtists,
  type AlbumAnalytics,
  type AnalyticsOverview,
  type AnalyticsRange,
  type AnalyticsTrend,
  type ArtistListItem,
  type RecentPlay,
  type TrackAnalytics,
  type TrendGranularity,
} from '../api';
import { useAuth } from '../auth';
import { formatTotalDuration } from '../catalog';
import { formatRelativeTime } from '../library';
import { Button, EmptyState, ErrorState, LoadingState, Screen } from '../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';
import { formatBucketDate, formatCompact } from '../analytics/format';

type LoadState = 'loading' | 'ready' | 'error';

const RANGES: Array<{ value: AnalyticsRange; label: string }> = [
  { value: '7d', label: '7D' },
  { value: '28d', label: '28D' },
  { value: '90d', label: '90D' },
  { value: 'all', label: 'All' },
];

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  '7d': 'last 7 days',
  '28d': 'last 28 days',
  '90d': 'last 90 days',
  all: 'all time',
};

function granularityFor(range: AnalyticsRange): TrendGranularity {
  return range === '7d' || range === '28d' ? 'day' : 'week';
}

const CHART_HEIGHT = 120;

interface Props {
  /** Pre-selected artist (from the dashboard); defaults to the first owned artist. */
  initialArtistId?: string;
}

export function ArtistAnalyticsScreen({ initialArtistId }: Props) {
  const { api } = useAuth();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [artists, setArtists] = useState<ArtistListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialArtistId ?? null);
  const [range, setRange] = useState<AnalyticsRange>('28d');
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [trend, setTrend] = useState<AnalyticsTrend | null>(null);
  const [tracks, setTracks] = useState<TrackAnalytics[]>([]);
  const [albums, setAlbums] = useState<AlbumAnalytics[]>([]);
  const [recent, setRecent] = useState<RecentPlay[]>([]);

  const load = useCallback(
    async (artistId: string | null, nextRange: AnalyticsRange) => {
      setLoadState('loading');
      setError(null);
      try {
        const mine = await listMyArtists(api);
        setArtists(mine.data);
        const activeId = artistId ?? mine.data[0]?.id ?? null;
        setSelectedId(activeId);
        if (!activeId) {
          setOverview(null);
          setTrend(null);
          setTracks([]);
          setAlbums([]);
          setRecent([]);
          setLoadState('ready');
          return;
        }
        if (artistId === null) {
          // Bootstrap pass: the artist id just resolved (selectedId was
          // null on mount). The effect below refires with the resolved id
          // and performs the single analytics fetch — returning here avoids
          // a duplicate fetch and a ready → loading → ready flicker.
          return;
        }
        const [ov, tr, trackPage, albumPage, recentRes] = await Promise.all([
          getArtistOverview(api, activeId, { range: nextRange }),
          getArtistTrend(api, activeId, {
            range: nextRange,
            granularity: granularityFor(nextRange),
          }),
          getArtistTrackStats(api, activeId, { range: nextRange, limit: 5 }),
          getArtistAlbumStats(api, activeId, { range: nextRange, limit: 5 }),
          getArtistRecentActivity(api, activeId, { range: nextRange, limit: 10 }),
        ]);
        setOverview(ov);
        setTrend(tr);
        setTracks(trackPage.data);
        setAlbums(albumPage.data);
        setRecent(recentRes.data);
        setLoadState('ready');
      } catch (e) {
        setError(apiErrorMessage(e));
        setLoadState('error');
      }
    },
    [api],
  );

  useEffect(() => {
    void load(selectedId, range);
  }, [load, selectedId, range]);

  const changeRange = useCallback(
    (next: AnalyticsRange) => {
      setRange(next);
      void load(selectedId, next);
    },
    [load, selectedId],
  );

  const changeArtist = useCallback(
    (artistId: string) => {
      setSelectedId(artistId);
      void load(artistId, range);
    },
    [load, range],
  );

  const retry = useCallback(() => {
    void load(selectedId, range);
  }, [load, selectedId, range]);

  if (loadState === 'loading') {
    return (
      <Screen testID="analytics-screen">
        <LoadingState message="Loading analytics…" />
      </Screen>
    );
  }

  if (loadState === 'error') {
    return (
      <Screen testID="analytics-screen">
        <ErrorState message={error ?? 'Something went wrong.'} onRetry={retry} />
      </Screen>
    );
  }

  if (artists.length === 0) {
    return (
      <Screen testID="analytics-screen">
        <EmptyState
          title="No artist profile yet"
          message="Create your artist profile before viewing analytics."
        />
      </Screen>
    );
  }

  const hasPlays = (overview?.starts ?? 0) > 0;

  return (
    <Screen testID="analytics-screen" scrollable={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {artists.length > 1 ? (
          <View style={styles.switcher} testID="artist-switcher">
            {artists.map((a) => (
              <Button
                key={a.id}
                title={a.name}
                variant={a.id === selectedId ? 'primary' : 'secondary'}
                size="md"
                onPress={() => changeArtist(a.id)}
                testID={`artist-switch-${a.id}`}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.rangeRow} testID="range-selector">
          {RANGES.map((r) => (
            <Button
              key={r.value}
              title={r.label}
              variant={r.value === range ? 'primary' : 'secondary'}
              size="md"
              onPress={() => changeRange(r.value)}
              testID={`range-${r.value}`}
            />
          ))}
        </View>

        {!hasPlays ? (
          <EmptyState
            title="No plays yet"
            message={`Streams will appear here once listeners play your music in the ${RANGE_LABELS[range]}.`}
            testID="analytics-empty"
          />
        ) : (
          <>
            <View style={styles.statGrid} testID="stat-grid">
              <StatCard
                testID="stat-streams"
                label="Streams"
                value={formatCompact(overview?.streams ?? 0)}
              />
              <StatCard
                testID="stat-listeners"
                label="Listeners"
                value={formatCompact(overview?.uniqueListeners ?? 0)}
              />
              <StatCard
                testID="stat-listening-time"
                label="Listening time"
                value={formatTotalDuration(overview?.listeningTimeMs ?? 0)}
              />
              <StatCard
                testID="stat-starts"
                label="Play attempts"
                value={formatCompact(overview?.starts ?? 0)}
              />
            </View>
            {(overview?.failedPlays ?? 0) > 0 || (overview?.incompletePlays ?? 0) > 0 ? (
              <Text style={styles.outcomeNote} testID="outcome-note">
                {overview?.failedPlays} failed · {overview?.incompletePlays} incomplete plays in
                this range
              </Text>
            ) : null}

            <Text style={styles.sectionTitle} testID="trend-title">
              Streams per {trend?.granularity === 'week' ? 'week' : 'day'}
            </Text>
            {trend && trend.points.length > 0 ? (
              <View style={styles.chartCard} testID="trend-chart">
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.chartRow}>
                    {trend.points.map((point, index) => (
                      <TrendBar
                        key={point.date}
                        streams={point.streams}
                        maxStreams={Math.max(1, ...trend.points.map((p) => p.streams))}
                        label={formatBucketDate(point.date)}
                        showLabel={
                          trend.points.length <= 10 ||
                          index === 0 ||
                          index === trend.points.length - 1
                        }
                      />
                    ))}
                  </View>
                </ScrollView>
              </View>
            ) : (
              <Text style={styles.emptyNote}>No trend data in this range.</Text>
            )}

            <Text style={styles.sectionTitle}>Top tracks</Text>
            {tracks.length === 0 ? (
              <Text style={styles.emptyNote}>No track plays in this range.</Text>
            ) : (
              <View style={styles.listCard} testID="top-tracks">
                {tracks.map((track, index) => (
                  <RankedRow
                    key={track.trackId}
                    rank={index + 1}
                    title={track.title}
                    detail={`${formatCompact(track.streams)} streams · ${formatCompact(track.uniqueListeners)} listeners`}
                  />
                ))}
              </View>
            )}

            <Text style={styles.sectionTitle}>Top albums</Text>
            {albums.length === 0 ? (
              <Text style={styles.emptyNote}>No album plays in this range.</Text>
            ) : (
              <View style={styles.listCard} testID="top-albums">
                {albums.map((album, index) => (
                  <RankedRow
                    key={album.albumId}
                    rank={index + 1}
                    title={album.title}
                    detail={`${formatCompact(album.streams)} streams · ${formatCompact(album.uniqueListeners)} listeners`}
                  />
                ))}
              </View>
            )}

            <Text style={styles.sectionTitle}>Recent activity</Text>
            {recent.length === 0 ? (
              <Text style={styles.emptyNote}>No completed streams in this range.</Text>
            ) : (
              <View style={styles.listCard} testID="recent-activity">
                {recent.map((play) => (
                  <View key={play.sessionId} style={styles.recentRow}>
                    <View style={styles.recentText}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {play.trackTitle}
                      </Text>
                      <Text style={styles.rowDetail}>{formatRelativeTime(play.playedAt)}</Text>
                    </View>
                    <Text style={styles.rowDetail}>
                      {formatTotalDuration(play.listeningTimeMs)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function StatCard({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View style={styles.statCard} testID={testID}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function TrendBar({
  streams,
  maxStreams,
  label,
  showLabel,
}: {
  streams: number;
  maxStreams: number;
  label: string;
  showLabel: boolean;
}) {
  return (
    <View style={styles.barColumn}>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { height: Math.max(3, Math.round((streams / maxStreams) * CHART_HEIGHT)) },
          ]}
        />
      </View>
      {showLabel ? (
        <Text style={styles.barLabel} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

function RankedRow({ rank, title, detail }: { rank: number; title: string; detail: string }) {
  return (
    <View style={styles.rankedRow}>
      <Text style={styles.rank}>{rank}</Text>
      <View style={styles.recentText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  switcher: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  statCard: {
    flexBasis: '48%',
    flexGrow: 1,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  statValue: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  },
  outcomeNote: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  chartCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  chartRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    minHeight: CHART_HEIGHT + 24,
  },
  barColumn: {
    alignItems: 'center',
    width: 36,
  },
  barTrack: {
    height: CHART_HEIGHT,
    justifyContent: 'flex-end',
  },
  barFill: {
    width: 20,
    borderRadius: radii.sm,
    backgroundColor: colors.primary,
  },
  barLabel: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    marginTop: spacing.xs,
  },
  listCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
  },
  rankedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  rank: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    width: 24,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  recentText: {
    flex: 1,
    marginRight: spacing.sm,
  },
  rowTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  rowDetail: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  emptyNote: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
});

// Phase 21 — Artist Royalties screen (ARTIST-only area).
//
// Server-computed royalty earnings for the artist's own catalog: lifetime
// totals, per-period earnings, and per-track breakdowns. All amounts come
// from the Phase 21 royalty endpoints (computed server-side from eligible
// streams and verified revenue inputs); this screen only picks the artist
// and renders. Every section carries loading/empty/error states.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  apiErrorMessage,
  formatMoney,
  getRoyaltyOverview,
  getRoyaltyPeriods,
  listMyArtists,
  type ArtistListItem,
  type RoyaltyOverview,
  type RoyaltyPeriodItem,
} from '../api';
import { useAuth } from '../auth';
import { EmptyState, ErrorState, LoadingState, Screen } from '../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

type LoadState = 'loading' | 'ready' | 'error';

interface Props {
  /** Pre-selected artist (from the dashboard); defaults to the first owned artist. */
  initialArtistId?: string;
}

function formatPeriodLabel(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', year: 'numeric' };
  // Period end is exclusive; show the day before for a clean label.
  const eInclusive = new Date(e.getTime() - 1);
  return `${s.toLocaleDateString(undefined, opts)} – ${eInclusive.toLocaleDateString(undefined, opts)}`;
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  CALCULATING: 'Calculating',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export function ArtistRoyaltiesScreen({ initialArtistId }: Props) {
  const { api } = useAuth();
  const router = useRouter();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [artists, setArtists] = useState<ArtistListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialArtistId ?? null);
  const [overview, setOverview] = useState<RoyaltyOverview | null>(null);
  const [periods, setPeriods] = useState<RoyaltyPeriodItem[]>([]);
  const bootstrapped = useRef(false);

  const load = useCallback(
    async (artistId: string) => {
      setLoadState('loading');
      setError(null);
      setUnauthorized(false);
      try {
        const [ov, per] = await Promise.all([
          getRoyaltyOverview(api, artistId),
          getRoyaltyPeriods(api, artistId, 1, 12),
        ]);
        setOverview(ov);
        setPeriods(per.data);
        setLoadState('ready');
      } catch (e) {
        const msg = apiErrorMessage(e);
        // 403 = not an artist or not the owner; show a distinct unauthorized state.
        if (msg.includes('403') || msg.toLowerCase().includes('forbidden')) {
          setUnauthorized(true);
        } else {
          setError(msg);
        }
        setLoadState('error');
      }
    },
    [api],
  );

  // Bootstrap: fetch owned artists once on mount (if no initial ID).
  useEffect(() => {
    if (initialArtistId || bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      try {
        const mine = await listMyArtists(api);
        setArtists(mine.data);
        const first = mine.data[0]?.id ?? null;
        setSelectedId(first);
        if (!first) setLoadState('ready');
      } catch (e) {
        setError(apiErrorMessage(e));
        setLoadState('error');
      }
    })();
  }, [api, initialArtistId]);

  // Load royalty data when the selected artist changes.
  useEffect(() => {
    if (selectedId) {
      void load(selectedId);
    }
  }, [load, selectedId]);

  const togglePeriod = useCallback(
    async (period: RoyaltyPeriodItem) => {
      // Phase 22: navigate to the full statement detail screen.
      if (!selectedId) return;
      router.push({
        pathname: '/(artist)/royalties/[periodId]',
        params: { artistId: selectedId, periodId: period.periodId },
      });
    },
    [router, selectedId],
  );

  const retry = useCallback(() => {
    if (selectedId) void load(selectedId);
  }, [load, selectedId]);

  if (loadState === 'loading') {
    return (
      <Screen>
        <LoadingState message="Loading royalties…" />
      </Screen>
    );
  }

  if (loadState === 'error') {
    if (unauthorized) {
      return (
        <Screen>
          <EmptyState
            title="Not authorized"
            message="You don't have access to royalty earnings. This area is for artists and admins only."
          />
        </Screen>
      );
    }
    return (
      <Screen>
        <ErrorState message={error ?? 'Failed to load royalties.'} onRetry={retry} />
      </Screen>
    );
  }

  if (artists.length === 0 && !overview) {
    return (
      <Screen>
        <EmptyState
          title="No artist profile"
          message="You need an artist profile to view royalties."
        />
      </Screen>
    );
  }

  const noEarnings = overview && overview.completedPeriods === 0;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.container}>
        {artists.length > 1 && (
          <View style={styles.artistRow}>
            {artists.map((a) => (
              <TouchableOpacity
                key={a.id}
                accessibilityRole="button"
                accessibilityState={{ selected: a.id === selectedId }}
                onPress={() => {
                  setSelectedId(a.id);
                }}
                style={[styles.artistChip, a.id === selectedId && styles.artistChipActive]}
              >
                <Text
                  style={[
                    styles.artistChipText,
                    a.id === selectedId && styles.artistChipTextActive,
                  ]}
                  numberOfLines={1}
                >
                  {a.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {overview && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Total earnings</Text>
            <Text style={styles.bigAmount} testID="total-earnings">
              {formatMoney(overview.totalEarnings, overview.currency)}
            </Text>
            <Text style={styles.subtle}>
              {overview.totalStreams.toLocaleString()} eligible streams ·{' '}
              {overview.completedPeriods} completed period
              {overview.completedPeriods === 1 ? '' : 's'}
            </Text>
            {overview.latestPeriod && (
              <View style={styles.latestBox}>
                <Text style={styles.cardLabel}>Latest period</Text>
                <Text style={styles.latestAmount}>
                  {formatMoney(overview.latestPeriod.earnings, overview.currency)}
                </Text>
                <Text style={styles.subtle}>
                  {formatPeriodLabel(
                    overview.latestPeriod.periodStart,
                    overview.latestPeriod.periodEnd,
                  )}{' '}
                  · {overview.latestPeriod.streams.toLocaleString()} streams · Policy v
                  {overview.latestPeriod.policyVersion}
                </Text>
              </View>
            )}
          </View>
        )}

        {noEarnings ? (
          <EmptyState
            title="No royalties yet"
            message="Earnings appear here after a royalty period is calculated. Streams are counted from completed playback sessions."
          />
        ) : (
          <View>
            <Text style={styles.sectionTitle}>Periods</Text>
            {periods.map((p) => {
              return (
                <View key={p.periodId} style={styles.periodCard}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`${formatPeriodLabel(p.periodStart, p.periodEnd)}, ${STATUS_LABELS[p.status] ?? p.status}. View statement.`}
                    onPress={() => void togglePeriod(p)}
                    style={styles.periodHeader}
                  >
                    <View style={styles.periodHeaderText}>
                      <Text style={styles.periodTitle}>
                        {formatPeriodLabel(p.periodStart, p.periodEnd)}
                      </Text>
                      <Text style={styles.subtle}>
                        {STATUS_LABELS[p.status] ?? p.status}
                        {p.policyVersion != null ? ` · Policy v${p.policyVersion}` : ''}
                      </Text>
                    </View>
                    <View style={styles.periodAmounts}>
                      <Text style={styles.periodEarnings}>
                        {p.status === 'COMPLETED'
                          ? formatMoney(p.earnings, p.currency)
                          : STATUS_LABELS[p.status] ?? p.status}
                      </Text>
                      <Text style={styles.subtle}>{p.streams.toLocaleString()} streams</Text>
                    </View>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}

        <Text style={styles.disclaimer}>
          Earnings are calculated from eligible streams (completed playback sessions) and verified
          subscription revenue under the active royalty policy. Amounts are recorded earnings only —
          payouts are handled separately.
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    gap: spacing.md,
  },
  artistRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  artistChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
  },
  artistChipActive: {
    backgroundColor: colors.primary,
  },
  artistChipText: {
    color: colors.text,
    fontSize: fontSize.sm,
  },
  artistChipTextActive: {
    color: colors.onPrimary,
    fontWeight: fontWeight.semibold,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  cardLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  bigAmount: {
    color: colors.text,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
  },
  subtle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  latestBox: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 2,
  },
  latestAmount: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  periodCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  periodHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.md,
  },
  periodHeaderText: {
    flex: 1,
    gap: 2,
  },
  periodTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  periodAmounts: {
    alignItems: 'flex-end',
    gap: 2,
  },
  periodEarnings: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  tracksBox: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  trackRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  trackInfo: {
    flex: 1,
    gap: 2,
  },
  trackTitle: {
    color: colors.text,
    fontSize: fontSize.md,
  },
  trackAmount: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },
  disclaimer: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: fontSize.xs * 1.5,
  },
});

// Re-export for the route file.
export default ArtistRoyaltiesScreen;

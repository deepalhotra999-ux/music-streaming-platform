// Phase 22 — Royalty Transparency. Period detail screen.
//
// Server-generated royalty statement for an artist and period: summary,
// explainable calculation, track-level breakdown, policy information, and
// CSV export. All values come from the Phase 22 statement endpoints; this
// screen never computes earnings.

import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  apiErrorMessage,
  downloadStatementCsv,
  formatMoney,
  getRoyaltyStatement,
  getStatementTracks,
  type RoyaltyStatement,
  type StatementTrack,
} from '../api';
import { useAuth } from '../auth';
import { Button, EmptyState, ErrorState, LoadingState, Screen } from '../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

type LoadState = 'loading' | 'ready' | 'error';

interface Props {
  artistId: string;
  periodId: string;
}

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Finalized',
  PENDING: 'Pending',
  RUNNING: 'Calculating',
  FAILED: 'Failed',
};

const STATUS_DESCRIPTIONS: Record<string, string> = {
  COMPLETED: 'This calculation is complete and the amounts below are final.',
  PENDING:
    'This period has not been calculated yet. Earnings will appear once the calculation completes.',
  RUNNING: 'Calculation is in progress. Amounts are not final yet.',
  FAILED: 'This calculation failed. No earnings were recorded for this period.',
};

function formatPeriodLabel(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  const eInclusive = new Date(e.getTime() - 1);
  return `${s.toLocaleDateString(undefined, opts)} – ${eInclusive.toLocaleDateString(undefined, opts)}`;
}

export function RoyaltyPeriodDetailScreen({ artistId, periodId }: Props) {
  const { api } = useAuth();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [statement, setStatement] = useState<RoyaltyStatement | null>(null);
  const [tracks, setTracks] = useState<StatementTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    setError(null);
    setUnauthorized(false);
    try {
      const stmt = await getRoyaltyStatement(api, artistId, periodId);
      setStatement(stmt);
      setLoadState('ready');
      if (stmt.status === 'COMPLETED') {
        setTracksLoading(true);
        setTracksError(null);
        try {
          const res = await getStatementTracks(api, artistId, periodId, 1, 50, 'earnings');
          setTracks(res.data);
        } catch (e) {
          setTracksError(apiErrorMessage(e));
        } finally {
          setTracksLoading(false);
        }
      }
    } catch (e) {
      const msg = apiErrorMessage(e);
      if (msg.includes('403') || msg.toLowerCase().includes('forbidden')) {
        setUnauthorized(true);
      } else {
        setError(msg);
      }
      setLoadState('error');
    }
  }, [api, artistId, periodId]);

  useEffect(() => {
    void load();
  }, [load]);

  const retryTracks = useCallback(async () => {
    setTracksLoading(true);
    setTracksError(null);
    try {
      const res = await getStatementTracks(api, artistId, periodId, 1, 50, 'earnings');
      setTracks(res.data);
    } catch (e) {
      setTracksError(apiErrorMessage(e));
    } finally {
      setTracksLoading(false);
    }
  }, [api, artistId, periodId]);

  const exportCsv = useCallback(async () => {
    if (!statement || exporting) return;
    setExporting(true);
    try {
      const csv = await downloadStatementCsv(api, artistId, periodId);
      const filename = `${statement.statementReference}.csv`;
      const file = new FileSystem.File(FileSystem.Paths.document, filename);
      file.write(csv);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'text/csv',
          dialogTitle: 'Royalty Statement',
        });
      } else {
        Alert.alert('Statement saved', `Saved to ${filename}`);
      }
    } catch (e) {
      Alert.alert('Export failed', apiErrorMessage(e));
    } finally {
      setExporting(false);
    }
  }, [api, artistId, periodId, statement, exporting]);

  if (loadState === 'loading') {
    return (
      <Screen>
        <LoadingState message="Loading statement…" />
      </Screen>
    );
  }

  if (loadState === 'error') {
    if (unauthorized) {
      return (
        <Screen>
          <EmptyState
            title="Not authorized"
            message="You don't have access to this royalty statement."
          />
        </Screen>
      );
    }
    return (
      <Screen>
        <ErrorState message={error ?? 'Failed to load statement.'} onRetry={() => void load()} />
      </Screen>
    );
  }

  if (!statement) {
    return (
      <Screen>
        <EmptyState title="No statement" message="Statement data is not available." />
      </Screen>
    );
  }

  const isFinalized = statement.status === 'COMPLETED';

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Header */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Royalty statement</Text>
          <Text style={styles.periodTitle}>
            {formatPeriodLabel(statement.periodStart, statement.periodEnd)}
          </Text>
          <Text style={styles.subtle}>Ref {statement.statementReference}</Text>
          <View
            style={[
              styles.statusBadge,
              styles[`status${statement.status}` as keyof typeof styles] as object,
            ]}
          >
            <Text style={styles.statusText}>{STATUS_LABELS[statement.status]}</Text>
          </View>
          <Text style={styles.subtle}>{STATUS_DESCRIPTIONS[statement.status]}</Text>
        </View>

        {/* Summary */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Summary</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Eligible streams</Text>
            <Text style={styles.rowValue}>{statement.eligibleStreams.toLocaleString()}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Your share of streams</Text>
            <Text style={styles.rowValue}>{statement.artistSharePercentage}%</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Your allocation</Text>
            <Text style={styles.rowValue}>
              {isFinalized ? formatMoney(statement.artistAllocation, statement.currency) : '—'}
            </Text>
          </View>
          {statement.adjustmentsTotal !== '0.00' && (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Adjustments</Text>
              <Text style={styles.rowValue}>
                {formatMoney(statement.adjustmentsTotal, statement.currency)}
              </Text>
            </View>
          )}
          <View style={[styles.row, styles.totalRow]}>
            <Text style={styles.totalLabel}>Final earnings</Text>
            <Text style={styles.totalValue} testID="statement-earnings">
              {isFinalized ? formatMoney(statement.finalEarnings, statement.currency) : '—'}
            </Text>
          </View>
          {!isFinalized && (
            <Text style={styles.subtle}>
              Final earnings will appear here once the calculation completes.
            </Text>
          )}
        </View>

        {/* Explainable calculation */}
        {isFinalized && statement.calculation.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>How this was calculated</Text>
            {statement.calculation.map((step, i) => (
              <View key={i} style={styles.step}>
                <View style={styles.stepHeader}>
                  <Text style={styles.stepNumber}>{i + 1}</Text>
                  <Text style={styles.stepLabel}>{step.label}</Text>
                  <Text style={styles.stepValue}>{step.value}</Text>
                </View>
                <Text style={styles.stepExplanation}>{step.explanation}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Track breakdown */}
        {isFinalized && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Tracks</Text>
            {tracksLoading ? (
              <LoadingState message="Loading tracks…" />
            ) : tracksError ? (
              <ErrorState message={tracksError} onRetry={() => void retryTracks()} />
            ) : tracks.length === 0 ? (
              <Text style={styles.subtle}>No track earnings in this period.</Text>
            ) : (
              tracks.map((t) => (
                <View key={t.trackId} style={styles.trackRow}>
                  <View style={styles.trackInfo}>
                    <Text style={styles.trackTitle} numberOfLines={1}>
                      {t.title}
                    </Text>
                    <Text style={styles.subtle}>
                      {t.eligibleStreams.toLocaleString()} streams · {t.shareOfArtistStreams}% of
                      your streams
                    </Text>
                  </View>
                  <Text style={styles.trackAmount}>{formatMoney(t.finalAmount, t.currency)}</Text>
                </View>
              ))
            )}
          </View>
        )}

        {/* Policy */}
        {statement.policy && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Policy</Text>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Version</Text>
              <Text style={styles.rowValue}>v{statement.policy.version}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Name</Text>
              <Text style={styles.rowValue}>{statement.policy.name}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Effective from</Text>
              <Text style={styles.rowValue}>
                {new Date(statement.policy.effectiveFrom).toLocaleDateString()}
              </Text>
            </View>
            {statement.policy.isTestPolicy && (
              <Text style={styles.testPolicyBadge}>Test policy — values are placeholders</Text>
            )}
            <Text style={styles.policyHeading}>Stream eligibility</Text>
            <Text style={styles.policyText}>{statement.policy.streamEligibilityRule}</Text>
            <Text style={styles.policyHeading}>Allocation</Text>
            <Text style={styles.policyText}>{statement.policy.allocationMethodology}</Text>
            <Text style={styles.policyHeading}>Rounding</Text>
            <Text style={styles.policyText}>{statement.policy.roundingMethodology}</Text>
          </View>
        )}

        {/* Export */}
        {isFinalized && (
          <Button
            title={exporting ? 'Exporting…' : 'Download CSV statement'}
            onPress={() => void exportCsv()}
            disabled={exporting}
            testID="export-csv-button"
          />
        )}

        <Text style={styles.disclaimer}>
          This statement is generated from auditable royalty records. Amounts are recorded earnings
          only — payouts are handled separately.
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
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  periodTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  subtle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.pill,
  },
  statusCOMPLETED: { backgroundColor: colors.success },
  statusPENDING: { backgroundColor: colors.warning },
  statusRUNNING: { backgroundColor: colors.primary },
  statusFAILED: { backgroundColor: colors.error },
  statusText: {
    color: colors.onPrimary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  rowLabel: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  },
  rowValue: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
  },
  totalLabel: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  totalValue: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  step: {
    gap: 4,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    color: colors.onPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    textAlign: 'center',
    lineHeight: 24,
  },
  stepLabel: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },
  stepValue: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  stepExplanation: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginLeft: 32,
  },
  trackRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
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
  policyHeading: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.xs,
  },
  policyText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.5,
  },
  testPolicyBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.warning,
    color: colors.onPrimary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.pill,
    textTransform: 'uppercase',
  },
  disclaimer: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: fontSize.xs * 1.5,
  },
});

export default RoyaltyPeriodDetailScreen;

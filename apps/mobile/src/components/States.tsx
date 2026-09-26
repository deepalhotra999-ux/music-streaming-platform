// Phase 5 — design system: state views.
// LoadingState, EmptyState, ErrorState share layout and typography.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, fontWeight, spacing } from '../theme';
import { Button } from './Button';

export function LoadingState({
  message = 'Loading…',
  testID,
}: {
  message?: string;
  testID?: string;
}) {
  return (
    <View
      style={styles.container}
      testID={testID ?? 'loading-state'}
      accessibilityRole="progressbar"
      accessibilityLabel={message}
      accessibilityLiveRegion="polite"
    >
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

interface EmptyStateProps {
  title: string;
  message?: string;
  actionTitle?: string;
  onAction?: () => void;
  testID?: string;
}

export function EmptyState({ title, message, actionTitle, onAction, testID }: EmptyStateProps) {
  return (
    <View style={styles.container} testID={testID ?? 'empty-state'}>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {actionTitle && onAction ? (
        <View style={styles.action}>
          <Button title={actionTitle} onPress={onAction} variant="secondary" size="md" />
        </View>
      ) : null}
    </View>
  );
}

interface ErrorStateProps {
  message: string;
  retryTitle?: string;
  onRetry?: () => void;
  testID?: string;
}

export function ErrorState({
  message,
  retryTitle = 'Try again',
  onRetry,
  testID,
}: ErrorStateProps) {
  return (
    <View
      style={styles.container}
      testID={testID ?? 'error-state'}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.message}>{message}</Text>
      {onRetry ? (
        <View style={styles.action}>
          <Button title={retryTitle} onPress={onRetry} variant="secondary" size="md" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  message: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: fontSize.sm * 1.6,
  },
  action: { marginTop: spacing.lg },
});

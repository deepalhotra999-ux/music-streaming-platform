// Phase 29 — report dialog shared by post detail and comment rows.
// Files into the existing Phase 17 moderation workflow; the reporter never
// sees queue state, notes, or outcomes.

import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, TextInput, modalAnimationFor, useReducedMotion } from '../../components';
import { colors } from '../../theme';
import { spacing } from '../../theme/spacing';

interface ReportDialogProps {
  visible: boolean;
  /** Human-readable target label, e.g. "this post" or "this comment". */
  targetLabel: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (reason: string) => void;
  onClose: () => void;
  testID?: string;
}

export function ReportDialog({
  visible,
  targetLabel,
  submitting,
  error,
  onSubmit,
  onClose,
  testID,
}: ReportDialogProps) {
  const [reason, setReason] = useState('');
  const canSubmit = reason.trim().length >= 3 && !submitting;
  const reducedMotion = useReducedMotion();

  const close = () => {
    setReason('');
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={modalAnimationFor(reducedMotion, 'fade')}
      onRequestClose={close}
    >
      <View style={styles.container}>
        {/* Dismiss backdrop: sibling of the sheet, not its parent, so the
            modal content is not nested inside a button in the a11y tree. */}
        <Pressable
          style={styles.backdrop}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Dismiss report dialog"
        />
        <View
          style={styles.sheet}
          testID={testID}
          accessibilityViewIsModal
          accessibilityLabel={`Report ${targetLabel}`}
          accessibilityRole="none"
        >
          <Text style={styles.title} accessibilityRole="header">
            Report {targetLabel}
          </Text>
          <Text style={styles.hint}>
            Tell us what&apos;s wrong. Reports go to our moderation team; the author won&apos;t know
            who reported.
          </Text>
          <TextInput
            label="Report reason"
            value={reason}
            onChangeText={setReason}
            placeholder="Reason (min 3 characters)"
            multiline
            numberOfLines={3}
            maxLength={2000}
            editable={!submitting}
            testID={testID ? `${testID}-reason` : undefined}
          />
          {error ? (
            <Text
              style={styles.error}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button title="Cancel" variant="secondary" onPress={close} disabled={submitting} />
            <Button
              title={submitting ? 'Sending…' : 'Send report'}
              onPress={() => onSubmit(reason.trim())}
              disabled={!canSubmit}
              accessibilityLabel={submitting ? 'Sending report' : `Send report for ${targetLabel}`}
              testID={testID ? `${testID}-submit` : undefined}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    padding: spacing.lg,
    width: '100%',
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    marginTop: spacing.md,
  },
});

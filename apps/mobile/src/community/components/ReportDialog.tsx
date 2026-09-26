// Phase 29 — report dialog shared by post detail and comment rows.
// Files into the existing Phase 17 moderation workflow; the reporter never
// sees queue state, notes, or outcomes.

import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, TextInput } from '../../components';
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

  const close = () => {
    setReason('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID={testID}>
          <Text style={styles.title}>Report {targetLabel}</Text>
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
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Button title="Cancel" variant="secondary" onPress={close} disabled={submitting} />
            <Button
              title={submitting ? 'Sending…' : 'Send report'}
              onPress={() => onSubmit(reason.trim())}
              disabled={!canSubmit}
              testID={testID ? `${testID}-submit` : undefined}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
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

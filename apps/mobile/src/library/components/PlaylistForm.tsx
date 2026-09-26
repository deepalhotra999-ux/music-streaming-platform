// Phase 11 — playlist create/edit form, presented as a modal.
//
// The form owns field state and validation; the parent owns the API call
// (it passes `saving` and a server `error`, and closes the modal on
// success). Visibility is a three-way segmented control.

import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PlaylistVisibility } from '../../api';
import { Button, TextInput, modalAnimationFor, useReducedMotion } from '../../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../../theme';

const VISIBILITY_OPTIONS: { value: PlaylistVisibility; label: string; hint: string }[] = [
  { value: 'PRIVATE', label: 'Private', hint: 'Only you' },
  { value: 'PUBLIC', label: 'Public', hint: 'Everyone' },
  { value: 'UNLISTED', label: 'Unlisted', hint: 'Anyone with the link' },
];

export interface PlaylistFormValues {
  title: string;
  description: string | null;
  visibility: PlaylistVisibility;
}

interface PlaylistFormProps {
  visible: boolean;
  mode: 'create' | 'edit';
  initial?: PlaylistFormValues;
  saving: boolean;
  error?: string | null;
  onSubmit: (input: PlaylistFormValues) => void;
  onClose: () => void;
}

export function PlaylistForm({
  visible,
  mode,
  initial,
  saving,
  error,
  onSubmit,
  onClose,
}: PlaylistFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [visibility, setVisibility] = useState<PlaylistVisibility>(
    initial?.visibility ?? 'PRIVATE',
  );
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const reducedMotion = useReducedMotion();

  // Reset fields whenever the modal opens (fresh create, or fresh edit of a
  // possibly-updated playlist).
  useEffect(() => {
    if (visible) {
      setTitle(initial?.title ?? '');
      setDescription(initial?.description ?? '');
      setVisibility(initial?.visibility ?? 'PRIVATE');
      setTitleError(undefined);
    }
  }, [visible, initial?.title, initial?.description, initial?.visibility]);

  const submit = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setTitleError('Give your playlist a title.');
      return;
    }
    onSubmit({
      title: trimmed,
      description: description.trim().length > 0 ? description.trim() : null,
      visibility,
    });
  };

  return (
    <Modal
      visible={visible}
      animationType={modalAnimationFor(reducedMotion)}
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      testID="playlist-form-modal"
    >
      <View
        style={styles.container}
        accessibilityViewIsModal
        accessibilityLabel={mode === 'create' ? 'New playlist' : 'Edit playlist'}
      >
        <View style={styles.header}>
          <Text style={styles.heading}>{mode === 'create' ? 'New playlist' : 'Edit playlist'}</Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="playlist-form-close"
          >
            <Ionicons name="close" size={fontSize.xl} color={colors.text} />
          </Pressable>
        </View>

        <View style={styles.fields}>
          <TextInput
            label="Title"
            value={title}
            onChangeText={setTitle}
            placeholder="My playlist"
            maxLength={200}
            error={titleError}
            testID="playlist-form-title"
          />
          <TextInput
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="What's it about? (optional)"
            maxLength={1000}
            multiline
            testID="playlist-form-description"
          />

          <Text style={styles.sectionLabel}>Visibility</Text>
          <View style={styles.visibilityRow}>
            {VISIBILITY_OPTIONS.map((option) => {
              const selected = visibility === option.value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => setVisibility(option.value)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${option.label}: ${option.hint}`}
                  style={({ pressed }) => [
                    styles.visibilityOption,
                    selected && styles.visibilitySelected,
                    pressed && styles.pressed,
                  ]}
                  testID={`playlist-visibility-${option.value}`}
                >
                  <Text
                    style={[styles.visibilityLabel, selected && styles.visibilityLabelSelected]}
                  >
                    {option.label}
                  </Text>
                  <Text style={styles.visibilityHint}>{option.hint}</Text>
                </Pressable>
              );
            })}
          </View>

          {error ? (
            <Text style={styles.serverError} testID="playlist-form-error">
              {error}
            </Text>
          ) : null}
        </View>

        <View style={styles.footer}>
          <Button
            title={mode === 'create' ? 'Create playlist' : 'Save changes'}
            onPress={submit}
            loading={saving}
            testID="playlist-form-submit"
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  heading: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  fields: { gap: spacing.md },
  sectionLabel: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.sm,
  },
  visibilityRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  visibilityOption: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  visibilitySelected: {
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  pressed: { opacity: 0.7 },
  visibilityLabel: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  visibilityLabelSelected: { color: colors.primary },
  visibilityHint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
    textAlign: 'center',
  },
  serverError: {
    color: colors.error,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
  footer: { marginTop: spacing.xl },
});

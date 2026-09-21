// Phase 11 — follow button: pill button reflecting the library follow
// state. Optimistic toggle with rollback; failures surface via alert.

import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import { apiErrorMessage } from '../../api';
import { colors, fontSize, fontWeight, radii, spacing } from '../../theme';
import { useLibrary } from '../LibraryContext';

export function FollowButton({
  artistId,
  onToggled,
}: {
  artistId: string;
  /** Called with the new followed state after a successful toggle. */
  onToggled?: (followed: boolean) => void;
}) {
  const { isFollowed, toggleFollow } = useLibrary();
  const [busy, setBusy] = useState(false);
  const followed = isFollowed(artistId);

  const onPress = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await toggleFollow(artistId);
      onToggled?.(!followed);
    } catch (err) {
      Alert.alert('Could not update follow', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={() => void onPress()}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={followed ? 'Unfollow artist' : 'Follow artist'}
      accessibilityState={{ selected: followed, busy }}
      style={({ pressed }) => [
        styles.button,
        followed ? styles.following : styles.notFollowing,
        pressed && !busy && styles.pressed,
        busy && styles.busy,
      ]}
      testID={`follow-button-${artistId}`}
    >
      <Text style={[styles.label, followed ? styles.followingLabel : styles.notFollowingLabel]}>
        {busy ? '…' : followed ? 'Following' : 'Follow'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 104,
  },
  following: {
    backgroundColor: 'transparent',
    borderColor: colors.border,
  },
  notFollowing: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  pressed: { opacity: 0.7 },
  busy: { opacity: 0.6 },
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  followingLabel: { color: colors.textMuted },
  notFollowingLabel: { color: colors.onPrimary },
});

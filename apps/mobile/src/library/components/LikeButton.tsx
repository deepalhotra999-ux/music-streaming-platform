// Phase 11 — like button: heart icon reflecting the library like state.
//
// The toggle is optimistic (LibraryProvider updates instantly and rolls
// back on failure). Failures surface through an alert so the user knows the
// tap did not stick.

import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { apiErrorMessage } from '../../api';
import { colors, fontSize } from '../../theme';
import { useLibrary } from '../LibraryContext';

export function LikeButton({
  trackId,
  size = 22,
  onToggled,
}: {
  trackId: string;
  size?: number;
  /** Called with the new liked state after a successful toggle. */
  onToggled?: (liked: boolean) => void;
}) {
  const { isLiked, toggleLike } = useLibrary();
  const [busy, setBusy] = useState(false);
  const liked = isLiked(trackId);

  const onPress = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await toggleLike(trackId);
      onToggled?.(!liked);
    } catch (err) {
      Alert.alert('Could not update like', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={() => void onPress()}
      disabled={busy}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={liked ? 'Unlike track' : 'Like track'}
      accessibilityState={{ selected: liked, busy }}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      testID={`like-button-${trackId}`}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : (
        <Ionicons
          name={liked ? 'heart' : 'heart-outline'}
          size={size ?? fontSize.lg}
          color={liked ? colors.primary : colors.textMuted}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    padding: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pressed: { opacity: 0.6 },
});

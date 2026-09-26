// Phase 6 — artwork with a procedural test-only fallback.
//
// Real artwork URLs (coverArtUrl / imageUrl) render via <Image>. The dev
// seed carries no artwork, so a deterministic placeholder renders instead:
// a stable hue derived from the entity id plus the title's initial letter.
// No network, no copyrighted images — development/test artwork only.

import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { fontSize, fontWeight } from '../../theme';
import { hueFor, initialFor, placeholderBackground } from '../format';

interface ArtworkImageProps {
  /** Remote artwork URL; null/undefined renders the placeholder. */
  uri?: string | null;
  /** Title used for the placeholder initial. */
  title: string;
  /** Stable seed (entity id) for the deterministic placeholder hue. */
  seed: string;
  size: number;
  shape?: 'circle' | 'rounded' | 'square';
  testID?: string;
  /**
   * Phase 31 — opt-in accessible label. Artwork is decorative by default:
   * every current usage sits inside a Pressable that already exposes a full
   * label ("Album X by Y"), so exposing the image would double-announce.
   * Pass a label only when the image is the sole meaningful content and no
   * parent provides one.
   */
  accessibilityLabel?: string;
}

export function ArtworkImage({
  uri,
  title,
  seed,
  size,
  shape = 'rounded',
  testID,
  accessibilityLabel,
}: ArtworkImageProps) {
  const [failed, setFailed] = useState(false);
  const radius = shape === 'circle' ? size / 2 : shape === 'rounded' ? Math.max(6, size * 0.12) : 0;
  // Decorative unless an explicit label is given: hides the image (and the
  // placeholder initial letter) from screen readers.
  const decorativeProps = accessibilityLabel
    ? { accessible: true, accessibilityLabel, accessibilityRole: 'image' as const }
    : { accessible: false, importantForAccessibility: 'no-hide-descendants' as const };

  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: radius }}
        onError={() => setFailed(true)}
        testID={testID}
        {...decorativeProps}
      />
    );
  }

  return (
    <View
      style={[
        styles.placeholder,
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: placeholderBackground(hueFor(seed)),
        },
      ]}
      testID={testID ?? 'artwork-placeholder'}
      {...decorativeProps}
    >
      <Text style={[styles.initial, { fontSize: size * 0.38 }]}>{initialFor(title)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: '#FFFFFF',
    fontWeight: fontWeight.bold,
    fontSize: fontSize.xl,
  },
});

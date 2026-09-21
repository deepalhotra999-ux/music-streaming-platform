// Phase 5 — Splash screen.
// Shown while the persisted session is being restored and validated.

import { StyleSheet, Text, View } from 'react-native';
import { LoadingState } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

export function SplashScreen() {
  return (
    <View style={styles.container} testID="splash-screen">
      <View style={styles.mark}>
        <Text style={styles.markGlyph}>◉</Text>
      </View>
      <Text style={styles.wordmark}>Waveform</Text>
      <Text style={styles.tagline}>Music, flowing.</Text>
      <View style={styles.loader}>
        <LoadingState message="Preparing your music…" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  mark: {
    width: 88,
    height: 88,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  markGlyph: { color: colors.onPrimary, fontSize: 44 },
  wordmark: { color: colors.text, fontSize: fontSize.hero, fontWeight: fontWeight.bold },
  tagline: { color: colors.textMuted, fontSize: fontSize.md, marginTop: spacing.xs },
  loader: { marginTop: spacing.xxl, height: 96 },
});

// Phase 5 — design system: Screen container.
// Safe-area aware, keyboard-aware, optional scroll.

import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import type { ReactNode } from 'react';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors, spacing } from '../theme';

interface ScreenProps {
  children: ReactNode;
  /** Wrap content in a ScrollView (default true for forms). */
  scrollable?: boolean;
  /** Horizontal padding (default md). */
  padded?: boolean;
  /** Safe-area edges. Screens under a native header pass ['bottom'] to avoid
   * double top inset; tab screens keep the default ['top', 'bottom']. */
  edges?: Edge[];
  testID?: string;
}

export function Screen({ children, scrollable = true, padded = true, edges, testID }: ScreenProps) {
  const content = (
    <View style={[styles.inner, padded && styles.padded]} testID={testID}>
      {children}
    </View>
  );
  return (
    <SafeAreaView style={styles.safe} edges={edges ?? ['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {scrollable ? (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {content}
          </ScrollView>
        ) : (
          content
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  inner: { flex: 1 },
  padded: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
});

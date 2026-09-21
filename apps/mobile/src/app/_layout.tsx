// Phase 5 — root layout: providers + auth gating.
//
// AuthProvider restores the session on mount. Routes are guarded with
// Stack.Protected so navigation follows auth state automatically:
// - loading → splash (index route)
// - unauthenticated → (auth) stack
// - authenticated → (tabs)

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '../auth';
import { PlaybackProvider } from '../playback';
import { colors } from '../theme';

/**
 * Phase 8 — mounts the playback engine only for authenticated users: it
 * needs the authenticated API client for playback sessions and play
 * events. Unmounting on sign-out stops playback and releases the player.
 */
function PlaybackShell({ children }: { children: ReactNode }) {
  const { status, api } = useAuth();
  if (status !== 'authenticated') {
    return <>{children}</>;
  }
  return <PlaybackProvider api={api}>{children}</PlaybackProvider>;
}

function RootNavigator() {
  const { status } = useAuth();
  const isAuthenticated = status === 'authenticated';
  const isUnauthenticated = status === 'unauthenticated';
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Protected guard={status === 'loading'}>
          <Stack.Screen name="index" />
        </Stack.Protected>
        <Stack.Protected guard={isUnauthenticated}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        <Stack.Protected guard={isAuthenticated}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="(catalog)" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <PlaybackShell>
          <RootNavigator />
        </PlaybackShell>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

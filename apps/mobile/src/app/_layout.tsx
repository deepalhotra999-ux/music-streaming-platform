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
import { LibraryProvider } from '../library';
import { MiniPlayerHost } from '../player';
import { CarPlayHost } from '../carplay/CarPlayHost';
import { AndroidAutoHost } from '../androidauto/AndroidAutoHost';
import { colors } from '../theme';

/**
 * Phase 8 — mounts the playback engine only for authenticated users: it
 * needs the authenticated API client for playback sessions and play
 * events. Unmounting on sign-out stops playback and releases the player.
 *
 * Phase 9 — the mini player host also lives here so the bar persists
 * across tabs and catalog navigation (it overlays the root stack).
 *
 * Phase 11 — the library provider also mounts here: like/follow state is
 * per-user and must reset on sign-out, exactly like playback.
 */
function PlaybackShell({ children }: { children: ReactNode }) {
  const { status, api } = useAuth();
  if (status !== 'authenticated') {
    return <>{children}</>;
  }
  return (
    <PlaybackProvider api={api}>
      <LibraryProvider api={api}>
        {children}
        <MiniPlayerHost />
        {/* Phase 23 — headless CarPlay controller: drives the native
            CarPlay templates with the shared PlaybackEngine. No UI here,
            no second player. Unmounts with the provider on sign-out. */}
        <CarPlayHost />
        {/* Phase 24 — headless Android Auto controller: serves the native
            MediaLibraryService from the shared PlaybackEngine. No UI here,
            no second player. Unmounts with the provider on sign-out. */}
        <AndroidAutoHost />
      </LibraryProvider>
    </PlaybackProvider>
  );
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
          <Stack.Screen name="(artist)" />
          <Stack.Screen name="player" options={{ presentation: 'modal' }} />
          <Stack.Screen name="subscription" options={{ presentation: 'modal' }} />
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

// Phase 13 — artist management stack: profile and catalog management
// screens pushed above the tabs. Sibling of (tabs) and (catalog) in the
// root stack, so the tab bar is hidden here and the native header
// provides back navigation. Guarded by the authenticated
// Stack.Protected in the root layout, plus a role guard below: only
// ARTIST users may enter (deep links included).

import { Redirect, Stack } from 'expo-router';
import { colors, fontWeight } from '../../theme';
import { useAuth } from '../../auth';

export default function ArtistLayout() {
  const { status, user } = useAuth();

  if (status === 'authenticated' && user?.role !== 'ARTIST') {
    return <Redirect href="/(tabs)" />;
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.tabBar },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: fontWeight.semibold },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="profile" options={{ title: 'Artist profile' }} />
      <Stack.Screen name="albums" options={{ title: 'Manage albums' }} />
      <Stack.Screen name="tracks" options={{ title: 'Manage tracks' }} />
      <Stack.Screen name="analytics" options={{ title: 'Analytics' }} />
    </Stack>
  );
}

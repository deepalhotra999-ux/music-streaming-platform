// Phase 6 — catalog stack: list and detail screens pushed above the tabs.
// Sibling of (tabs) in the root stack, so the tab bar is hidden here and the
// native header provides back navigation. Guarded by the authenticated
// Stack.Protected in the root layout.

import { Stack } from 'expo-router';
import { colors, fontWeight } from '../../theme';

export default function CatalogLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.tabBar },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: fontWeight.semibold },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="artists" options={{ title: 'Artists' }} />
      <Stack.Screen name="albums" options={{ title: 'New releases' }} />
      <Stack.Screen name="tracks" options={{ title: 'Tracks' }} />
      <Stack.Screen name="genres" options={{ title: 'Genres' }} />
      <Stack.Screen name="playlists" options={{ title: 'Playlists' }} />
      <Stack.Screen name="artist/[id]" options={{ title: 'Artist' }} />
      <Stack.Screen name="album/[id]" options={{ title: 'Album' }} />
      <Stack.Screen name="genre/[id]" options={{ title: 'Genre' }} />
      <Stack.Screen name="playlist/[id]" options={{ title: 'Playlist' }} />
    </Stack>
  );
}

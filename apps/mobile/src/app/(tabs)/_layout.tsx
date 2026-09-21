// Phase 5 — main bottom tabs (authenticated area).
// Home is the Phase 6 catalog; Search/Library are placeholders for later phases.
// Phase 13 — the Artist tab mounts only for ARTIST users.

import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { colors } from '../../theme';
import { useAuth } from '../../auth';

type IconName = ComponentProps<typeof Ionicons>['name'];

const TAB_ICONS: Record<string, { focused: IconName; unfocused: IconName }> = {
  index: { focused: 'home', unfocused: 'home-outline' },
  search: { focused: 'search', unfocused: 'search-outline' },
  library: { focused: 'library', unfocused: 'library-outline' },
  artist: { focused: 'mic', unfocused: 'mic-outline' },
  profile: { focused: 'person', unfocused: 'person-outline' },
};

const TAB_TITLES: Record<string, string> = {
  index: 'Home',
  search: 'Search',
  library: 'Library',
  artist: 'Artist',
  profile: 'Profile',
};

export default function TabsLayout() {
  const { user } = useAuth();
  const isArtist = user?.role === 'ARTIST';
  return (
    <Tabs
      screenOptions={({ route }) => {
        const icons = TAB_ICONS[route.name] ?? TAB_ICONS.index;
        const title = TAB_TITLES[route.name] ?? route.name;
        return {
          headerShown: false,
          tabBarLabel: title,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: colors.tabBar,
            borderTopColor: colors.border,
          },
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? icons.focused : icons.unfocused} size={size} color={color} />
          ),
        };
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="search" />
      <Tabs.Screen name="library" />
      {isArtist ? <Tabs.Screen name="artist" /> : null}
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}

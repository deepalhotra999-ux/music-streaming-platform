// Phase 28 — room route group: lobby, join, and the active room screen.

import { Stack } from 'expo-router';
import { colors } from '../../theme';

export default function RoomLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Listening Rooms' }} />
      <Stack.Screen name="join" options={{ title: 'Join a Room' }} />
      <Stack.Screen name="[id]" options={{ title: 'Listening Room' }} />
    </Stack>
  );
}

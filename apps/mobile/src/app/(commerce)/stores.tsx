// Phase 30 — public artist store directory.

import { Link } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../../auth';
import { listStores, type Store } from '../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  OfflineNotice,
} from '../../commerce/ui';
import { useOnline } from '../../commerce/useOnline';
import { useFocusEffect } from 'expo-router';

export default function StoresScreen() {
  const { api: client } = useAuth();
  const online = useOnline();
  const { status } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const page = await listStores(client, { q: query || undefined, limit: 50 });
      setStores(page.data);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load stores.');
      setState('error');
    }
  }, [client, query]);

  useFocusEffect(
    useCallback(() => {
      if (status === 'authenticated') void load();
    }, [status, load]),
  );

  if (status !== 'authenticated') {
    return <EmptyState label="Sign in to browse artist stores." />;
  }
  if (!online) return <OfflineNotice />;

  return (
    <View style={styles.root}>
      <TextInput
        style={styles.search}
        placeholder="Search stores…"
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Search stores"
        accessibilityHint="Type a store name, then submit to search"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void load()}
        returnKeyType="search"
      />
      {state === 'loading' ? (
        <LoadingState />
      ) : state === 'error' ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : stores.length === 0 ? (
        <EmptyState label="No stores yet. Check back soon." />
      ) : (
        <FlatList
          data={stores}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Link href={`/(commerce)/store/${item.id}`} asChild>
              <Pressable
                style={styles.card}
                accessibilityRole="button"
                accessibilityLabel={`Open store: ${item.name}`}
              >
                <View style={styles.row}>
                  <Text style={styles.name}>{item.name}</Text>
                  <StatusBadge status={item.status} />
                </View>
                {item.description ? (
                  <Text style={styles.desc} numberOfLines={2}>
                    {item.description}
                  </Text>
                ) : null}
              </Pressable>
            </Link>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  search: {
    margin: spacing.md,
    padding: spacing.sm,
    borderRadius: 8,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: fontSize.md,
  },
  list: { padding: spacing.md, gap: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  name: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    flex: 1,
  },
  desc: { color: colors.textMuted, fontSize: fontSize.sm },
});

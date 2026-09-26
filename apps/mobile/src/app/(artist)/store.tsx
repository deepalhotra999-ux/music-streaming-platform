// Phase 30 — artist store management: view/edit the artist's store,
// create it when missing. One store per artist, enforced server-side.

import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TextInput } from '../../components';
import { useAuth } from '../../auth';
import { createStore, formatPrice, getMyStore, updateStore, type Store } from '../../api/commerce';
import { listMyArtists } from '../../api/artist';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { ErrorState, LoadingState, StatusBadge } from '../../commerce/ui';

export default function ArtistStoreScreen() {
  const { api: client } = useAuth();
  const [store, setStore] = useState<Store | null>(null);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [artistId, setArtistId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const mine = await listMyArtists(client);
      const id = mine.data[0]?.id ?? null;
      setArtistId(id);
      if (!id) {
        setState('error');
        setError('No artist profile found for this account.');
        return;
      }
      const s = await getMyStore(client, id);
      setStore(s);
      setName(s.name);
      setDescription(s.description ?? '');
      setMissing(false);
      setState('ready');
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      if (/not found/i.test(message)) {
        setMissing(true);
        setState('ready');
      } else {
        setError(message || 'Failed to load store.');
        setState('error');
      }
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const save = async () => {
    if (!artistId || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      if (store) {
        const s = await updateStore(client, store.id, {
          name: name.trim(),
          description: description.trim() || null,
        });
        setStore(s);
      } else {
        const s = await createStore(client, {
          artistId,
          name: name.trim(),
          description: description.trim() || undefined,
          currency: 'USD',
        });
        setStore(s);
        setMissing(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save store.');
    } finally {
      setSaving(false);
    }
  };

  const togglePause = async () => {
    if (!store) return;
    setSaving(true);
    try {
      const s = await updateStore(client, store.id, {
        status: store.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      });
      setStore(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update status.');
    } finally {
      setSaving(false);
    }
  };

  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;

  if (missing || !store) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Open your store
        </Text>
        <Text style={styles.muted}>One store per artist. You can add products once it exists.</Text>
        <TextInput
          label="Store name"
          required
          placeholder="Store name"
          value={name}
          onChangeText={setName}
        />
        <TextInput
          label="Store description"
          placeholder="Optional"
          value={description}
          onChangeText={setDescription}
          multiline
        />
        {error ? (
          <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            {error}
          </Text>
        ) : null}
        <Pressable
          style={[styles.primary, (!name.trim() || saving) && styles.disabled]}
          onPress={() => void save()}
          disabled={!name.trim() || saving}
          accessibilityRole="button"
          accessibilityLabel={saving ? 'Creating store' : 'Create store'}
          accessibilityState={{ disabled: !name.trim() || saving, busy: saving }}
        >
          <Text style={styles.primaryLabel}>{saving ? 'Creating…' : 'Create store'}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text style={styles.title}>{store.name}</Text>
        <StatusBadge status={store.status} />
      </View>
      <Text style={styles.muted}>
        {formatPrice(store.shippingFlatCents, store.currency)} flat shipping · {store.currency}
      </Text>

      <Text style={styles.sectionTitle} accessibilityRole="header">
        Settings
      </Text>
      <TextInput
        label="Store name"
        required
        placeholder="Store name"
        value={name}
        onChangeText={setName}
      />
      <TextInput
        label="Store description"
        placeholder="Optional"
        value={description}
        onChangeText={setDescription}
        multiline
      />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          {error}
        </Text>
      ) : null}
      <Pressable
        style={[styles.primary, saving && styles.disabled]}
        onPress={() => void save()}
        disabled={saving}
        accessibilityRole="button"
        accessibilityLabel={saving ? 'Saving changes' : 'Save changes'}
        accessibilityState={{ disabled: saving, busy: saving }}
      >
        <Text style={styles.primaryLabel}>{saving ? 'Saving…' : 'Save changes'}</Text>
      </Pressable>

      {(store.status === 'ACTIVE' || store.status === 'PAUSED') && (
        <Pressable
          style={styles.secondary}
          onPress={() => void togglePause()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={
            store.status === 'ACTIVE'
              ? 'Pause store, hides it from buyers'
              : 'Activate store, makes it visible to buyers'
          }
          accessibilityState={{ disabled: saving }}
        >
          <Text style={styles.secondaryLabel}>
            {store.status === 'ACTIVE' ? 'Pause store' : 'Activate store'}
          </Text>
        </Pressable>
      )}

      <Link href="/(artist)/products" asChild>
        <Pressable
          style={styles.secondary}
          accessibilityRole="button"
          accessibilityLabel="Manage products"
        >
          <Text style={styles.secondaryLabel}>Manage products</Text>
        </Pressable>
      </Link>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    flex: 1,
  },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.sm,
  },
  error: { color: colors.error, fontSize: fontSize.sm },
  primary: {
    backgroundColor: colors.primaryFilled,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  primaryLabel: {
    color: colors.onPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  secondary: {
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  secondaryLabel: { color: colors.text, fontSize: fontSize.md },
  disabled: { opacity: 0.5 },
});

// Phase 13 — artist profile management.
//
// View and edit the caller's own artist identity: the artist name
// (PATCH /v1/artists/:id) and the extended profile fields already in
// the schema (PUT /v1/artists/:id/profile). Client-side validation
// mirrors the backend (name required; URLs must be absolute URIs);
// server errors surface via the shared RFC 7807 message helper.

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  apiErrorMessage,
  getArtist,
  listMyArtists,
  updateArtist,
  updateArtistProfile,
  type ArtistDetail,
} from '../api';
import { useAuth } from '../auth';
import { Button, EmptyState, ErrorState, LoadingState, Screen, TextInput } from '../components';
import { colors, fontSize, spacing } from '../theme';

type LoadState = 'loading' | 'ready' | 'error' | 'no-artist';

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function ArtistProfileScreen() {
  const { api } = useAuth();
  const { artistId } = useLocalSearchParams<{ artistId?: string }>();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [artist, setArtist] = useState<ArtistDetail | null>(null);

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [website, setWebsite] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    setError(null);
    try {
      const id = artistId ?? (await listMyArtists(api)).data[0]?.id;
      if (!id) {
        setLoadState('no-artist');
        return;
      }
      const detail = await getArtist(api, id);
      setArtist(detail);
      setName(detail.name);
      setBio(detail.profile?.bio ?? '');
      setWebsite(detail.profile?.website ?? '');
      setImageUrl(detail.profile?.imageUrl ?? '');
      setBannerUrl(detail.profile?.bannerUrl ?? '');
      setLoadState('ready');
    } catch (e) {
      setError(apiErrorMessage(e));
      setLoadState('error');
    }
  }, [api, artistId]);

  useEffect(() => {
    void load();
  }, [load]);

  const validate = useCallback(() => {
    const errors: Record<string, string> = {};
    if (!name.trim()) {
      errors.name = 'Artist name is required.';
    } else if (name.trim().length > 200) {
      errors.name = 'Artist name must be 200 characters or fewer.';
    }
    if (bio.length > 2000) {
      errors.bio = 'Bio must be 2000 characters or fewer.';
    }
    const urls: Array<[string, string]> = [
      ['website', website.trim()],
      ['imageUrl', imageUrl.trim()],
      ['bannerUrl', bannerUrl.trim()],
    ];
    for (const [field, value] of urls) {
      if (value && !isValidUrl(value)) {
        errors[field] = 'Must be a valid http(s) URL.';
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [name, bio, website, imageUrl, bannerUrl]);

  const handleSave = useCallback(async () => {
    if (!artist || !validate()) return;
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const trimmedName = name.trim();
      if (trimmedName !== artist.name) {
        await updateArtist(api, artist.id, { name: trimmedName });
      }
      const nullIfEmpty = (v: string) => (v.trim() ? v.trim() : null);
      await updateArtistProfile(api, artist.id, {
        bio: nullIfEmpty(bio),
        website: nullIfEmpty(website),
        imageUrl: nullIfEmpty(imageUrl),
        bannerUrl: nullIfEmpty(bannerUrl),
      });
      const refreshed = await getArtist(api, artist.id);
      setArtist(refreshed);
      setSaved(true);
    } catch (e) {
      setSaveError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [api, artist, bio, bannerUrl, imageUrl, name, validate, website]);

  if (loadState === 'loading') {
    return (
      <Screen testID="artist-profile-screen">
        <LoadingState message="Loading profile…" />
      </Screen>
    );
  }

  if (loadState === 'error') {
    return (
      <Screen testID="artist-profile-screen">
        <ErrorState message={error ?? 'Something went wrong.'} onRetry={load} />
      </Screen>
    );
  }

  if (loadState === 'no-artist') {
    return (
      <Screen testID="artist-profile-screen">
        <EmptyState
          title="No artist profile"
          message="Create your artist profile from the dashboard first."
          actionTitle="Go to dashboard"
          onAction={() => router.replace('/(tabs)/artist')}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="artist-profile-screen">
      <View style={styles.form}>
        <TextInput
          label="Artist name"
          value={name}
          onChangeText={(v) => {
            setName(v);
            setSaved(false);
          }}
          error={fieldErrors.name}
          autoCapitalize="words"
          testID="profile-name"
        />
        <TextInput
          label="Bio"
          value={bio}
          onChangeText={(v) => {
            setBio(v);
            setSaved(false);
          }}
          error={fieldErrors.bio}
          multiline
          numberOfLines={4}
          placeholder="Tell listeners about your music"
          testID="profile-bio"
        />
        <TextInput
          label="Website"
          value={website}
          onChangeText={(v) => {
            setWebsite(v);
            setSaved(false);
          }}
          error={fieldErrors.website}
          placeholder="https://example.com"
          autoCapitalize="none"
          keyboardType="url"
          testID="profile-website"
        />
        <TextInput
          label="Profile image URL"
          value={imageUrl}
          onChangeText={(v) => {
            setImageUrl(v);
            setSaved(false);
          }}
          error={fieldErrors.imageUrl}
          placeholder="https://example.com/avatar.jpg"
          autoCapitalize="none"
          keyboardType="url"
          testID="profile-image-url"
        />
        <TextInput
          label="Banner image URL"
          value={bannerUrl}
          onChangeText={(v) => {
            setBannerUrl(v);
            setSaved(false);
          }}
          error={fieldErrors.bannerUrl}
          placeholder="https://example.com/banner.jpg"
          autoCapitalize="none"
          keyboardType="url"
          testID="profile-banner-url"
        />
        {saveError ? (
          <Text style={styles.saveError} testID="profile-save-error">
            {saveError}
          </Text>
        ) : null}
        {saved ? (
          <Text style={styles.saved} testID="profile-saved">
            Profile saved.
          </Text>
        ) : null}
        <Button
          title={saving ? 'Saving…' : 'Save profile'}
          onPress={handleSave}
          disabled={saving}
          testID="profile-save"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  saveError: {
    color: colors.error,
    fontSize: fontSize.sm,
  },
  saved: {
    color: colors.success,
    fontSize: fontSize.sm,
  },
});

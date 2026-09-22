// Phase 27 — playlist members: list, invite, remove, leave.
//
// Everyone with access sees the member list. Only the owner can create
// or revoke invitations and remove members; editors can leave. The
// invitation token is shown exactly once after creation — it is never
// stored server-side and never appears in list responses. Membership
// actions are disabled while offline.

import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { setStringAsync as copyToClipboard } from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type { PlaylistInvitation, PlaylistMember } from '../api';
import {
  apiErrorMessage,
  createInvitation,
  leavePlaylist,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
} from '../api';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../utils/useOnlineStatus';
import { Button, ErrorState, LoadingState, Screen } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

function roleLabel(role: PlaylistMember['role']): string {
  return role === 'OWNER' ? 'Owner' : 'Editor';
}

export function PlaylistMembersScreen({ playlistId }: { playlistId: string }) {
  const { api, user } = useAuth();
  const router = useRouter();
  const online = useOnlineStatus();
  const [members, setMembers] = useState<PlaylistMember[] | null>(null);
  const [invitations, setInvitations] = useState<PlaylistInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The raw invitation token, held in memory only and shown exactly once. */
  const [pendingToken, setPendingToken] = useState<string | null>(null);

  const ownerUserId = members?.find((m) => m.role === 'OWNER')?.userId ?? null;
  const isOwner = Boolean(user && ownerUserId && user.id === ownerUserId);
  const isMember = Boolean(user && members?.some((m) => m.userId === user.id));
  const actionsBlocked = !online;

  const userId = user?.id;
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const memberRows = await listMembers(api, playlistId);
      setMembers(memberRows);
      // Invitation listing is owner-only. Derive ownership from the fresh
      // member rows so editors never issue a request the server would 403.
      const ownerUserId = memberRows.find((m) => m.role === 'OWNER')?.userId ?? null;
      const invitationRows =
        userId && ownerUserId && userId === ownerUserId
          ? await listInvitations(api, playlistId)
          : [];
      setInvitations(invitationRows);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [api, playlistId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreateInvitation = useCallback(async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      const result = await createInvitation(api, playlistId);
      // Shown once: kept in component state only, cleared on Done.
      setPendingToken(result.token);
      setInvitations((prev) => [result.invitation, ...prev]);
    } catch (err) {
      Alert.alert('Could not create invitation', apiErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }, [api, creating, playlistId]);

  const handleCopyToken = useCallback(async () => {
    if (!pendingToken) {
      return;
    }
    try {
      await copyToClipboard(pendingToken);
      Alert.alert('Copied', 'The invitation token is on your clipboard.');
    } catch {
      Alert.alert('Could not copy', 'Copy the token manually from the text above.');
    }
  }, [pendingToken]);

  const handleShareToken = useCallback(async () => {
    if (!pendingToken) {
      return;
    }
    try {
      await Share.share({
        message: `Join my collaborative playlist: ${pendingToken}`,
        title: 'Playlist invitation',
      });
    } catch {
      // Dismissing the share sheet is not an error worth surfacing.
    }
  }, [pendingToken]);

  const handleRevoke = useCallback(
    (invitation: PlaylistInvitation) => {
      Alert.alert('Revoke invitation?', 'This invitation link will stop working immediately.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            setBusyId(invitation.id);
            revokeInvitation(api, playlistId, invitation.id)
              .then(() => load())
              .catch((err: unknown) => {
                Alert.alert('Could not revoke invitation', apiErrorMessage(err));
              })
              .finally(() => setBusyId(null));
          },
        },
      ]);
    },
    [api, load, playlistId],
  );

  const handleRemoveMember = useCallback(
    (member: PlaylistMember) => {
      Alert.alert(
        'Remove member?',
        `${member.displayName} will lose access to this playlist immediately.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              setBusyId(member.userId);
              removeMember(api, playlistId, member.userId)
                .then(() => load())
                .catch((err: unknown) => {
                  Alert.alert('Could not remove member', apiErrorMessage(err));
                })
                .finally(() => setBusyId(null));
            },
          },
        ],
      );
    },
    [api, load, playlistId],
  );

  const handleLeave = useCallback(() => {
    Alert.alert('Leave playlist?', 'You will lose access to this collaborative playlist.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          leavePlaylist(api, playlistId)
            .then(() => router.replace('/my-playlists'))
            .catch((err: unknown) => {
              Alert.alert('Could not leave playlist', apiErrorMessage(err));
            });
        },
      },
    ]);
  }, [api, playlistId, router]);

  if (loading) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="playlist-members-screen">
        <LoadingState message="Loading members…" />
      </Screen>
    );
  }

  if (error || !members) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="playlist-members-screen">
        <ErrorState message={apiErrorMessage(error)} onRetry={() => void load()} />
      </Screen>
    );
  }

  const activeInvitations = invitations.filter((i) => !i.usedAt && !i.revokedAt);

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="playlist-members-screen">
      <Stack.Screen options={{ title: 'Members' }} />
      <ScrollView contentContainerStyle={styles.content}>
        {actionsBlocked ? (
          <Text style={styles.offlineHint} testID="members-offline-hint">
            Member actions are unavailable offline.
          </Text>
        ) : null}

        {pendingToken ? (
          <View style={styles.tokenCard} testID="invitation-token-card">
            <Text style={styles.tokenTitle}>Invitation created</Text>
            <Text style={styles.tokenHint}>
              This token is shown once — share it now. It expires in 7 days and stops working after
              one use.
            </Text>
            <Text style={styles.token} selectable testID="invitation-token">
              {pendingToken}
            </Text>
            <View style={styles.tokenActions}>
              <Button
                title="Copy"
                onPress={() => void handleCopyToken()}
                testID="invitation-copy"
              />
              <Button
                title="Share"
                variant="secondary"
                onPress={() => void handleShareToken()}
                testID="invitation-share"
              />
              <Button
                title="Done"
                variant="secondary"
                onPress={() => setPendingToken(null)}
                testID="invitation-done"
              />
            </View>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>Members ({members.length})</Text>
        {members.map((member) => {
          const isSelf = user?.id === member.userId;
          const busy = busyId === member.userId;
          return (
            <View key={member.userId} style={styles.row} testID={`member-row-${member.userId}`}>
              <View style={styles.memberInfo}>
                <Text style={styles.memberName} numberOfLines={1}>
                  {member.displayName}
                  {isSelf ? ' (you)' : ''}
                </Text>
                <Text style={styles.memberRole}>{roleLabel(member.role)}</Text>
              </View>
              {isOwner && member.role !== 'OWNER' ? (
                <Pressable
                  onPress={() => handleRemoveMember(member)}
                  disabled={busy || actionsBlocked}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${member.displayName}`}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                  testID={`member-remove-${member.userId}`}
                >
                  <Ionicons name="person-remove-outline" size={fontSize.md} color={colors.error} />
                </Pressable>
              ) : null}
            </View>
          );
        })}

        {isOwner ? (
          <>
            <Text style={styles.sectionTitle}>Invitations</Text>
            <Button
              title={creating ? 'Creating…' : 'Create invitation'}
              variant="secondary"
              disabled={creating || actionsBlocked}
              onPress={() => void handleCreateInvitation()}
              testID="create-invitation-button"
            />
            {activeInvitations.length === 0 ? (
              <Text style={styles.emptyText}>No active invitations.</Text>
            ) : (
              activeInvitations.map((invitation) => {
                const busy = busyId === invitation.id;
                return (
                  <View
                    key={invitation.id}
                    style={styles.row}
                    testID={`invitation-row-${invitation.id}`}
                  >
                    <View style={styles.memberInfo}>
                      <Text style={styles.memberName}>
                        Expires {new Date(invitation.expiresAt).toLocaleDateString()}
                      </Text>
                      <Text style={styles.memberRole}>
                        Created {new Date(invitation.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleRevoke(invitation)}
                      disabled={busy || actionsBlocked}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Revoke invitation"
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                      testID={`invitation-revoke-${invitation.id}`}
                    >
                      <Ionicons name="close" size={fontSize.md} color={colors.error} />
                    </Pressable>
                  </View>
                );
              })
            )}
          </>
        ) : null}

        {isMember && !isOwner ? (
          <View style={styles.leaveWrap}>
            <Button
              title="Leave playlist"
              variant="secondary"
              disabled={actionsBlocked}
              onPress={handleLeave}
              testID="leave-playlist-button"
            />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg },
  offlineHint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  tokenCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  tokenTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  tokenHint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    lineHeight: fontSize.sm * 1.5,
  },
  token: {
    color: colors.text,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  tokenActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  memberInfo: { flex: 1, minWidth: 0 },
  memberName: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },
  memberRole: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  iconButton: {
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pressed: { opacity: 0.6 },
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
  leaveWrap: { marginTop: spacing.xl },
});

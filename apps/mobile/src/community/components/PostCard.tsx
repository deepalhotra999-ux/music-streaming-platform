// Phase 29 — post preview card used by the community feed, artist profile
// posts, and the artist dashboard. Shows author, body, optional track/album
// attachments (references only — tapping a track plays it through the
// shared PlaybackEngine), and an idempotent like button with counts.

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ArtistPost } from '../../api';
import { colors } from '../../theme';
import { spacing } from '../../theme/spacing';

interface PostCardProps {
  post: ArtistPost;
  /** Called when the like button is tapped. Parent owns the mutation. */
  onToggleReaction?: (post: ArtistPost) => void;
  /** Called when the card body is tapped (navigates to detail). */
  onOpen?: (post: ArtistPost) => void;
  /** Called when the attached track chip is tapped (plays via engine). */
  onPlayTrack?: (post: ArtistPost) => void;
  reactionPending?: boolean;
  testID?: string;
}

export const PostCard = memo(function PostCard({
  post,
  onToggleReaction,
  onOpen,
  onPlayTrack,
  reactionPending,
  testID,
}: PostCardProps) {
  const reacted = post.viewerReacted === true;
  return (
    <View style={styles.card} testID={testID}>
      <Pressable
        onPress={() => onOpen?.(post)}
        accessibilityRole="button"
        accessibilityLabel={`Open post by ${post.artist.name}`}
        testID={testID ? `${testID}-open` : undefined}
      >
        <View style={styles.header}>
          <View style={styles.artistBadge}>
            <Ionicons name="mic" size={14} color={colors.primary} />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.artistName} numberOfLines={1}>
              {post.artist.name}
              {post.artist.verified ? ' ✓' : ''}
            </Text>
            <Text style={styles.timestamp} numberOfLines={1}>
              {new Date(post.publishedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </Text>
          </View>
          {post.status !== 'ACTIVE' ? (
            <View style={styles.statusPill}>
              <Text style={styles.statusText}>{post.status}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.body} numberOfLines={6}>
          {post.body}
        </Text>
      </Pressable>

      {post.track ? (
        <Pressable
          style={styles.attachment}
          onPress={() => onPlayTrack?.(post)}
          accessibilityRole="button"
          accessibilityLabel={`Play ${post.track.title}`}
          testID={testID ? `${testID}-track` : undefined}
        >
          <Ionicons name="musical-note" size={16} color={colors.primary} />
          <View style={styles.attachmentText}>
            <Text style={styles.attachmentTitle} numberOfLines={1}>
              {post.track.title}
            </Text>
            <Text style={styles.attachmentSub} numberOfLines={1}>
              {post.track.artistName}
              {post.track.albumTitle ? ` · ${post.track.albumTitle}` : ''}
            </Text>
          </View>
          <Ionicons name="play" size={18} color={colors.textMuted} />
        </Pressable>
      ) : null}

      {post.album && !post.track ? (
        <View style={styles.attachment}>
          <Ionicons name="disc" size={16} color={colors.primary} />
          <View style={styles.attachmentText}>
            <Text style={styles.attachmentTitle} numberOfLines={1}>
              {post.album.title}
            </Text>
            <Text style={styles.attachmentSub} numberOfLines={1}>
              {post.album.artistName}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.footer}>
        <Pressable
          style={styles.action}
          onPress={() => onToggleReaction?.(post)}
          disabled={reactionPending}
          accessibilityRole="button"
          accessibilityLabel={reacted ? 'Unlike post' : 'Like post'}
          accessibilityState={{ selected: reacted }}
          testID={testID ? `${testID}-like` : undefined}
        >
          <Ionicons
            name={reacted ? 'heart' : 'heart-outline'}
            size={20}
            color={reacted ? colors.primary : colors.textMuted}
          />
          <Text style={[styles.actionText, reacted && styles.actionTextActive]}>
            {post.reactionCount}
          </Text>
        </Pressable>
        <Pressable
          style={styles.action}
          onPress={() => onOpen?.(post)}
          accessibilityRole="button"
          accessibilityLabel="View comments"
          testID={testID ? `${testID}-comments` : undefined}
        >
          <Ionicons name="chatbubble-outline" size={20} color={colors.textMuted} />
          <Text style={styles.actionText}>{post.commentCount}</Text>
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: spacing.sm,
  },
  artistBadge: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  headerText: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  artistName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  timestamp: {
    color: colors.textFaint,
    fontSize: 12,
    marginTop: 2,
  },
  statusPill: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  body: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  attachment: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: 10,
    flexDirection: 'row',
    marginTop: spacing.sm,
    padding: spacing.sm,
  },
  attachmentText: {
    flex: 1,
    marginHorizontal: spacing.sm,
  },
  attachmentTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  attachmentSub: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  footer: {
    flexDirection: 'row',
    marginTop: spacing.sm,
  },
  action: {
    alignItems: 'center',
    flexDirection: 'row',
    marginRight: spacing.lg,
    paddingVertical: spacing.xs,
  },
  actionText: {
    color: colors.textMuted,
    fontSize: 13,
    marginLeft: 6,
  },
  actionTextActive: {
    color: colors.primary,
  },
});

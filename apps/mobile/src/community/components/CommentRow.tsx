// Phase 29 — a single flat comment row. Authors can delete their own
// comment; anyone else gets a report affordance. No nesting by design.

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PostComment } from '../../api';
import { colors } from '../../theme';
import { spacing } from '../../theme/spacing';

interface CommentRowProps {
  comment: PostComment;
  isOwn: boolean;
  onDelete?: (comment: PostComment) => void;
  onReport?: (comment: PostComment) => void;
  testID?: string;
}

export const CommentRow = memo(function CommentRow({
  comment,
  isOwn,
  onDelete,
  onReport,
  testID,
}: CommentRowProps) {
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.avatar}>
        <Ionicons name="person" size={14} color={colors.textMuted} />
      </View>
      <View style={styles.content}>
        <View style={styles.meta}>
          <Text style={styles.author} numberOfLines={1}>
            {comment.author.displayName}
          </Text>
          <Text style={styles.timestamp}>
            {new Date(comment.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </Text>
        </View>
        <Text style={styles.body}>{comment.body}</Text>
      </View>
      {isOwn ? (
        <Pressable
          onPress={() => onDelete?.(comment)}
          accessibilityRole="button"
          accessibilityLabel="Delete comment"
          hitSlop={12}
          testID={testID ? `${testID}-delete` : undefined}
        >
          <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
        </Pressable>
      ) : (
        <Pressable
          onPress={() => onReport?.(comment)}
          accessibilityRole="button"
          accessibilityLabel="Report comment"
          hitSlop={12}
          testID={testID ? `${testID}-report` : undefined}
        >
          <Ionicons name="flag-outline" size={18} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    paddingVertical: spacing.sm,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    marginRight: spacing.sm,
    width: 28,
  },
  content: {
    flex: 1,
  },
  meta: {
    alignItems: 'baseline',
    flexDirection: 'row',
    marginBottom: 2,
  },
  author: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    marginRight: spacing.sm,
  },
  timestamp: {
    color: colors.textFaint,
    fontSize: 11,
  },
  body: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
});

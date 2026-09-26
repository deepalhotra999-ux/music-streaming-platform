// Phase 29 — post detail: full text, attachments, reactions, flat
// comments, report flow, and author edit/delete. Moderated or deleted
// posts 404 for outsiders ("no longer available"); the author still sees
// their own DELETED post with its status.

import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { ArtistPost, PostComment, ReactionResult } from '../api';
import {
  addReaction,
  ApiError,
  apiErrorMessage,
  createComment,
  deleteComment,
  deletePost,
  getPost,
  listComments,
  removeReaction,
  reportCommunityContent,
  updatePost,
} from '../api';
import { useAuth } from '../auth';
import { usePlayback } from '../playback';
import { usePaginatedList } from '../catalog';
import { FollowButton } from '../library';
import { Button, EmptyState, ErrorState, LoadingState, Screen, TextInput } from '../components';
import { colors, spacing } from '../theme';
import { CommentRow } from '../community/components/CommentRow';
import { ReportDialog } from '../community/components/ReportDialog';

const COMMENT_LIMIT = 20;

export function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, user } = useAuth();
  const router = useRouter();
  const { setQueue } = usePlayback();

  const [post, setPost] = useState<ArtistPost | null>(null);
  const [loadingPost, setLoadingPost] = useState(true);
  const [postError, setPostError] = useState<unknown>(null);
  const [reactionPending, setReactionPending] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentPosting, setCommentPosting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<
    { kind: 'post' } | { kind: 'comment'; comment: PostComment } | null
  >(null);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);

  const loadPost = useCallback(async () => {
    if (!id) {
      return;
    }
    setLoadingPost(true);
    setPostError(null);
    try {
      const result = await getPost(api, id);
      setPost(result);
      setEditBody(result.body);
    } catch (err) {
      setPostError(err);
    } finally {
      setLoadingPost(false);
    }
  }, [api, id]);

  useEffect(() => {
    void loadPost();
  }, [loadPost]);

  const fetchComments = useCallback(
    (page: number) => {
      if (!id) {
        return Promise.reject(new Error('Missing post id'));
      }
      return listComments(api, id, { page, limit: COMMENT_LIMIT });
    },
    [api, id],
  );
  const comments = usePaginatedList<PostComment>(fetchComments);

  const isAuthor = post != null && user != null && post.author.id === user.id;

  const toggleReaction = useCallback(async () => {
    if (!post || reactionPending) {
      return;
    }
    setReactionPending(true);
    const previous = { viewerReacted: post.viewerReacted, reactionCount: post.reactionCount };
    setPost({
      ...post,
      viewerReacted: !(post.viewerReacted === true),
      reactionCount: post.reactionCount + (post.viewerReacted === true ? -1 : 1),
    });
    try {
      const result: ReactionResult =
        previous.viewerReacted === true
          ? await removeReaction(api, post.id)
          : await addReaction(api, post.id);
      setPost((current) =>
        current
          ? { ...current, viewerReacted: result.reacted, reactionCount: result.reactionCount }
          : current,
      );
    } catch {
      setPost((current) => (current ? { ...current, ...previous } : current));
    } finally {
      setReactionPending(false);
    }
  }, [api, post, reactionPending]);

  const submitComment = useCallback(async () => {
    const body = commentDraft.trim();
    if (!post || body.length === 0 || commentPosting) {
      return;
    }
    setCommentPosting(true);
    setCommentError(null);
    try {
      await createComment(api, post.id, body);
      setCommentDraft('');
      comments.refresh();
      setPost((current) =>
        current ? { ...current, commentCount: current.commentCount + 1 } : current,
      );
    } catch (err) {
      setCommentError(apiErrorMessage(err));
    } finally {
      setCommentPosting(false);
    }
  }, [api, commentDraft, commentPosting, comments, post]);

  const handleDeleteComment = useCallback(
    (comment: PostComment) => {
      Alert.alert('Delete comment?', 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await deleteComment(api, comment.id);
                comments.refresh();
                setPost((current) =>
                  current
                    ? { ...current, commentCount: Math.max(0, current.commentCount - 1) }
                    : current,
                );
              } catch {
                // Leave the row in place; the list refresh on next focus.
              }
            })();
          },
        },
      ]);
    },
    [api, comments],
  );

  const submitReport = useCallback(
    async (reason: string) => {
      if (!post || !reportTarget) {
        return;
      }
      setReportSubmitting(true);
      setReportError(null);
      try {
        await reportCommunityContent(api, {
          targetType: reportTarget.kind === 'post' ? 'ARTIST_POST' : 'POST_COMMENT',
          targetId: reportTarget.kind === 'post' ? post.id : reportTarget.comment.id,
          reason,
        });
        setReported(true);
        setReportTarget(null);
      } catch (err) {
        setReportError(apiErrorMessage(err));
      } finally {
        setReportSubmitting(false);
      }
    },
    [api, post, reportTarget],
  );

  const saveEdit = useCallback(async () => {
    if (!post) {
      return;
    }
    const body = editBody.trim();
    if (body.length === 0 || body === post.body) {
      setEditing(false);
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const updated = await updatePost(api, post.id, { body });
      setPost(updated);
      setEditing(false);
    } catch (err) {
      setEditError(apiErrorMessage(err));
    } finally {
      setEditSaving(false);
    }
  }, [api, editBody, post]);

  const handleDeletePost = useCallback(() => {
    if (!post) {
      return;
    }
    Alert.alert('Delete post?', 'Your post will be removed from the community.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deletePost(api, post.id);
              router.back();
            } catch {
              // Surface via a fresh load if the delete failed.
              void loadPost();
            }
          })();
        },
      },
    ]);
  }, [api, loadPost, post, router]);

  const playAttachedTrack = useCallback(() => {
    if (post?.track) {
      void setQueue(
        [
          {
            trackId: post.track.id,
            title: post.track.title,
            artistName: post.track.artistName,
            albumTitle: post.track.albumTitle,
            durationMs: post.track.durationMs,
          },
        ],
        0,
      );
    }
  }, [post, setQueue]);

  if (loadingPost) {
    return (
      <Screen edges={['bottom']} testID="post-detail-screen">
        <LoadingState message="Loading post…" />
      </Screen>
    );
  }

  if (postError || !post) {
    const gone = postError instanceof ApiError && postError.status === 404;
    return (
      <Screen edges={['bottom']} testID="post-detail-screen">
        <ErrorState
          message={gone ? 'This post is no longer available.' : apiErrorMessage(postError)}
          onRetry={loadPost}
        />
      </Screen>
    );
  }

  const reacted = post.viewerReacted === true;

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="post-detail-screen">
      <FlatList
        data={comments.items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={comments.refreshing}
            onRefresh={() => {
              void loadPost();
              comments.refresh();
            }}
            tintColor={colors.primary}
          />
        }
        onEndReached={comments.loadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <View style={styles.artistBadge}>
                <Ionicons name="mic" size={16} color={colors.primary} />
              </View>
              <View style={styles.headerText}>
                <Text style={styles.artistName}>
                  {post.artist.name}
                  {post.artist.verified ? ' ✓' : ''}
                </Text>
                <Text style={styles.timestamp}>
                  {new Date(post.publishedAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </Text>
              </View>
              <FollowButton artistId={post.artist.id} />
            </View>

            {post.status !== 'ACTIVE' ? (
              <View style={styles.statusBanner}>
                <Text style={styles.statusBannerText}>
                  {post.status === 'DELETED'
                    ? 'You deleted this post. It is hidden from the community.'
                    : 'This post was removed by moderation and is hidden from the community.'}
                </Text>
              </View>
            ) : null}

            {editing ? (
              <View style={styles.editor}>
                <TextInput
                  label="Edit post"
                  value={editBody}
                  onChangeText={setEditBody}
                  multiline
                  numberOfLines={5}
                  maxLength={2000}
                  editable={!editSaving}
                  testID="post-detail-edit-input"
                />
                {editError ? <Text style={styles.error}>{editError}</Text> : null}
                <View style={styles.editorActions}>
                  <Button
                    title="Cancel"
                    variant="secondary"
                    onPress={() => {
                      setEditBody(post.body);
                      setEditing(false);
                    }}
                    disabled={editSaving}
                  />
                  <Button
                    title={editSaving ? 'Saving…' : 'Save'}
                    onPress={saveEdit}
                    disabled={editSaving || editBody.trim().length === 0}
                    testID="post-detail-save"
                  />
                </View>
              </View>
            ) : (
              <Text style={styles.body}>{post.body}</Text>
            )}

            {post.track ? (
              <Pressable
                style={styles.attachment}
                onPress={playAttachedTrack}
                accessibilityRole="button"
                accessibilityLabel={`Play ${post.track.title}`}
                testID="post-detail-track"
              >
                <Ionicons name="musical-note" size={18} color={colors.primary} />
                <View style={styles.attachmentText}>
                  <Text style={styles.attachmentTitle}>{post.track.title}</Text>
                  <Text style={styles.attachmentSub}>
                    {post.track.artistName}
                    {post.track.albumTitle ? ` · ${post.track.albumTitle}` : ''}
                  </Text>
                </View>
                <Ionicons name="play" size={20} color={colors.textMuted} />
              </Pressable>
            ) : null}
            {post.album && !post.track ? (
              <View style={styles.attachment}>
                <Ionicons name="disc" size={18} color={colors.primary} />
                <View style={styles.attachmentText}>
                  <Text style={styles.attachmentTitle}>{post.album.title}</Text>
                  <Text style={styles.attachmentSub}>{post.album.artistName}</Text>
                </View>
              </View>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                style={styles.action}
                onPress={toggleReaction}
                disabled={reactionPending || post.status !== 'ACTIVE'}
                accessibilityRole="button"
                accessibilityLabel={reacted ? 'Unlike post' : 'Like post'}
                testID="post-detail-like"
              >
                <Ionicons
                  name={reacted ? 'heart' : 'heart-outline'}
                  size={22}
                  color={reacted ? colors.primary : colors.textMuted}
                />
                <Text style={[styles.actionText, reacted && styles.actionTextActive]}>
                  {post.reactionCount}
                </Text>
              </Pressable>
              {isAuthor ? (
                <>
                  <Pressable
                    style={styles.action}
                    onPress={() => setEditing(true)}
                    disabled={post.status !== 'ACTIVE'}
                    accessibilityRole="button"
                    accessibilityLabel="Edit post"
                    testID="post-detail-edit"
                  >
                    <Ionicons name="pencil-outline" size={20} color={colors.textMuted} />
                    <Text style={styles.actionText}>Edit</Text>
                  </Pressable>
                  <Pressable
                    style={styles.action}
                    onPress={handleDeletePost}
                    accessibilityRole="button"
                    accessibilityLabel="Delete post"
                    testID="post-detail-delete"
                  >
                    <Ionicons name="trash-outline" size={20} color={colors.textMuted} />
                    <Text style={styles.actionText}>Delete</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  style={styles.action}
                  onPress={() => (reported ? undefined : setReportTarget({ kind: 'post' }))}
                  accessibilityRole="button"
                  accessibilityLabel="Report post"
                  testID="post-detail-report"
                >
                  <Ionicons
                    name="flag-outline"
                    size={20}
                    color={reported ? colors.primary : colors.textMuted}
                  />
                  <Text style={[styles.actionText, reported && styles.actionTextActive]}>
                    {reported ? 'Reported' : 'Report'}
                  </Text>
                </Pressable>
              )}
            </View>

            <Text style={styles.commentsTitle}>Comments ({post.commentCount})</Text>
            {commentError ? <Text style={styles.error}>{commentError}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          comments.loading ? (
            <LoadingState message="Loading comments…" />
          ) : (
            <EmptyState title="No comments yet" message="Be the first to reply." />
          )
        }
        ListFooterComponent={
          comments.loadingMore ? (
            <View style={styles.footer}>
              <LoadingState message="Loading more…" />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <CommentRow
            comment={item}
            isOwn={user != null && item.author.id === user.id}
            onDelete={handleDeleteComment}
            onReport={(comment) => setReportTarget({ kind: 'comment', comment })}
            testID={`comment-${item.id}`}
          />
        )}
      />

      {post.status === 'ACTIVE' ? (
        <View style={styles.composer}>
          <View style={styles.composerInput}>
            <TextInput
              label="Comment"
              value={commentDraft}
              onChangeText={setCommentDraft}
              placeholder="Write a comment…"
              maxLength={500}
              editable={!commentPosting}
              testID="post-detail-comment-input"
            />
          </View>
          <Button
            title={commentPosting ? '…' : 'Send'}
            onPress={submitComment}
            disabled={commentDraft.trim().length === 0 || commentPosting}
            testID="post-detail-comment-send"
          />
        </View>
      ) : null}

      <ReportDialog
        visible={reportTarget != null}
        targetLabel={reportTarget?.kind === 'comment' ? 'this comment' : 'this post'}
        submitting={reportSubmitting}
        error={reportError}
        onSubmit={submitReport}
        onClose={() => {
          setReportTarget(null);
          setReportError(null);
        }}
        testID="report-dialog"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    padding: spacing.md,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: spacing.md,
  },
  artistBadge: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  headerText: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  artistName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  timestamp: {
    color: colors.textFaint,
    fontSize: 12,
    marginTop: 2,
  },
  statusBanner: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 10,
    marginBottom: spacing.md,
    padding: spacing.sm,
  },
  statusBannerText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  body: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 24,
    marginBottom: spacing.md,
  },
  editor: {
    marginBottom: spacing.md,
  },
  editorActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    marginTop: spacing.sm,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  attachment: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: spacing.md,
    padding: spacing.sm,
  },
  attachmentText: {
    flex: 1,
    marginHorizontal: spacing.sm,
  },
  attachmentTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  attachmentSub: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  actions: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    marginBottom: spacing.md,
    paddingVertical: spacing.xs,
  },
  action: {
    alignItems: 'center',
    flexDirection: 'row',
    marginRight: spacing.lg,
    paddingVertical: spacing.sm,
  },
  actionText: {
    color: colors.textMuted,
    fontSize: 14,
    marginLeft: 6,
  },
  actionTextActive: {
    color: colors.primary,
  },
  commentsTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  footer: {
    paddingVertical: spacing.md,
  },
  composer: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  composerInput: {
    flex: 1,
  },
});

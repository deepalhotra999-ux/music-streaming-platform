package com.musicstreaming.waveform.auto

import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.Clock
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

// Phase 24 — virtual Media3 Player that projects the JS PlaybackEngine.
//
// Media3 requires a Player instance to build a MediaLibrarySession, but a
// second real player would duplicate HLS session creation, entitlement,
// telemetry, and audio focus (ADR-018). AutoPlayer therefore plays nothing:
// it keeps a projected playlist + playback state pushed from JS, and it
// forwards every command (play/pause/stop/seek/next/previous/repeat/
// shuffle, set-media-items) to JS as bridge events, where the one real
// PlaybackEngine executes them.
//
// Built on SimpleBasePlayer (verified against media3-common 1.9.0
// sources): the whole Player contract is derived from a single immutable
// State snapshot built in getState(), and each command funnels into one
// handle* override. All state reads/writes happen on the main looper,
// which the service guarantees via runOnPlayerThread.
//
// Position while playing: JS pushes the absolute position with each state
// update; between updates getState() extrapolates using the wall clock.

@UnstableApi
internal class AutoPlayer : SimpleBasePlayer(Looper.getMainLooper()) {

  private data class QueueEntry(val mediaItem: MediaItem, val durationMs: Long)

  companion object {
    private val COMMANDS: Player.Commands =
      Player.Commands.Builder()
        .addAll(
          Player.COMMAND_PLAY_PAUSE,
          Player.COMMAND_PREPARE,
          Player.COMMAND_STOP,
          Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
          Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
          Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
          Player.COMMAND_SEEK_TO_PREVIOUS,
          Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
          Player.COMMAND_SEEK_TO_NEXT,
          Player.COMMAND_SEEK_TO_MEDIA_ITEM,
          Player.COMMAND_SEEK_BACK,
          Player.COMMAND_SEEK_FORWARD,
          Player.COMMAND_SET_REPEAT_MODE,
          Player.COMMAND_SET_SHUFFLE_MODE,
          Player.COMMAND_SET_MEDIA_ITEM,
          Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
          Player.COMMAND_GET_TIMELINE,
          Player.COMMAND_GET_METADATA,
        )
        .build()
  }

  @Volatile private var queue: List<QueueEntry> = emptyList()
  @Volatile private var activeIndex: Int = 0
  @Volatile private var playbackState: Int = Player.STATE_IDLE
  @Volatile private var playWhenReady: Boolean = false
  @Volatile private var playerError: PlaybackException? = null
  @Volatile private var repeatMode: Int = Player.REPEAT_MODE_OFF
  @Volatile private var shuffleEnabled: Boolean = false

  /** Last absolute position pushed from JS, with the push timestamp. */
  @Volatile private var positionAnchorMs: Long = 0
  @Volatile private var positionAnchorElapsedMs: Long = 0

  /**
   * Media ids of the last queue JS projected. When the session issues the
   * follow-up player.setMediaItems(empty) after onSetMediaItems, the flag
   * below swallows it; a genuine non-empty request that is not the
   * projected queue is forwarded to JS instead.
   */
  @Volatile private var lastProjectedIds: List<String> = emptyList()

  @Volatile private var suppressNextSetMediaItems: Boolean = false

  // ------------------------------------------------------------------ //
  // Projection API — called by the service when JS pushes updates.      //
  // ------------------------------------------------------------------ //

  fun setProjectedQueue(items: List<MediaItem>, durationsMs: List<Long>, activeIndex: Int) {
    verifyApplicationThread()
    queue = items.mapIndexed { index, item ->
      QueueEntry(item, durationsMs.getOrElse(index) { C.TIME_UNSET })
    }
    this.activeIndex = activeIndex
    lastProjectedIds = items.map { it.mediaId }
    invalidateState()
  }

  fun setProjectedState(state: Int, positionMs: Long, error: PlaybackException?) {
    verifyApplicationThread()
    playbackState = state
    positionAnchorMs = positionMs.coerceAtLeast(0)
    positionAnchorElapsedMs = Clock.DEFAULT.elapsedRealtime()
    playerError = error
    invalidateState()
  }

  fun setProjectedPlayWhenReady(value: Boolean) {
    verifyApplicationThread()
    playWhenReady = value
    invalidateState()
  }

  fun setProjectedRepeatShuffle(mode: Int, shuffle: Boolean) {
    verifyApplicationThread()
    repeatMode = mode
    shuffleEnabled = shuffle
    invalidateState()
  }

  fun reset() {
    verifyApplicationThread()
    queue = emptyList()
    activeIndex = 0
    lastProjectedIds = emptyList()
    playbackState = Player.STATE_IDLE
    playWhenReady = false
    positionAnchorMs = 0
    playerError = null
    invalidateState()
  }

  /**
   * Swallow the next handleSetMediaItems call once. Used by the session
   * callback after it has already forwarded the request to JS: the session
   * still calls into the player with the (empty) resolution, and that call
   * must not be re-forwarded.
   */
  fun suppressNextSetMediaItems() {
    suppressNextSetMediaItems = true
  }

  // ------------------------------------------------------------------ //
  // SimpleBasePlayer implementation.                                    //
  // ------------------------------------------------------------------ //

  override fun getState(): State {
    val items = queue
    val empty = items.isEmpty()
    val index = if (empty) C.INDEX_UNSET else activeIndex.coerceIn(0, items.size - 1)
    return State.Builder()
      .setAvailableCommands(COMMANDS)
      .setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE)
      // An empty playlist must report IDLE or ENDED.
      .setPlaybackState(if (empty) Player.STATE_IDLE else playbackState)
      .setIsLoading(!empty && playbackState == Player.STATE_BUFFERING)
      .setPlayerError(playerError)
      .setRepeatMode(repeatMode)
      .setShuffleModeEnabled(shuffleEnabled)
      .setPlaybackParameters(PlaybackParameters.DEFAULT)
      .setSeekBackIncrementMs(10_000L)
      .setSeekForwardIncrementMs(10_000L)
      .setMaxSeekToPreviousPositionMs(3_000L)
      .setPlaylist(
        items.mapIndexed { i, entry ->
          MediaItemData.Builder(
              entry.mediaItem.mediaId.ifBlank { "item-$i" })
            .setMediaItem(entry.mediaItem)
            .setDurationUs(
              if (entry.durationMs == C.TIME_UNSET) C.TIME_UNSET
              else entry.durationMs * 1000)
            .setIsSeekable(true)
            .build()
        })
      .setCurrentMediaItemIndex(index)
      .setContentPositionMs(PositionSupplier { currentPositionMs() })
      .setContentBufferedPositionMs(PositionSupplier { currentPositionMs() })
      .build()
  }

  /** Extrapolated position between JS pushes; static unless playing. */
  private fun currentPositionMs(): Long {
    val anchor = positionAnchorMs
    if (playbackState != Player.STATE_READY || !playWhenReady || playerError != null) {
      return anchor
    }
    val elapsed = Clock.DEFAULT.elapsedRealtime() - positionAnchorElapsedMs
    val extrapolated = anchor + elapsed
    val durationMs = queue.getOrNull(activeIndex)?.durationMs ?: C.TIME_UNSET
    return if (durationMs != C.TIME_UNSET && durationMs > 0) {
      extrapolated.coerceIn(0, durationMs)
    } else {
      extrapolated.coerceAtLeast(0)
    }
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    AutoBridge.sendEvent("onCommand", mapOf("command" to if (playWhenReady) "play" else "pause"))
    return Futures.immediateFuture(null)
  }

  override fun handlePrepare(): ListenableFuture<*> {
    AutoBridge.sendEvent("onCommand", mapOf("command" to "prepare"))
    return Futures.immediateFuture(null)
  }

  override fun handleStop(): ListenableFuture<*> {
    AutoBridge.sendEvent("onCommand", mapOf("command" to "stop"))
    return Futures.immediateFuture(null)
  }

  override fun handleRelease(): ListenableFuture<*> {
    // Nothing to release: no decoders, surfaces, or audio focus. The
    // service owns the lifecycle and calls reset() when JS detaches.
    return Futures.immediateFuture(null)
  }

  override fun handleSetRepeatMode(@Player.RepeatMode repeatMode: Int): ListenableFuture<*> {
    AutoBridge.sendEvent("onCommand", mapOf("command" to "repeat", "repeatMode" to repeatMode))
    return Futures.immediateFuture(null)
  }

  override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> {
    AutoBridge.sendEvent(
      "onCommand", mapOf("command" to "shuffle", "shuffle" to shuffleModeEnabled))
    return Futures.immediateFuture(null)
  }

  override fun handleSetMediaItems(
    mediaItems: List<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<*> {
    if (suppressNextSetMediaItems) {
      suppressNextSetMediaItems = false
      return Futures.immediateFuture(null)
    }
    val incomingIds = mediaItems.map { it.mediaId }
    if (incomingIds == lastProjectedIds && incomingIds.isNotEmpty()) {
      // Loop-back of a queue JS already projected: nothing to do, the
      // projection already describes this queue.
      return Futures.immediateFuture(null)
    }
    // A genuine car-side set request (e.g. the session resolving a legacy
    // playFromMediaId). JS rebuilds the queue through the engine and pushes
    // the projection back.
    AutoBridge.sendEvent(
      "onPlayRequest",
      mapOf(
        "requestId" to "player-set-items",
        "mediaIds" to incomingIds,
        "startIndex" to startIndex,
      ),
    )
    return Futures.immediateFuture(null)
  }

  override fun handleAddMediaItems(index: Int, mediaItems: List<MediaItem>): ListenableFuture<*> {
    // Queue editing is not advertised (JS owns the queue); the session only
    // reaches here with the empty resolution from onAddMediaItems.
    return Futures.immediateFuture(null)
  }

  override fun handleMoveMediaItems(fromIndex: Int, toIndex: Int, newIndex: Int): ListenableFuture<*> {
    return Futures.immediateFuture(null)
  }

  override fun handleReplaceMediaItems(
    fromIndex: Int,
    toIndex: Int,
    mediaItems: List<MediaItem>,
  ): ListenableFuture<*> {
    return Futures.immediateFuture(null)
  }

  override fun handleRemoveMediaItems(fromIndex: Int, toIndex: Int): ListenableFuture<*> {
    return Futures.immediateFuture(null)
  }

  /**
   * Single funnel for every seek/next/previous request (SimpleBasePlayer
   * routes all of them here).
   */
  override fun handleSeek(
    mediaItemIndex: Int,
    positionMs: Long,
    @Player.Command seekCommand: Int,
  ): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ->
        AutoBridge.sendEvent("onCommand", mapOf("command" to "next"))
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM ->
        AutoBridge.sendEvent("onCommand", mapOf("command" to "previous"))
      Player.COMMAND_SEEK_TO_MEDIA_ITEM, Player.COMMAND_SEEK_TO_DEFAULT_POSITION ->
        if (mediaItemIndex != C.INDEX_UNSET) {
          AutoBridge.sendEvent(
            "onCommand",
            buildMap {
              put("command", "set-item")
              put("index", mediaItemIndex)
              if (positionMs != C.TIME_UNSET) put("positionMs", positionMs)
            },
          )
        }
      else ->
        AutoBridge.sendEvent(
          "onCommand",
          mapOf(
            "command" to "seek",
            "positionMs" to if (positionMs == C.TIME_UNSET) 0L else positionMs,
          ),
        )
    }
    return Futures.immediateFuture(null)
  }
}

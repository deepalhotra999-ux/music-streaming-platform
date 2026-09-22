package com.musicstreaming.waveform.auto

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

// Phase 24 — MediaLibrarySession.Callback implementation for Android Auto.
//
// Every browse/search request is forwarded to the JS controller as a bridge
// event; the returned future completes when JS resolves (or on timeout with
// a safe fallback). Play/select requests are forwarded to JS as well — JS
// rebuilds the queue through the one PlaybackEngine and pushes the updated
// projection back, so the callback never constructs playback state itself.
//
// When JS is not signed in (or not attached), browse answers are produced
// locally: a signed-out root with a single "sign in required" row. This
// keeps cold starts (car connects before React Native mounts) safe.

internal class WaveformLibraryCallback(
  private val player: AutoPlayer,
  private val isSignedIn: () -> Boolean,
) : MediaLibraryService.MediaLibrarySession.Callback {

  companion object {
    private const val TIMEOUT_MS = 8000L

    private const val SIGNIN_ITEM_ID = "waveform:signin-required"

    private fun rootItem(): MediaItem =
      MediaItem.Builder()
        .setMediaId(AutoMediaIds.ROOT)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Waveform")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .build())
        .build()

    private fun signInRequiredItem(): MediaItem =
      MediaItem.Builder()
        .setMediaId(SIGNIN_ITEM_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Sign in required")
            .setSubtitle("Open Waveform on your phone to sign in")
            .setIsBrowsable(false)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .build())
        .build()

    /** Build a browse/playable MediaItem from a JS payload map. */
    fun mediaItemFromPayload(payload: Map<String, Any?>): MediaItem {
      val mediaId = payload["mediaId"] as? String ?: ""
      val metadataBuilder =
        MediaMetadata.Builder()
          .setTitle(payload["title"] as? String ?: "")
          .setIsBrowsable(payload["browsable"] as? Boolean ?: false)
          .setIsPlayable(payload["playable"] as? Boolean ?: false)
          .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
      (payload["subtitle"] as? String)?.let { metadataBuilder.setSubtitle(it) }
      (payload["artworkUrl"] as? String)?.takeIf { it.isNotBlank() }?.let {
        metadataBuilder.setArtworkUri(Uri.parse(it))
      }
      return MediaItem.Builder().setMediaId(mediaId).setMediaMetadata(metadataBuilder.build()).build()
    }
  }

  /**
   * Forward a request to JS and complete the returned future when JS
   * resolves. On timeout, complete with [onTimeout]. Only the first of
   * resolve/timeout wins.
   */
  private fun <T> requestJs(
    eventName: String,
    eventPayload: Map<String, Any?>,
    onTimeout: () -> T,
    mapResult: (Map<String, Any?>?) -> T,
  ): ListenableFuture<T> {
    val future = SettableFuture.create<T>()
    val requestId = UUID.randomUUID().toString()
    val finished = AtomicBoolean(false)
    val finish: (T) -> Unit = { value ->
      if (finished.compareAndSet(false, true)) {
        AutoBridge.pending.remove(requestId)
        future.set(value)
      }
    }
    AutoBridge.pending[requestId] = { payload -> finish(mapResult(payload)) }
    Handler(Looper.getMainLooper()).postDelayed({ finish(onTimeout()) }, TIMEOUT_MS)
    AutoBridge.sendEvent(eventName, eventPayload + ("requestId" to requestId))
    return future
  }

  override fun onGetLibraryRoot(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    params: MediaLibraryService.LibraryParams?,
  ): ListenableFuture<LibraryResult<MediaItem>> {
    if (!isSignedIn()) {
      return com.google.common.util.concurrent.Futures.immediateFuture(
        LibraryResult.ofItem(rootItem(), params))
    }
    return requestJs(
      eventName = "onLibraryRootRequest",
      eventPayload = emptyMap(),
      onTimeout = { LibraryResult.ofItem(rootItem(), params) },
      mapResult = { payload ->
        val rootId = payload?.get("rootId") as? String ?: AutoMediaIds.ROOT
        LibraryResult.ofItem(
          rootItem().buildUpon().setMediaId(rootId).build(), params)
      },
    )
  }

  override fun onGetChildren(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    page: Int,
    pageSize: Int,
    params: MediaLibraryService.LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    if (!isSignedIn()) {
      // Cold start / signed out: answer locally so the car never hangs.
      val items =
        if (parentId == AutoMediaIds.ROOT) {
          ImmutableList.of(signInRequiredItem())
        } else {
          ImmutableList.of()
        }
      return com.google.common.util.concurrent.Futures.immediateFuture(
        LibraryResult.ofItemList(items, params))
    }
    return requestJs(
      eventName = "onChildrenRequest",
      eventPayload =
        mapOf("parentId" to parentId, "page" to page, "pageSize" to pageSize),
      onTimeout = { LibraryResult.ofItemList(ImmutableList.of(), params) },
      mapResult = { payload ->
        val ok = payload?.get("ok") as? Boolean ?: false
        if (!ok) {
          LibraryResult.ofError(LibraryResult.RESULT_ERROR_UNKNOWN)
        } else {
          val items =
            (payload?.get("items") as? List<*>)
              ?.filterIsInstance<Map<String, Any?>>()
              ?.map { mediaItemFromPayload(it) } ?: emptyList()
          LibraryResult.ofItemList(ImmutableList.copyOf(items), params)
        }
      },
    )
  }

  override fun onGetItem(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    mediaId: String,
  ): ListenableFuture<LibraryResult<MediaItem>> {
    if (!isSignedIn()) {
      return com.google.common.util.concurrent.Futures.immediateFuture(
        LibraryResult.ofError(LibraryResult.RESULT_ERROR_PERMISSION_DENIED))
    }
    return requestJs(
      eventName = "onItemRequest",
      eventPayload = mapOf("mediaId" to mediaId),
      onTimeout = { LibraryResult.ofError(LibraryResult.RESULT_ERROR_UNKNOWN) },
      mapResult = { payload ->
        val item = (payload?.get("item") as? Map<String, Any?>)?.let { mediaItemFromPayload(it) }
        if (item != null) LibraryResult.ofItem(item, null)
        else LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
      },
    )
  }

  override fun onSearch(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    query: String,
    params: MediaLibraryService.LibraryParams?,
  ): ListenableFuture<LibraryResult<Void>> {
    if (!isSignedIn() || query.isBlank()) {
      return com.google.common.util.concurrent.Futures.immediateFuture(LibraryResult.ofVoid(params))
    }
    // Acknowledge immediately; the host then calls onGetSearchResult, which
    // carries the actual results. The query is re-sent there.
    return com.google.common.util.concurrent.Futures.immediateFuture(LibraryResult.ofVoid(params))
  }

  override fun onGetSearchResult(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    query: String,
    page: Int,
    pageSize: Int,
    params: MediaLibraryService.LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    if (!isSignedIn() || query.isBlank()) {
      return com.google.common.util.concurrent.Futures.immediateFuture(
        LibraryResult.ofItemList(ImmutableList.of(), params))
    }
    return requestJs(
      eventName = "onSearchRequest",
      eventPayload = mapOf("query" to query, "page" to page, "pageSize" to pageSize),
      onTimeout = { LibraryResult.ofItemList(ImmutableList.of(), params) },
      mapResult = { payload ->
        val items =
          (payload?.get("items") as? List<*>)
            ?.filterIsInstance<Map<String, Any?>>()
            ?.map { mediaItemFromPayload(it) } ?: emptyList()
        LibraryResult.ofItemList(ImmutableList.copyOf(items), params)
      },
    )
  }

  @UnstableApi
  override fun onSetMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: List<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
    val ids = mediaItems.map { it.mediaId }
    // JS rebuilds the queue through the engine and pushes the projection
    // back; suppress the follow-up player.setMediaItems(empty) call the
    // session will make with our empty resolution.
    player.suppressNextSetMediaItems()
    AutoBridge.sendEvent(
      "onPlayRequest",
      mapOf(
        "requestId" to "session-set-items",
        "mediaIds" to ids,
        "startIndex" to startIndex,
      ),
    )
    return com.google.common.util.concurrent.Futures.immediateFuture(
      MediaSession.MediaItemsWithStartPosition(
        ImmutableList.of(), C.INDEX_UNSET, C.TIME_UNSET))
  }

  override fun onAddMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: List<MediaItem>,
  ): ListenableFuture<List<MediaItem>> {
    // Queue editing is not supported (the engine queue is the single source
    // of truth and COMMAND_CHANGE_MEDIA_ITEMS is not advertised), so resolve
    // with an empty list; the session's follow-up player.addMediaItems call
    // is a harmless no-op in the virtual player.
    return com.google.common.util.concurrent.Futures.immediateFuture(emptyList())
  }
}

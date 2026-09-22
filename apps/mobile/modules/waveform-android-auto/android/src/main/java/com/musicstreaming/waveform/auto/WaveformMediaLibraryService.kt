package com.musicstreaming.waveform.auto

import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.annotation.MainThread
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession

// Phase 24 — Android Auto (phone-projected) media service.
//
// Hosts the MediaLibrarySession over the virtual AutoPlayer (ADR-018).
// The service can be created by the car host before any React Native UI
// exists (cold start): the session is built over an idle player and the
// library callback answers locally with the signed-out gate until JS
// attaches and reports a signed-in session. No credentials, tokens, or
// audio URLs ever live in this process boundary — playback stays in the JS
// PlaybackEngine.

class WaveformMediaLibraryService :
  MediaLibraryService(),
  AutoBridge.ServiceHandle {

  private var session: MediaLibrarySession? = null
  private lateinit var player: AutoPlayer
  private lateinit var callback: WaveformLibraryCallback

  @Volatile
  private var created = false

  @Volatile
  private var signedIn = false

  override fun onCreate() {
    super.onCreate()
    player = AutoPlayer()
    callback = WaveformLibraryCallback(player, isSignedIn = { signedIn })
    session = MediaLibrarySession.Builder(this, player, callback).build()
    AutoBridge.registerService(this)
    created = true
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
    session

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Keep the service (and the session) alive when the car host's task is
    // removed: playback is owned by the JS engine and must not be torn
    // down by task dismissal.
  }

  override fun onDestroy() {
    created = false
    AutoBridge.registerService(null)
    session?.release()
    session = null
    super.onDestroy()
  }

  // ------------------------------------------------------------------ //
  // AutoBridge.ServiceHandle — JS resolutions and state pushes.          //
  // ------------------------------------------------------------------ //

  override fun isCreated(): Boolean = created

  @MainThread
  override fun setSignedIn(signedIn: Boolean) {
    // Called from the JS thread via the module; hop to the player thread
    // before touching the virtual player.
    runOnPlayerThread {
      this.signedIn = signedIn
      if (!signedIn) {
        // Sign-out: clear the car UI back to the gate. The JS controller
        // detaches first; this is the safety net.
        player.reset()
      }
    }
  }

  override fun resolveLibraryRoot(requestId: String, rootId: String) {
    val pending = AutoBridge.pending.remove(requestId) ?: return
    pending.invoke(mapOf("rootId" to rootId))
  }

  override fun resolveChildren(
    requestId: String,
    items: List<Map<String, Any?>>,
    ok: Boolean,
  ) {
    val pending = AutoBridge.pending.remove(requestId) ?: return
    pending.invoke(mapOf("ok" to ok, "items" to items))
  }

  override fun resolveItem(requestId: String, item: Map<String, Any?>?) {
    val pending = AutoBridge.pending.remove(requestId) ?: return
    pending.invoke(mapOf("item" to item))
  }

  override fun resolvePlay(requestId: String, ok: Boolean, title: String, message: String) {
    // Play requests are fire-and-forget from the native side: on success JS
    // pushes the new queue + state itself. On failure, surface the error on
    // the virtual player so the car host shows it.
    if (!ok) {
      val error =
        PlaybackException(
          message.ifBlank { title },
          /* cause= */ null,
          PlaybackException.ERROR_CODE_UNSPECIFIED)
      runOnPlayerThread {
        player.setProjectedState(Player.STATE_IDLE, player.currentPosition, error)
      }
    }
  }

  override fun resolveSearch(requestId: String, items: List<Map<String, Any?>>) {
    val pending = AutoBridge.pending.remove(requestId) ?: return
    pending.invoke(mapOf("items" to items))
  }

  override fun updatePlaybackState(payload: Map<String, Any?>) {
    runOnPlayerThread {
      val state =
        when (payload["state"] as? String) {
          "playing" -> Player.STATE_READY
          "paused" -> Player.STATE_READY
          "loading", "buffering" -> Player.STATE_BUFFERING
          "ended" -> Player.STATE_ENDED
          "error" -> Player.STATE_IDLE
          else -> Player.STATE_IDLE
        }
      val playWhenReady = (payload["state"] as? String) == "playing"
      val positionMs = (payload["positionMs"] as? Number)?.toLong() ?: 0L
      val errorMessage = payload["error"] as? String
      val error =
        if ((payload["state"] as? String) == "error" && !errorMessage.isNullOrBlank()) {
          PlaybackException(
            errorMessage, /* cause= */ null, PlaybackException.ERROR_CODE_UNSPECIFIED)
        } else {
          null
        }
      player.setProjectedPlayWhenReady(playWhenReady)
      player.setProjectedState(state, positionMs, error)
    }
  }

  override fun updateQueue(items: List<Map<String, Any?>>, activeIndex: Int) {
    runOnPlayerThread {
      val mediaItems =
        items.map { payload ->
          val mediaId = payload["mediaId"] as? String ?: ""
          val metadataBuilder =
            MediaMetadata.Builder()
              .setTitle(payload["title"] as? String ?: "")
              .setIsBrowsable(false)
              .setIsPlayable(true)
              .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
          (payload["subtitle"] as? String)?.let { metadataBuilder.setSubtitle(it) }
          (payload["artworkUrl"] as? String)?.takeIf { it.isNotBlank() }?.let {
            metadataBuilder.setArtworkUri(Uri.parse(it))
          }
          MediaItem.Builder().setMediaId(mediaId).setMediaMetadata(metadataBuilder.build()).build()
        }
      val durations =
        items.map { (it["durationMs"] as? Number)?.toLong() ?: C.TIME_UNSET }
      player.setProjectedQueue(mediaItems, durations, activeIndex)
    }
  }

  override fun updateRepeatShuffle(repeatMode: String, shuffle: Boolean) {
    runOnPlayerThread {
      val mode =
        when (repeatMode) {
          "one" -> Player.REPEAT_MODE_ONE
          "all" -> Player.REPEAT_MODE_ALL
          else -> Player.REPEAT_MODE_OFF
        }
      player.setProjectedRepeatShuffle(mode, shuffle)
    }
  }

  private fun runOnPlayerThread(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      android.os.Handler(Looper.getMainLooper()).post { block() }
    }
  }
}

package com.musicstreaming.waveform.auto

import android.util.Log
import androidx.annotation.MainThread
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// Phase 24 — bridge between the Android Auto media service and the Expo JS
// side. The native service raises events (browse requests, play taps,
// transport commands); the Expo module (WaveformAndroidAutoModule) forwards
// them to JS and JS resolves them asynchronously through the methods below.
//
// The JS side may not be running when the car connects (cold start), so
// sendEvent is a safe no-op until a sender is registered. Nothing here
// holds a strong reference to the service or the module, so neither can
// leak the other.

object AutoBridge {
  private const val TAG = "WaveformAuto"

  /** Implemented by WaveformAndroidAutoModule to reach JS. */
  interface EventSender {
    fun sendEvent(name: String, payload: Map<String, Any?>)
  }

  /** Implemented by WaveformMediaLibraryService to receive JS resolutions. */
  interface ServiceHandle {
    fun resolveLibraryRoot(requestId: String, rootId: String)
    fun resolveChildren(requestId: String, items: List<Map<String, Any?>>, ok: Boolean)
    fun resolveItem(requestId: String, item: Map<String, Any?>?)
    fun resolvePlay(requestId: String, ok: Boolean, title: String, message: String)
    fun resolveSearch(requestId: String, items: List<Map<String, Any?>>)
    fun updatePlaybackState(payload: Map<String, Any?>)
    fun updateQueue(items: List<Map<String, Any?>>, activeIndex: Int)
    fun updateRepeatShuffle(repeatMode: String, shuffle: Boolean)
    fun setSignedIn(signedIn: Boolean)
    fun isCreated(): Boolean
  }

  @Volatile
  private var sender: EventSender? = null

  @Volatile
  private var service: ServiceHandle? = null

  /** Pending JS resolution callbacks keyed by request id (timeout-guarded). */
  internal val pending: ConcurrentHashMap<String, (Map<String, Any?>?) -> Unit> =
    ConcurrentHashMap()

  @MainThread
  fun registerSender(s: EventSender?) {
    sender = s
    Log.d(TAG, "JS event sender ${if (s == null) "cleared" else "registered"}")
  }

  fun registerService(s: ServiceHandle?) {
    service = s
    Log.d(TAG, "Media service ${if (s == null) "cleared" else "registered"}")
  }

  fun isServiceCreated(): Boolean = service?.isCreated() == true

  /** Raise an event to JS. Safe no-op when JS is not attached (cold start). */
  fun sendEvent(name: String, payload: Map<String, Any?>) {
    val current = sender
    if (current == null) {
      Log.d(TAG, "sendEvent($name) dropped: JS not attached")
      return
    }
    current.sendEvent(name, payload)
  }

  /** Allocate a pending request slot; [onTimeout] runs when JS never answers. */
  fun <T> awaitResolution(timeoutMs: Long, onTimeout: () -> T): AwaitHandle<T> {
    val requestId = UUID.randomUUID().toString()
    return AwaitHandle(requestId, timeoutMs, onTimeout)
  }

  fun setSignedIn(signedIn: Boolean) {
    service?.setSignedIn(signedIn)
  }

  fun pushPlaybackState(payload: Map<String, Any?>) {
    service?.updatePlaybackState(payload)
  }

  fun pushQueue(items: List<Map<String, Any?>>, activeIndex: Int) {
    service?.updateQueue(items, activeIndex)
  }

  fun pushRepeatShuffle(repeatMode: String, shuffle: Boolean) {
    service?.updateRepeatShuffle(repeatMode, shuffle)
  }

  /** JS resolution entry points, delegated to the live service. */
  fun resolveLibraryRoot(requestId: String, rootId: String) {
    service?.resolveLibraryRoot(requestId, rootId)
  }

  fun resolveChildren(requestId: String, items: List<Map<String, Any?>>, ok: Boolean) {
    service?.resolveChildren(requestId, items, ok)
  }

  fun resolveItem(requestId: String, item: Map<String, Any?>?) {
    service?.resolveItem(requestId, item)
  }

  fun resolvePlay(requestId: String, ok: Boolean, title: String, message: String) {
    service?.resolvePlay(requestId, ok, title, message)
  }

  fun resolveSearch(requestId: String, items: List<Map<String, Any?>>) {
    service?.resolveSearch(requestId, items)
  }

  /**
   * A pending JS resolution. [complete] hands the payload to the parked
   * native callback exactly once; [fail] completes with the timeout
   * fallback. Only one of the two ever runs.
   */
  class AwaitHandle<T>(
    val requestId: String,
    private val timeoutMs: Long,
    private val onTimeout: () -> T,
  ) {
    private val completed = java.util.concurrent.atomic.AtomicBoolean(false)

    internal var callback: ((T) -> Unit)? = null

    fun armTimeout() {
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
        if (completed.compareAndSet(false, true)) {
          pending.remove(requestId)
          callback?.invoke(onTimeout())
        }
      }, timeoutMs)
    }

    fun complete(value: T) {
      if (completed.compareAndSet(false, true)) {
        pending.remove(requestId)
        callback?.invoke(value)
      }
    }
  }
}

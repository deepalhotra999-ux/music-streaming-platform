package com.musicstreaming.waveform.auto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Phase 24 — Expo module bridging the Android Auto media service to JS.
//
// The native service (WaveformMediaLibraryService) raises events through
// AutoBridge; this module forwards them to the JS Android Auto controller
// and exposes the resolution/state-projection functions the controller
// calls. All payloads are plain JSON maps — no Media3 types cross the
// bridge. Safe to call any time: with no service, resolutions are dropped
// and events never fire.

class WaveformAndroidAutoModule : Module() {

  override fun definition() =
    ModuleDefinition {
      Name("WaveformAndroidAuto")

      // Events raised by the media service (browse/play/transport), handled
      // by the JS AndroidAutoController. Must be declared for sendEvent to
      // reach JS.
      Events(
        "onLibraryRootRequest",
        "onChildrenRequest",
        "onItemRequest",
        "onPlayRequest",
        "onCommand",
        "onSearchRequest",
      )

      Function("isServiceAvailable") {
        AutoBridge.isServiceCreated()
      }

      Function("notifyAuthState") { signedIn: Boolean ->
        AutoBridge.setSignedIn(signedIn)
      }

      Function("resolveLibraryRoot") { requestId: String, rootId: String ->
        AutoBridge.resolveLibraryRoot(requestId, rootId)
      }

      Function("resolveChildren") { requestId: String, result: Map<String, Any?> ->
        val items =
          (result["items"] as? List<*>)?.filterIsInstance<Map<String, Any?>>() ?: emptyList()
        AutoBridge.resolveChildren(requestId, items, result["ok"] as? Boolean ?: false)
      }

      Function("resolveItem") { requestId: String, item: Map<String, Any?>? ->
        AutoBridge.resolveItem(requestId, item)
      }

      Function("resolvePlay") { requestId: String, result: Map<String, Any?> ->
        AutoBridge.resolvePlay(
          requestId,
          result["ok"] as? Boolean ?: false,
          result["title"] as? String ?: "Playback error",
          result["message"] as? String ?: "",
        )
      }

      Function("resolveSearch") { requestId: String, items: List<Map<String, Any?>> ->
        AutoBridge.resolveSearch(requestId, items)
      }

      Function("updatePlaybackState") { state: Map<String, Any?> ->
        AutoBridge.pushPlaybackState(state)
      }

      Function("updateQueue") { items: List<Map<String, Any?>>, activeIndex: Int ->
        AutoBridge.pushQueue(items, activeIndex)
      }

      Function("updateRepeatShuffle") { repeatMode: String, shuffle: Boolean ->
        AutoBridge.pushRepeatShuffle(repeatMode, shuffle)
      }

      OnCreate {
        // Capture the module's sendEvent before defining the listener so
        // the EventSender implementation cannot recurse into itself.
        val emit: (String, Map<String, Any?>) -> Unit = { name, payload ->
          sendEvent(name, payload)
        }
        AutoBridge.registerSender(
          object : AutoBridge.EventSender {
            override fun sendEvent(name: String, payload: Map<String, Any?>) {
              emit(name, payload)
            }
          }
        )
      }

      OnDestroy {
        AutoBridge.registerSender(null)
      }
    }
}

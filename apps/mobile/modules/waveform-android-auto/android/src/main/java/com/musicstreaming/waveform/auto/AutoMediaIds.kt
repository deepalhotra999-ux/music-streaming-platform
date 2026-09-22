package com.musicstreaming.waveform.auto

// Phase 24 — media id scheme for the Android Auto library tree.
//
// Mirrors apps/mobile/src/androidauto/identifiers.ts. The JS side builds
// ids; the native side only parses them. Ids are namespaced with the
// "waveform:" prefix so they can never collide with ids from another
// source, and the car host treats them as opaque strings.

object AutoMediaIds {
  const val PREFIX = "waveform:"

  const val ROOT = "waveform:root"
  const val HOME = "waveform:home"
  const val RECENT = "waveform:recent"
  const val LIKED = "waveform:liked"
  const val PLAYLISTS = "waveform:playlists"
  const val ARTISTS = "waveform:artists"
  const val ALBUMS = "waveform:albums"

  /** Browsable node ids that are not parameterized. */
  val STATIC_NODES: Set<String> = setOf(ROOT, HOME, RECENT, LIKED, PLAYLISTS, ARTISTS, ALBUMS)

  enum class Kind {
    TRACK,
    ALBUM,
    PLAYLIST,
    ARTIST,
    NODE,
    UNKNOWN,
  }

  data class Parsed(val kind: Kind, /** The catalog id, or the node key. */ val id: String)

  /**
   * Parse a media id advertised by this app. Returns UNKNOWN for anything
   * we did not mint — the caller must treat those as unplayable rather
   * than trusting them.
   */
  fun parse(mediaId: String?): Parsed {
    if (mediaId == null || !mediaId.startsWith(PREFIX)) {
      return Parsed(Kind.UNKNOWN, "")
    }
    if (mediaId in STATIC_NODES) {
      return Parsed(Kind.NODE, mediaId.removePrefix(PREFIX))
    }
    // Parameterized nodes: "waveform:album:<id>" etc. The catalog id is
    // everything after the second colon, so ids containing colons survive.
    val rest = mediaId.removePrefix(PREFIX)
    val colon = rest.indexOf(':')
    if (colon <= 0) {
      return Parsed(Kind.UNKNOWN, "")
    }
    val kind = rest.substring(0, colon)
    val id = rest.substring(colon + 1)
    if (id.isEmpty()) {
      return Parsed(Kind.UNKNOWN, "")
    }
    return when (kind) {
      "track" -> Parsed(Kind.TRACK, id)
      "album" -> Parsed(Kind.ALBUM, id)
      "playlist" -> Parsed(Kind.PLAYLIST, id)
      "artist" -> Parsed(Kind.ARTIST, id)
      else -> Parsed(Kind.UNKNOWN, "")
    }
  }

  /** True when the id addresses a playable track minted by this app. */
  fun isPlayableTrack(mediaId: String?): Boolean = parse(mediaId).kind == Kind.TRACK

  /** The catalog track id, or null when the media id is not our track. */
  fun trackIdOf(mediaId: String?): String? {
    val parsed = parse(mediaId)
    return if (parsed.kind == Kind.TRACK) parsed.id else null
  }
}

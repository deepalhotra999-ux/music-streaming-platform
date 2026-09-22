import Foundation

/// Pure bridge-id helpers shared by the coordinator. Kept free of any
/// CarPlay/UIKit dependency so they are unit-testable without a device.
///
/// Conventions (must match apps/mobile/src/carplay/):
///   track item id : "track:<trackId>"
///   node ids      : "home" | "library" | "artists" | "playlists" |
///                   "liked" | "history" | "myplaylists" | "followedArtists" |
///                   "album:<albumId>" | "playlist:<playlistId>" | "artist:<artistId>"
enum CarPlayIdentifiers {
  static func trackItemId(trackId: String) -> String {
    "track:\(trackId)"
  }

  static func trackId(fromItemId itemId: String) -> String? {
    let prefix = "track:"
    guard itemId.hasPrefix(prefix) else { return nil }
    let id = String(itemId.dropFirst(prefix.count))
    return id.isEmpty ? nil : id
  }

  static func albumNodeId(albumId: String) -> String { "album:\(albumId)" }
  static func playlistNodeId(playlistId: String) -> String { "playlist:\(playlistId)" }
  static func artistNodeId(artistId: String) -> String { "artist:\(artistId)" }

  /// Splits a node id into its base ("album") and parameter ("<albumId>").
  /// Parameterized nodes always have a non-empty parameter.
  static func splitNodeId(_ nodeId: String) -> (base: String, parameter: String?)? {
    if let colon = nodeId.firstIndex(of: ":") {
      let base = String(nodeId[..<colon])
      let parameter = String(nodeId[nodeId.index(after: colon)...])
      guard !base.isEmpty, !parameter.isEmpty else { return nil }
      return (base, parameter)
    }
    return nodeId.isEmpty ? nil : (nodeId, nil)
  }
}

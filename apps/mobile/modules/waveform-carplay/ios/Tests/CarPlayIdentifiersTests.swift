import XCTest

@testable import WaveformCarplay

/// Unit tests for the pure bridge-id helpers. These do not touch
/// CarPlay/UIKit, so they run on any Mac with Xcode.
///
/// NOTE (Phase 23): not executed in the sandbox — no macOS/Xcode here.
/// Run with: `xcodebuild test` on a Mac once the module is pod-installed.
/// See docs/PHASE-23-REPORT.md for the manual validation plan.
final class CarPlayIdentifiersTests: XCTestCase {
  func testTrackItemIdRoundTrip() {
    XCTAssertEqual(CarPlayIdentifiers.trackItemId(trackId: "abc123"), "track:abc123")
    XCTAssertEqual(CarPlayIdentifiers.trackId(fromItemId: "track:abc123"), "abc123")
  }

  func testTrackIdRejectsNonTrackItems() {
    XCTAssertNil(CarPlayIdentifiers.trackId(fromItemId: "node:liked"))
    XCTAssertNil(CarPlayIdentifiers.trackId(fromItemId: "track:"))
    XCTAssertNil(CarPlayIdentifiers.trackId(fromItemId: ""))
  }

  func testNodeIdBuilders() {
    XCTAssertEqual(CarPlayIdentifiers.albumNodeId(albumId: "a1"), "album:a1")
    XCTAssertEqual(CarPlayIdentifiers.playlistNodeId(playlistId: "p1"), "playlist:p1")
    XCTAssertEqual(CarPlayIdentifiers.artistNodeId(artistId: "r1"), "artist:r1")
  }

  func testSplitNodeId() {
    let split = CarPlayIdentifiers.splitNodeId("album:a1")
    XCTAssertEqual(split?.base, "album")
    XCTAssertEqual(split?.parameter, "a1")

    let plain = CarPlayIdentifiers.splitNodeId("home")
    XCTAssertEqual(plain?.base, "home")
    XCTAssertNil(plain?.parameter)

    XCTAssertNil(CarPlayIdentifiers.splitNodeId(""))
    XCTAssertNil(CarPlayIdentifiers.splitNodeId("album:"))
    XCTAssertNil(CarPlayIdentifiers.splitNodeId(":a1"))
  }
}

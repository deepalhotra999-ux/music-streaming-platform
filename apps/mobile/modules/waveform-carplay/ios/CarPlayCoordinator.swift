import CarPlay
import MediaPlayer
import UIKit

// MARK: - Bridge payload keys
//
// These keys mirror the JSON contract in
// modules/waveform-carplay/src/index.ts. Keep both sides in sync.

private enum Payload {
  static let requestId = "requestId"
  static let nodeId = "nodeId"
  static let itemId = "itemId"
  static let command = "command"
  static let id = "id"
  static let kind = "kind"
  static let title = "title"
  static let subtitle = "subtitle"
  static let target = "target"
  static let sections = "sections"
  static let items = "items"
  static let ok = "ok"
  static let message = "message"
}

/// A list row that carries its bridge item id so the coordinator can
/// toggle the now-playing indicator when the track changes.
private final class CarPlayBridgeItem: CPListItem {
  let bridgeId: String

  init(bridgeId: String, text: String, detailText: String?, accessoryType: CPListItemAccessoryType = .none) {
    self.bridgeId = bridgeId
    super.init(
      text: text,
      detailText: detailText,
      image: nil,
      accessoryImage: nil,
      accessoryType: accessoryType
    )
  }
}

private struct PendingRequest {
  let completion: () -> Void
  var timeout: DispatchWorkItem
}

// MARK: - Coordinator

/// Owns every CarPlay template and forwards all content/playback
/// decisions to JavaScript. Native code never calls the backend, never
/// plays audio, and never shows private data of its own accord: when no
/// signed-in session is known it shows only the sign-in gate.
///
/// Threading: every public entry point hops to the main queue before
/// touching CarPlay or MediaPlayer state.
public final class CarPlayCoordinator {
  public static let shared = CarPlayCoordinator()

  private init() {}

  private weak var module: WaveformCarplayModule?
  private var interfaceController: CPInterfaceController?
  private var pendingTabs: [[String: Any]]?
  private var tabsSet = false
  private var nowPlayingPushed = false
  private var signInGateTimer: DispatchWorkItem?
  /// (command, token) pairs so each token is removed from the command
  /// that created it.
  private var remoteCommandTokens: [(command: MPRemoteCommand, token: Any)] = []

  private var pendingBrowse: [String: PendingRequest] = [:]
  private var pendingPlay: [String: PendingRequest] = [:]

  private static let requestTimeout: TimeInterval = 15
  private static let signInGateGrace: TimeInterval = 5

  var isConnected: Bool { interfaceController != nil }

  // MARK: - Module lifecycle

  func attach(module: WaveformCarplayModule) {
    self.module = module
  }

  func detachModule() {
    runOnMain { self.module = nil }
  }

  // MARK: - Scene lifecycle

  func carPlayDidConnect(_ controller: CPInterfaceController) {
    runOnMain {
      self.interfaceController = controller
      self.tabsSet = false
      self.nowPlayingPushed = false
      self.registerRemoteCommands()

      // If JS already pushed tabs (app was ready before the car
      // connected), apply them now. Otherwise give JS a short grace
      // period — the app may still be restoring its session — and then
      // fall back to the sign-in gate rather than a blank UI.
      if let tabs = self.pendingTabs {
        self.applyTabs(tabs, on: controller)
      } else {
        let timer = DispatchWorkItem { [weak self] in
          guard let self, self.isConnected, !self.tabsSet else { return }
          self.showSignInGate()
        }
        self.signInGateTimer?.cancel()
        self.signInGateTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.signInGateGrace, execute: timer)
      }

      self.emit("onCarPlayConnect", [:])
    }
  }

  func carPlayDidDisconnect() {
    runOnMain {
      // Answer every outstanding JS request so no handler leaks.
      // Audio keeps playing on the phone — disconnecting the car must
      // never stop the user's session.
      self.failAllPending()
      self.unregisterRemoteCommands()
      self.interfaceController = nil
      self.pendingTabs = nil
      self.tabsSet = false
      self.nowPlayingPushed = false
      self.signInGateTimer?.cancel()
      self.signInGateTimer = nil
      self.emit("onCarPlayDisconnect", [:])
    }
  }

  // MARK: - Auth state

  func setSignedIn(_ signedIn: Bool) {
    runOnMain {
      self.signInGateTimer?.cancel()
      self.signInGateTimer = nil
      if !signedIn, self.isConnected {
        // JS signed out: replace any content with the safe gate.
        // This also discards the pending-tabs stash.
        self.pendingTabs = nil
        self.tabsSet = false
        self.nowPlayingPushed = false
        self.showSignInGate()
      }
    }
  }

  private func showSignInGate() {
    guard let controller = interfaceController else { return }
    let item = CarPlayBridgeItem(
      bridgeId: "message:signin",
      text: "Sign in to Waveform",
      detailText: "Your library appears here after you sign in on your iPhone."
    )
    let section = CPListSection(
      items: [item],
      header: nil,
      headerSubtitle: nil,
      headerImage: nil,
      sectionIndexTitle: nil
    )
    controller.setRootTemplate(
      CPListTemplate(title: "Waveform", sections: [section]),
      animated: false,
      completion: nil
    )
    tabsSet = false
  }

  // MARK: - Tabs

  func setTabs(_ tabs: [[String: Any]]) {
    runOnMain {
      self.pendingTabs = tabs
      guard let controller = self.interfaceController else { return }
      self.applyTabs(tabs, on: controller)
    }
  }

  private func applyTabs(_ tabs: [[String: Any]], on controller: CPInterfaceController) {
    var templates: [CPTemplate] = []
    for tab in tabs.prefix(5) {
      let title = tab[Payload.title] as? String ?? "Waveform"
      let sections = self.listSections(from: tab[Payload.sections] as? [[String: Any]] ?? [])
      let list = CPListTemplate(title: title, sections: sections)
      list.tabTitle = title
      list.tabImage = Self.tabImage(forNode: tab[Payload.nodeId] as? String)
      templates.append(list)
    }
    guard !templates.isEmpty else { return }
    controller.setRootTemplate(CPTabBarTemplate(templates: templates), animated: false, completion: nil)
    tabsSet = true
    signInGateTimer?.cancel()
    signInGateTimer = nil
  }

  private static func tabImage(forNode nodeId: String?) -> UIImage? {
    let symbol: String
    switch nodeId {
    case "home": symbol = "house"
    case "library": symbol = "books.vertical"
    case "artists": symbol = "music.mic"
    case "playlists": symbol = "music.note.list"
    default: symbol = "music.note"
    }
    return UIImage(systemName: symbol)
  }

  // MARK: - Browse requests

  private func beginBrowse(nodeId: String, completion: @escaping () -> Void) {
    let requestId = UUID().uuidString
    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.pendingBrowse.removeValue(forKey: requestId) != nil else { return }
      completion()
      self.showAlert(title: "Couldn't load", message: "Please try again.")
    }
    pendingBrowse[requestId] = PendingRequest(completion: completion, timeout: timeout)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.requestTimeout, execute: timeout)
    emit("onBrowseRequest", [Payload.requestId: requestId, Payload.nodeId: nodeId])
  }

  func resolveBrowse(requestId: String, result: [String: Any]) {
    runOnMain {
      guard let pending = self.pendingBrowse.removeValue(forKey: requestId) else { return }
      pending.timeout.cancel()
      defer { pending.completion() }
      guard let controller = self.interfaceController else { return }
      if result[Payload.ok] as? Bool ?? false {
        let title = result[Payload.title] as? String ?? "Waveform"
        let sections = self.listSections(from: result[Payload.sections] as? [[String: Any]] ?? [])
        controller.pushTemplate(CPListTemplate(title: title, sections: sections), animated: true, completion: nil)
      } else {
        self.presentAlert(
          on: controller,
          title: result[Payload.title] as? String ?? "Couldn't load",
          message: result[Payload.message] as? String ?? "Please try again."
        )
      }
    }
  }

  // MARK: - Play requests

  private func beginPlay(itemId: String, nodeId: String, completion: @escaping () -> Void) {
    let requestId = UUID().uuidString
    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.pendingPlay.removeValue(forKey: requestId) != nil else { return }
      completion()
      self.showAlert(title: "Couldn't play", message: "Please try again.")
    }
    pendingPlay[requestId] = PendingRequest(completion: completion, timeout: timeout)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.requestTimeout, execute: timeout)
    emit("onPlayRequest", [
      Payload.requestId: requestId,
      Payload.itemId: itemId,
      Payload.nodeId: nodeId,
    ])
  }

  func resolvePlay(requestId: String, result: [String: Any]) {
    runOnMain {
      guard let pending = self.pendingPlay.removeValue(forKey: requestId) else { return }
      pending.timeout.cancel()
      defer { pending.completion() }
      guard let controller = self.interfaceController else { return }
      if result[Payload.ok] as? Bool ?? false {
        if !self.nowPlayingPushed {
          self.nowPlayingPushed = true
          controller.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
        }
      } else {
        self.presentAlert(
          on: controller,
          title: result[Payload.title] as? String ?? "Couldn't play",
          message: result[Payload.message] as? String ?? "Please try again."
        )
      }
    }
  }

  // MARK: - Now playing indicator

  func updatePlayingItem(itemId: String?) {
    runOnMain {
      guard let controller = self.interfaceController else { return }
      for template in controller.templates {
        guard let list = template as? CPListTemplate else { continue }
        for section in list.sections {
          for case let item as CarPlayBridgeItem in section.items {
            item.isPlaying = (itemId != nil && item.bridgeId == itemId)
          }
        }
      }
    }
  }

  // MARK: - Alerts

  func showAlert(title: String, message: String) {
    runOnMain {
      guard let controller = self.interfaceController else { return }
      self.presentAlert(on: controller, title: title, message: message)
    }
  }

  private func presentAlert(on controller: CPInterfaceController, title: String, message: String) {
    let dismiss = CPAlertAction(title: "Dismiss", style: .cancel) { [weak controller] _ in
      controller?.dismissTemplate(animated: true, completion: nil)
    }
    controller.presentTemplate(
      CPAlertTemplate(titleVariants: [title], messageVariants: [message], actions: [dismiss]),
      animated: true,
      completion: nil
    )
  }

  // MARK: - Payload -> templates

  private func listSections(from payload: [[String: Any]]) -> [CPListSection] {
    payload.map { section in
      let items = (section[Payload.items] as? [[String: Any]] ?? []).compactMap { self.makeItem($0) }
      return CPListSection(
        items: items,
        header: section[Payload.title] as? String,
        headerSubtitle: nil,
        headerImage: nil,
        sectionIndexTitle: nil
      )
    }
  }

  private func makeItem(_ payload: [String: Any]) -> CPListItem? {
    guard let bridgeId = payload[Payload.id] as? String,
      let kind = payload[Payload.kind] as? String,
      let title = payload[Payload.title] as? String
    else { return nil }

    let detailText = payload[Payload.subtitle] as? String
    let target = payload[Payload.target] as? String

    switch kind {
    case "container":
      let item = CarPlayBridgeItem(
        bridgeId: bridgeId, text: title, detailText: detailText, accessoryType: .disclosureIndicator)
      if let nodeId = target {
        item.handler = { [weak self] _, completion in
          self?.beginBrowse(nodeId: nodeId, completion: completion)
        }
      }
      return item
    case "track":
      let item = CarPlayBridgeItem(bridgeId: bridgeId, text: title, detailText: detailText)
      if let nodeId = target {
        item.handler = { [weak self] _, completion in
          self?.beginPlay(itemId: bridgeId, nodeId: nodeId, completion: completion)
        }
      }
      return item
    case "action":
      let item = CarPlayBridgeItem(bridgeId: bridgeId, text: title, detailText: detailText)
      if let command = target {
        item.handler = { [weak self] _, completion in
          self?.emit("onCommand", [Payload.command: command])
          completion()
        }
      }
      return item
    default:
      // "message" — informational rows are not selectable.
      return CarPlayBridgeItem(bridgeId: bridgeId, text: title, detailText: detailText)
    }
  }

  // MARK: - Remote commands (Phase 23 addition)

  /// Adds next/previous handlers ONLY while CarPlay is connected.
  /// Play/pause/seek keep flowing through the Phase 10 path; expo-audio
  /// still owns MPNowPlayingInfoCenter, which stays the single
  /// Now Playing source for both the phone and the car.
  private func registerRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    let nextToken = center.nextTrackCommand.addTarget { [weak self] _ in
      self?.emit("onCommand", [Payload.command: "next"])
      return .success
    }
    let previousToken = center.previousTrackCommand.addTarget { [weak self] _ in
      self?.emit("onCommand", [Payload.command: "previous"])
      return .success
    }
    remoteCommandTokens = [
      (center.nextTrackCommand, nextToken),
      (center.previousTrackCommand, previousToken),
    ]
    center.nextTrackCommand.isEnabled = true
    center.previousTrackCommand.isEnabled = true
  }

  private func unregisterRemoteCommands() {
    for (command, token) in remoteCommandTokens {
      command.removeTarget(token)
    }
    remoteCommandTokens = []
  }

  // MARK: - Helpers

  private func failAllPending() {
    for (_, pending) in pendingBrowse {
      pending.timeout.cancel()
      pending.completion()
    }
    pendingBrowse.removeAll()
    for (_, pending) in pendingPlay {
      pending.timeout.cancel()
      pending.completion()
    }
    pendingPlay.removeAll()
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    module?.sendEvent(name, body)
  }

  private func runOnMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.async(execute: work)
    }
  }
}

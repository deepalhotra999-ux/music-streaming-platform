import CarPlay
import UIKit

/// CarPlay scene delegate, instantiated by UIKit from the scene manifest
/// injected by app.plugin.js (CPTemplateApplicationSceneSessionRoleApplication).
///
/// Deliberately stateless: scene lifecycle is forwarded to
/// CarPlayCoordinator, which owns every template and asks JavaScript for
/// content. This file contains no content, playback, or auth logic.
@objc(WaveformCarplaySceneDelegate)
public class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    CarPlayCoordinator.shared.carPlayDidConnect(interfaceController)
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    CarPlayCoordinator.shared.carPlayDidDisconnect()
  }
}

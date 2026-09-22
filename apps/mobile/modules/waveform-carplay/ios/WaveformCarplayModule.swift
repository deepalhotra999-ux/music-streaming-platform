import ExpoModulesCore

public class WaveformCarplayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WaveformCarplay")

    Events(
      "onCarPlayConnect",
      "onCarPlayDisconnect",
      "onBrowseRequest",
      "onPlayRequest",
      "onCommand"
    )

    Function("isCarPlayConnected") { () -> Bool in
      CarPlayCoordinator.shared.isConnected
    }

    Function("notifyAuthState") { (signedIn: Bool) in
      CarPlayCoordinator.shared.setSignedIn(signedIn)
    }

    Function("setTabs") { (tabs: [[String: Any]]) in
      CarPlayCoordinator.shared.setTabs(tabs)
    }

    Function("resolveBrowse") { (requestId: String, result: [String: Any]) in
      CarPlayCoordinator.shared.resolveBrowse(requestId: requestId, result: result)
    }

    Function("resolvePlay") { (requestId: String, result: [String: Any]) in
      CarPlayCoordinator.shared.resolvePlay(requestId: requestId, result: result)
    }

    Function("updatePlayingItem") { (itemId: String?) in
      CarPlayCoordinator.shared.updatePlayingItem(itemId: itemId)
    }

    Function("showAlert") { (title: String, message: String) in
      CarPlayCoordinator.shared.showAlert(title: title, message: message)
    }

    OnCreate {
      CarPlayCoordinator.shared.attach(module: self)
    }

    OnDestroy {
      CarPlayCoordinator.shared.detachModule()
    }
  }
}

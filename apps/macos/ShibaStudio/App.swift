import AppKit
import SwiftUI

@main
struct ShibaStudioApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var desktop = DesktopApp.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(desktop)
        }
        .defaultSize(width: 1280, height: 840)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") {
                    Task { await desktop.checkForUpdates(manual: true) }
                }
            }
            CommandMenu("View") {
                Button("Reload") {
                    desktop.reload()
                }
                .keyboardShortcut("r", modifiers: [.command])
                Button("Companion") {
                    desktop.openCompanion()
                }
            }
            CommandGroup(replacing: .help) {
                Button("Packages page") {
                    NSWorkspace.shared.open(AppIdentity.packagesPage)
                }
                Button("About Shiba Studio") {
                    desktop.showAbout()
                }
            }
        }

        Settings {
            PreferencesView()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
    }

    func applicationWillTerminate(_ notification: Notification) {
        DesktopApp.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@MainActor
final class DesktopApp: ObservableObject {
    static let shared = DesktopApp()

    enum Phase {
        case starting
        case ready
        case updating
        case failed
    }

    @Published var phase: Phase = .starting
    @Published var message = "Starting…"
    @Published var url: URL?
    @Published var pageTitle = AppIdentity.productName
    @Published var reloadNonce = 0

    private let host = StudioHost()
    private let updater = AppUpdater()
    private var started = false
    private var updateInFlight = false

    func start() async {
        guard !started else { return }
        started = true
        phase = .starting
        message = "Starting Shiba Studio…"
        do {
            let origin = try await host.start()
            url = origin
            phase = .ready
            await checkForUpdates(manual: false)
        } catch {
            phase = .failed
            message = error.localizedDescription
        }
    }

    func stop() {
        host.stop()
    }

    func reload() {
        reloadNonce += 1
    }

    func openCompanion() {
        guard let origin = host.origin else { return }
        url = origin.appendingPathComponent("companion")
    }

    func showAbout() {
        let sha = AppIdentity.shortSHA()
        let stamp = AppIdentity.readStamp()
        let alert = NSAlert()
        alert.messageText = AppIdentity.productName
        alert.informativeText = """
        Channel: \(AppIdentity.resolvedChannel())
        Revision: \(sha.isEmpty ? "local" : sha)
        \(stamp.builtAt ?? "")

        \(AppIdentity.packagesPage.absoluteString)
        """
        alert.alertStyle = .informational
        alert.runModal()
    }

    func checkForUpdates(manual: Bool) async {
        if updateInFlight { return }
        updateInFlight = true
        defer { updateInFlight = false }
        do {
            guard let offer = try await updater.check() else {
                if manual {
                    let alert = NSAlert()
                    alert.messageText = AppIdentity.productName
                    alert.informativeText = "You're on the latest build for this channel."
                    alert.runModal()
                }
                return
            }
            let prefs = AppIdentity.readPrefs()
            if !manual && !prefs.autoUpdate { return }
            if manual && !prefs.autoUpdate {
                let alert = NSAlert()
                alert.messageText = AppIdentity.productName
                alert.informativeText = "A newer \(offer.channel) build is available (\(String(offer.sha.prefix(7)))). Update now?"
                alert.addButton(withTitle: "Update")
                alert.addButton(withTitle: "Later")
                if alert.runModal() != .alertFirstButtonReturn { return }
            }
            phase = .updating
            message = "Updating Shiba Studio…"
            try await updater.downloadAndApply(offer) { text in
                Task { @MainActor in
                    DesktopApp.shared.message = text
                }
            }
            NSApp.terminate(nil)
        } catch {
            if manual {
                let alert = NSAlert()
                alert.messageText = AppIdentity.productName
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
            if phase != .ready {
                phase = .failed
                message = error.localizedDescription
            }
        }
    }
}

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
                Button("Hide to menu bar") {
                    desktop.hideToMenuBar()
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
    static weak var shared: AppDelegate?
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        NSApp.appearance = NSAppearance(named: .darkAqua)
        refreshStatusItem()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        Task { await DesktopApp.shared.checkForUpdates(manual: false) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            DesktopApp.shared.showMainWindow()
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        DesktopApp.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !AppIdentity.readPrefs().keepInMenuBar
    }

    func refreshStatusItem() {
        if !AppIdentity.readPrefs().keepInMenuBar {
            if let item = statusItem {
                NSStatusBar.system.removeStatusItem(item)
                statusItem = nil
            }
            return
        }
        if statusItem != nil { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let image = NSApp.applicationIconImage?.copy() as? NSImage {
            image.size = NSSize(width: 18, height: 18)
            item.button?.image = image
        } else {
            item.button?.title = "S"
        }
        item.button?.toolTip = AppIdentity.productName
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Shiba Studio", action: #selector(openFromStatusItem), keyEquivalent: "")
        menu.addItem(withTitle: "Hide to menu bar", action: #selector(hideFromStatusItem), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Shiba Studio", action: #selector(quitFromStatusItem), keyEquivalent: "q")
        for entry in menu.items {
            entry.target = self
        }
        item.menu = menu
        statusItem = item
    }

    @objc private func openFromStatusItem() {
        DesktopApp.shared.showMainWindow()
    }

    @objc private func hideFromStatusItem() {
        DesktopApp.shared.hideToMenuBar()
    }

    @objc private func quitFromStatusItem() {
        NSApp.terminate(nil)
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
    private var lastUpdateCheck = Date.distantPast
    private var updateTimer: Timer?

    func start() async {
        guard !started else { return }
        started = true
        phase = .starting
        message = "Starting Shiba Studio…"
        do {
            let origin = try await host.start()
            url = origin
            phase = .ready
            updateTimer?.invalidate()
            updateTimer = Timer.scheduledTimer(withTimeInterval: 30 * 60, repeats: true) { _ in
                Task { @MainActor in
                    await DesktopApp.shared.checkForUpdates(manual: false)
                }
            }
            await checkForUpdates(manual: false)
        } catch {
            phase = .failed
            message = error.localizedDescription
        }
    }

    func stop() {
        updateTimer?.invalidate()
        updateTimer = nil
        host.stop()
    }

    func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
            return
        }
        NSApp.windows.first?.makeKeyAndOrderFront(nil)
    }

    func hideToMenuBar() {
        guard AppIdentity.readPrefs().keepInMenuBar else { return }
        refreshStatusItem()
        for window in NSApp.windows where window.isVisible {
            window.orderOut(nil)
        }
    }

    func refreshStatusItem() {
        AppDelegate.shared?.refreshStatusItem()
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
        if !manual && Date().timeIntervalSince(lastUpdateCheck) < 5 * 60 { return }
        if updateInFlight { return }
        updateInFlight = true
        lastUpdateCheck = Date()
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

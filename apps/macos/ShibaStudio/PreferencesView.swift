import SwiftUI

struct PreferencesView: View {
    @State private var channel: String = AppIdentity.resolvedChannel()
    @State private var autoUpdate: Bool = AppIdentity.readPrefs().autoUpdate
    @State private var keepInMenuBar: Bool = AppIdentity.readPrefs().keepInMenuBar

    var body: some View {
        Form {
            Picker("Update channel", selection: $channel) {
                Text("Stable (main)").tag("main")
                Text("Development").tag("development")
            }
            Toggle("Install updates automatically", isOn: $autoUpdate)
            Toggle("Keep in the menu bar when the window is closed", isOn: $keepInMenuBar)
            Text("This app stays on the channel you downloaded and updates when that branch moves.")
                .foregroundStyle(.secondary)
                .font(.callout)
        }
        .padding(20)
        .frame(width: 420, height: 220)
        .onChange(of: channel) { _, value in
            persist(channel: value, autoUpdate: autoUpdate, keepInMenuBar: keepInMenuBar)
            Task { await DesktopApp.shared.checkForUpdates(manual: false) }
        }
        .onChange(of: autoUpdate) { _, value in persist(channel: channel, autoUpdate: value, keepInMenuBar: keepInMenuBar) }
        .onChange(of: keepInMenuBar) { _, value in
            persist(channel: channel, autoUpdate: autoUpdate, keepInMenuBar: value)
            DesktopApp.shared.refreshStatusItem()
        }
    }

    private func persist(channel: String, autoUpdate: Bool, keepInMenuBar: Bool) {
        AppIdentity.writePrefs(AppIdentity.Prefs(channel: channel, autoUpdate: autoUpdate, keepInMenuBar: keepInMenuBar))
    }
}

import SwiftUI

struct PreferencesView: View {
    @State private var channel: String = AppIdentity.resolvedChannel()
    @State private var autoUpdate: Bool = AppIdentity.readPrefs().autoUpdate

    var body: some View {
        Form {
            Picker("Update channel", selection: $channel) {
                Text("Stable (main)").tag("main")
                Text("Development").tag("development")
            }
            Toggle("Install updates automatically", isOn: $autoUpdate)
            Text("This app stays on the channel you downloaded and updates when that branch moves.")
                .foregroundStyle(.secondary)
                .font(.callout)
        }
        .padding(20)
        .frame(width: 420, height: 180)
        .onChange(of: channel) { _, value in
            persist(channel: value, autoUpdate: autoUpdate)
            Task { await DesktopApp.shared.checkForUpdates(manual: false) }
        }
        .onChange(of: autoUpdate) { _, value in persist(channel: channel, autoUpdate: value) }
    }

    private func persist(channel: String, autoUpdate: Bool) {
        AppIdentity.writePrefs(AppIdentity.Prefs(channel: channel, autoUpdate: autoUpdate))
    }
}

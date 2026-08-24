import SwiftUI

struct ContentView: View {
    @State private var origin: String = StudioHost.defaultOrigin
    @State private var currentURL: URL?
    @State private var status: String = "Connecting…"
    @State private var starting = false
    private let host = StudioHost()

    var body: some View {
        VStack(spacing: 0) {
            chrome
            Divider()
            StudioWebView(url: currentURL)
            Divider()
            Text(status)
                .font(.system(size: 12))
                .foregroundStyle(Color(red: 0.64, green: 0.64, blue: 0.64))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color(red: 0.07, green: 0.07, blue: 0.07))
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
        .onAppear {
            status = StudioHost.findStudioRoot().map { "Ready · checkout \($0.path)" }
                ?? "Ready · connect a running Studio or set SHIBA_STUDIO_ROOT"
            openStudio(companion: false)
        }
        .onDisappear {
            host.stop()
        }
    }

    private var chrome: some View {
        HStack(spacing: 8) {
            TextField("http://127.0.0.1:3000", text: $origin)
                .textFieldStyle(.plain)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(Color.black)
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Color(white: 0.25), lineWidth: 1)
                )
                .onSubmit { openStudio(companion: false) }
            Button("Open") { openStudio(companion: false) }
            Button("Start local Studio") { startStudio() }
                .disabled(starting)
            Button("Companion") { openStudio(companion: true) }
        }
        .padding(12)
        .background(Color(red: 0.07, green: 0.07, blue: 0.07))
    }

    private func openStudio(companion: Bool) {
        guard let normalized = Self.normalizedOrigin(origin) else {
            status = "Enter an http(s) Studio origin such as http://127.0.0.1:3000"
            return
        }
        origin = normalized
        guard let base = URL(string: normalized) else { return }
        let url = companion ? base.appendingPathComponent("companion") : base
        status = "Opening \(url.absoluteString)"
        currentURL = url
    }

    private func startStudio() {
        guard let normalized = Self.normalizedOrigin(origin) else {
            status = "Enter an http(s) Studio origin such as http://127.0.0.1:3000"
            return
        }
        origin = normalized
        starting = true
        status = "Starting local Studio…"
        Task {
            do {
                let result = try await host.start(origin: normalized)
                await MainActor.run {
                    status = result
                    starting = false
                    openStudio(companion: false)
                }
            } catch {
                await MainActor.run {
                    status = error.localizedDescription
                    starting = false
                }
            }
        }
    }

    static func normalizedOrigin(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { text = StudioHost.defaultOrigin }
        if !text.contains("://") { text = "http://\(text)" }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil
        else { return nil }
        var parts = URLComponents()
        parts.scheme = url.scheme
        parts.host = url.host
        parts.port = url.port
        return parts.string
    }
}

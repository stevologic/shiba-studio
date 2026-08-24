import SwiftUI

struct ContentView: View {
    @AppStorage("studioOrigin") private var origin: String = "http://shiba.local:3000"
    @State private var draftOrigin: String = ""
    @State private var connected = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            if connected {
                StudioWebView(origin: normalizedOrigin(origin), path: "/companion")
                    .ignoresSafeArea()
                    .navigationTitle("Shiba Studio")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Disconnect") {
                                connected = false
                            }
                        }
                    }
            } else {
                pairingForm
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            if draftOrigin.isEmpty {
                draftOrigin = origin
            }
        }
    }

    private var pairingForm: some View {
        Form {
            Section {
                Text("This is the official iOS companion. Pair it with a Studio host that has remote Companion access enabled — the full Node server cannot run on iOS.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Studio origin") {
                TextField("http://shiba.local:3000", text: $draftOrigin)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
            }
            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }
            Section {
                Button("Open companion") {
                    guard let normalized = normalizedOrigin(draftOrigin) else {
                        errorMessage = "Enter an http(s) origin such as http://shiba.local:3000"
                        return
                    }
                    errorMessage = nil
                    origin = normalized
                    connected = true
                }
            }
        }
        .navigationTitle("Shiba Studio")
    }

    private func normalizedOrigin(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if !text.contains("://") {
            text = "http://\(text)"
        }
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

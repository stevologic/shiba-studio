import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var app: DesktopApp

    var body: some View {
        ZStack {
            StudioWebView(app: app)
                .opacity(app.phase == .ready ? 1 : 0)
            if app.phase != .ready {
                splash
            }
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
        .frame(minWidth: 960, minHeight: 640)
        .onAppear {
            Task { await app.start() }
        }
        .onChange(of: app.pageTitle) { _, title in
            NSApp.keyWindow?.title = title
        }
    }

    private var splash: some View {
        VStack(spacing: 10) {
            Text(AppIdentity.productName)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(Color(red: 0.96, green: 0.96, blue: 0.96))
            Text(app.message)
                .font(.system(size: 14))
                .foregroundStyle(Color(red: 0.64, green: 0.64, blue: 0.64))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.04, green: 0.04, blue: 0.04))
    }
}

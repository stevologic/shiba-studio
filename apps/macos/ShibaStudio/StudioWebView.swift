import AppKit
import SwiftUI
import WebKit

struct StudioWebView: NSViewRepresentable {
    @ObservedObject var app: DesktopApp

    func makeCoordinator() -> Coordinator {
        Coordinator(app: app)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) {
            view.underPageBackgroundColor = .black
        }
        context.coordinator.webView = view
        return view
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.app = app
        if app.reloadNonce != context.coordinator.lastReloadNonce {
            context.coordinator.lastReloadNonce = app.reloadNonce
            webView.reload()
            return
        }
        guard let url = app.url else { return }
        if webView.url?.absoluteString == url.absoluteString { return }
        webView.load(URLRequest(url: url))
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var app: DesktopApp
        weak var webView: WKWebView?
        var lastReloadNonce = 0

        init(app: DesktopApp) {
            self.app = app
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            let title = webView.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            Task { @MainActor in
                self.app.pageTitle = title.isEmpty ? AppIdentity.productName : title
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("ShibaStudio navigation failed: %@", error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("ShibaStudio provisional navigation failed: %@", error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url, let host = url.host?.lowercased() else {
                decisionHandler(.allow)
                return
            }
            if host == "127.0.0.1" || host == "localhost" || host == "::1" {
                decisionHandler(.allow)
                return
            }
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }

        @available(macOS 12.0, *)
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            if origin.host == "127.0.0.1" || origin.host == "localhost" {
                decisionHandler(.grant)
            } else {
                decisionHandler(.deny)
            }
        }
    }
}

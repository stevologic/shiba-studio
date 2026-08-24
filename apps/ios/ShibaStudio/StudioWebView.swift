import SwiftUI
import WebKit

struct StudioWebView: UIViewRepresentable {
    let origin: String?
    let path: String

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        return view
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let origin, let base = URL(string: origin) else { return }
        let target = base.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        if webView.url?.absoluteString == target.absoluteString {
            return
        }
        webView.load(URLRequest(url: target))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("ShibaStudio navigation failed: %@", error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("ShibaStudio provisional navigation failed: %@", error.localizedDescription)
        }
    }
}

import Foundation

/// Locates a Shiba Studio checkout and optionally starts `npm run start`.
/// The macOS app is a host, not a second copy of the Node server.
final class StudioHost: @unchecked Sendable {
    static let defaultOrigin = "http://127.0.0.1:3000"
    static let healthPath = "/api/health"

    private var process: Process?
    private var ended = false

    deinit {
        stop()
    }

    static func findStudioRoot() -> URL? {
        if let fromEnv = ProcessInfo.processInfo.environment["SHIBA_STUDIO_ROOT"], isStudioRoot(URL(fileURLWithPath: fromEnv)) {
            return URL(fileURLWithPath: fromEnv).standardizedFileURL
        }
        if let configured = readConfiguredRoot(), isStudioRoot(configured) {
            return configured.standardizedFileURL
        }

        let bundleDir = Bundle.main.bundleURL.deletingLastPathComponent()
        let candidates: [URL] = [
            bundleDir,
            bundleDir.deletingLastPathComponent().deletingLastPathComponent(),
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/ShibaStudio/checkout"),
        ]
        return candidates.first { isStudioRoot($0) }
    }

    static func isStudioRoot(_ url: URL?) -> Bool {
        guard let url else { return false }
        let packageJson = url.appendingPathComponent("package.json")
        guard FileManager.default.fileExists(atPath: packageJson.path) else { return false }
        guard let data = try? Data(contentsOf: packageJson),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = object["name"] as? String
        else { return false }
        return name == "shiba-studio"
    }

    static func findNpm() -> URL? {
        var directories: [String] = []
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            directories.append(contentsOf: path.split(separator: ":").map(String.init))
        }
        directories.append(contentsOf: [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
        ])
        let nvmRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".nvm/versions/node")
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot.path) {
            for version in versions.sorted() {
                directories.append(nvmRoot.appendingPathComponent(version).appendingPathComponent("bin").path)
            }
        }
        for directory in directories {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent("npm")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    static func isHealthy(_ origin: String) async -> Bool {
        guard let url = URL(string: origin + healthPath) else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    func start(origin: String) async throws -> String {
        if await Self.isHealthy(origin) {
            return "Already running"
        }
        guard let root = Self.findStudioRoot() else {
            throw HostError.missingCheckout
        }
        guard let npm = Self.findNpm() else {
            throw HostError.missingNpm
        }

        let process = Process()
        process.executableURL = npm
        process.arguments = ["run", "start"]
        process.currentDirectoryURL = root
        var environment = ProcessInfo.processInfo.environment
        environment["HOST"] = "127.0.0.1"
        let npmDir = npm.deletingLastPathComponent().path
        let path = environment["PATH"] ?? ""
        environment["PATH"] = "\(npmDir):\(path)"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        self.process = process

        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline {
            if !process.isRunning {
                throw HostError.exited(process.terminationStatus)
            }
            if await Self.isHealthy(origin) {
                return "Started from \(root.path)"
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        throw HostError.timeout
    }

    func stop() {
        guard !ended else { return }
        ended = true
        if let process, process.isRunning {
            process.terminate()
        }
        process = nil
    }

    enum HostError: LocalizedError {
        case missingCheckout
        case missingNpm
        case exited(Int32)
        case timeout

        var errorDescription: String? {
            switch self {
            case .missingCheckout:
                return "No Shiba Studio checkout found. Clone the repo, set SHIBA_STUDIO_ROOT, or connect to a Studio that is already running."
            case .missingNpm:
                return "npm was not found. Install Node.js 22.5 or later (Homebrew or nvm is fine)."
            case .exited(let code):
                return "Studio host exited with code \(code)."
            case .timeout:
                return "Studio started but /api/health did not become ready in 90s."
            }
        }
    }

    private static func readConfiguredRoot() -> URL? {
        let file = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ShibaStudio/host.json")
        guard FileManager.default.fileExists(atPath: file.path),
              let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let root = object["studioRoot"] as? String
        else { return nil }
        return URL(fileURLWithPath: root)
    }
}

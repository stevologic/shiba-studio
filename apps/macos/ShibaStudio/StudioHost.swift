import Darwin
import Foundation

/// Starts the bundled Studio production server (`next start`) on loopback.
final class StudioHost: @unchecked Sendable {
    static let healthPath = "/api/health"

    private var process: Process?
    private var ended = false
    private(set) var origin: URL?

    deinit {
        stop()
    }

    static func isHealthy(_ origin: URL) async -> Bool {
        guard let url = URL(string: healthPath, relativeTo: origin) else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    func start() async throws -> URL {
        guard AppIdentity.isBundledRuntime() else {
            throw HostError.missingRuntime
        }
        let port = try Self.reservePort(AppIdentity.preferredPort)
        guard let origin = URL(string: "http://127.0.0.1:\(port)") else {
            throw HostError.invalidOrigin
        }
        if await Self.isHealthy(origin) {
            self.origin = origin
            return origin
        }

        AppIdentity.ensureUserFolders()
        try FileManager.default.createDirectory(at: AppIdentity.logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: AppIdentity.logFile.path) {
            FileManager.default.createFile(atPath: AppIdentity.logFile.path, contents: nil)
        }
        let log = try FileHandle(forWritingTo: AppIdentity.logFile)
        try log.seekToEnd()

        let stamp = AppIdentity.readStamp()
        let process = Process()
        process.executableURL = AppIdentity.nodeBinary
        process.arguments = [AppIdentity.nextCLI.path, "start", "-H", "127.0.0.1", "--port", String(port)]
        process.currentDirectoryURL = AppIdentity.runtimeDirectory
        var environment = ProcessInfo.processInfo.environment
        environment["HOST"] = "127.0.0.1"
        environment["PORT"] = String(port)
        environment["NODE_ENV"] = "production"
        environment["SHIBA_PROJECT_ROOT"] = AppIdentity.runtimeDirectory.path
        environment["SHIBA_DATA_DIR"] = AppIdentity.dataDirectory.path
        environment["SHIBA_SECRET_KEY_FILE"] = AppIdentity.dataDirectory.appendingPathComponent("shiba-studio.key").path
        environment["SHIBA_GIT_COMMIT"] = stamp.sha ?? ""
        environment["TERMINAL_WS_PORT"] = String(port + 1)
        environment["TERMINAL_WS_HOST"] = "127.0.0.1"
        environment["PUPPETEER_SKIP_DOWNLOAD"] = "1"
        environment["NEXT_TELEMETRY_DISABLED"] = "1"
        let nodeDir = AppIdentity.nodeBinary.deletingLastPathComponent().path
        environment["PATH"] = "\(nodeDir):\(environment["PATH"] ?? "/usr/bin:/bin")"
        process.environment = environment
        process.standardOutput = log
        process.standardError = log
        try process.run()
        self.process = process

        do {
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline {
                if !process.isRunning {
                    throw HostError.exited(process.terminationStatus)
                }
                if await Self.isHealthy(origin) {
                    self.origin = origin
                    return origin
                }
                try await Task.sleep(nanoseconds: 400_000_000)
            }
            throw HostError.timeout
        } catch {
            if process.isRunning { process.terminate() }
            throw error
        }
    }

    func stop() {
        guard !ended else { return }
        ended = true
        if let process, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(3)
            while process.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if process.isRunning {
                process.terminate()
            }
        }
        process = nil
    }

    enum HostError: LocalizedError {
        case missingRuntime
        case invalidOrigin
        case exited(Int32)
        case timeout
        case noPort

        var errorDescription: String? {
            switch self {
            case .missingRuntime:
                return "This copy of Shiba Studio is missing its bundled runtime. Download a packages build from https://shiba-studio.io/packages.html"
            case .invalidOrigin:
                return "Could not build a loopback origin for Studio."
            case .exited(let code):
                return "Studio exited with code \(code). See \(AppIdentity.logFile.path)"
            case .timeout:
                return "Studio started but /api/health did not become ready. See \(AppIdentity.logFile.path)"
            case .noPort:
                return "No free loopback port was found for Shiba Studio."
            }
        }
    }

    private static func reservePort(_ preferred: Int) throws -> Int {
        for port in preferred ..< (preferred + 16) {
            if isPortFree(port) { return port }
        }
        throw HostError.noPort
    }

    private static func isPortFree(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = __uint8_t(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let result = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }
}

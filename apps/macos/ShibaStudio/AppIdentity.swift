import Foundation

enum AppIdentity {
    static let preferredPort = 18765
    static let manifestURL = URL(string: "https://shiba-studio.io/packages/manifest.json")!
    static let packagesPage = URL(string: "https://shiba-studio.io/packages.html")!
    static let productName = "Shiba Studio"

    static var supportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ShibaStudio")
    }

    static var dataDirectory: URL { supportDirectory.appendingPathComponent("data") }
    static var prefsFile: URL { supportDirectory.appendingPathComponent("prefs.json") }
    static var updatesDirectory: URL { supportDirectory.appendingPathComponent("updates") }
    static var logFile: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/ShibaStudio/studio.log")
    }

    static var runtimeDirectory: URL {
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("runtime")
            if FileManager.default.fileExists(atPath: bundled.path) {
                return bundled
            }
        }
        return Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/runtime")
    }

    static var appJSON: URL { runtimeDirectory.appendingPathComponent("app.json") }
    static var nodeBinary: URL { runtimeDirectory.appendingPathComponent("bin/node") }
    static var nextCLI: URL { runtimeDirectory.appendingPathComponent("node_modules/next/dist/bin/next") }

    static func ensureUserFolders() {
        let folders = [dataDirectory, updatesDirectory, logFile.deletingLastPathComponent()]
        for folder in folders {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    static func isBundledRuntime() -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: runtimeDirectory.appendingPathComponent("package.json").path)
            && fm.fileExists(atPath: runtimeDirectory.appendingPathComponent(".next").path)
            && fm.isExecutableFile(atPath: nodeBinary.path)
            && fm.fileExists(atPath: nextCLI.path)
    }

    static func readStamp() -> Stamp {
        guard let data = try? Data(contentsOf: appJSON),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return Stamp(channel: "development", sha: nil, builtAt: nil)
        }
        return Stamp(
            channel: object["channel"] as? String,
            sha: object["sha"] as? String,
            builtAt: object["builtAt"] as? String
        )
    }

    static func readPrefs() -> Prefs {
        guard let data = try? Data(contentsOf: prefsFile),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return Prefs(channel: nil, autoUpdate: true, keepInMenuBar: true)
        }
        return Prefs(
            channel: object["channel"] as? String,
            autoUpdate: (object["autoUpdate"] as? Bool) ?? true,
            keepInMenuBar: (object["keepInMenuBar"] as? Bool) ?? true
        )
    }

    static func writePrefs(_ prefs: Prefs) {
        ensureUserFolders()
        var object: [String: Any] = [
            "autoUpdate": prefs.autoUpdate,
            "keepInMenuBar": prefs.keepInMenuBar,
        ]
        if let channel = prefs.channel { object["channel"] = channel }
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]) {
            try? data.write(to: prefsFile)
        }
    }

    static func resolvedChannel() -> String {
        if let prefs = readPrefs().channel, prefs == "main" || prefs == "development" {
            return prefs
        }
        if let stamp = readStamp().channel, stamp == "main" || stamp == "development" {
            return stamp
        }
        return "development"
    }

    static func shortSHA() -> String {
        let sha = readStamp().sha ?? ""
        return sha.count <= 7 ? sha : String(sha.prefix(7))
    }

    struct Stamp {
        let channel: String?
        let sha: String?
        let builtAt: String?
    }

    struct Prefs {
        var channel: String?
        var autoUpdate: Bool
        var keepInMenuBar: Bool
    }
}

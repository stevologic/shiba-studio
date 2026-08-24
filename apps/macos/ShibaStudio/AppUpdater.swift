import Foundation

struct UpdateOffer: Sendable {
    let channel: String
    let sha: String
    let url: URL
}

final class AppUpdater: @unchecked Sendable {
    func check() async throws -> UpdateOffer? {
        let channel = AppIdentity.resolvedChannel()
        let (data, response) = try await URLSession.shared.data(from: AppIdentity.manifestURL)
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let channels = root["channels"] as? [String: Any],
              let snapshot = channels[channel] as? [String: Any],
              let sha = snapshot["sha"] as? String, !sha.isEmpty,
              let apps = snapshot["apps"] as? [String: Any],
              let macos = apps["macos"] as? [String: Any],
              let urlString = macos["url"] as? String, let url = URL(string: urlString)
        else {
            return nil
        }
        let current = AppIdentity.readStamp().sha?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !current.isEmpty, current.caseInsensitiveCompare(sha) == .orderedSame {
            return nil
        }
        return UpdateOffer(channel: channel, sha: sha, url: url)
    }

    func downloadAndApply(_ offer: UpdateOffer, progress: (@Sendable (String) -> Void)? = nil) async throws {
        AppIdentity.ensureUserFolders()
        let work = AppIdentity.updatesDirectory.appendingPathComponent("pending")
        if FileManager.default.fileExists(atPath: work.path) {
            try FileManager.default.removeItem(at: work)
        }
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let zip = work.appendingPathComponent("update.zip")
        progress?("Downloading update…")
        try await download(offer.url, to: zip)

        progress?("Preparing update…")
        let extracted = work.appendingPathComponent("extracted")
        try FileManager.default.createDirectory(at: extracted, withIntermediateDirectories: true)
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        unzip.arguments = ["-xk", zip.path, extracted.path]
        try unzip.run()
        unzip.waitUntilExit()
        guard unzip.terminationStatus == 0 else {
            throw URLError(.cannotDecodeContentData)
        }
        guard let app = findApp(in: extracted) else {
            throw URLError(.cannotCreateFile)
        }

        let script = AppIdentity.updatesDirectory.appendingPathComponent("apply-update.sh")
        let currentApp = Bundle.main.bundleURL
        let body = """
        #!/bin/bash
        set -euo pipefail
        PID="$1"
        SRC="$2"
        DST="$3"
        while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
        rm -rf "$DST"
        /usr/bin/ditto "$SRC" "$DST"
        /usr/bin/open "$DST"
        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let apply = Process()
        apply.executableURL = script
        apply.arguments = [
            String(ProcessInfo.processInfo.processIdentifier),
            app.path,
            currentApp.path,
        ]
        apply.standardOutput = FileHandle.nullDevice
        apply.standardError = FileHandle.nullDevice
        try apply.run()
    }

    private func download(_ url: URL, to dest: URL) async throws {
        var request = URLRequest(url: url)
        request.setValue("ShibaStudio-Desktop/0.2", forHTTPHeaderField: "User-Agent")
        let (temp, response) = try await URLSession.shared.download(for: request)
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        if FileManager.default.fileExists(atPath: dest.path) {
            try FileManager.default.removeItem(at: dest)
        }
        try FileManager.default.moveItem(at: temp, to: dest)
    }

    private func findApp(in extracted: URL) -> URL? {
        let direct = extracted.appendingPathComponent("ShibaStudio.app")
        if FileManager.default.fileExists(atPath: direct.path) { return direct }
        let enumerator = FileManager.default.enumerator(at: extracted, includingPropertiesForKeys: [.isDirectoryKey])
        while let item = enumerator?.nextObject() as? URL {
            if item.lastPathComponent == "ShibaStudio.app" { return item }
        }
        return nil
    }
}

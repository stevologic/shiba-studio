using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;

namespace ShibaStudio;

sealed record UpdateOffer(string Channel, string Sha, string Url);

sealed class AppUpdater
{
    static readonly HttpClient Http = CreateClient();

    static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("ShibaStudio-Desktop/0.2");
        return client;
    }

    public async Task<UpdateOffer?> CheckAsync(CancellationToken cancellationToken = default)
    {
        var channel = AppIdentity.ResolvedChannel();
        using var request = FreshGet(ManifestUrlFor(channel));
        using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
        if (!doc.RootElement.TryGetProperty("channels", out var channels)) return null;
        if (!channels.TryGetProperty(channel, out var snapshot)) return null;
        var sha = snapshot.TryGetProperty("sha", out var shaEl) ? shaEl.GetString() ?? "" : "";
        if (string.IsNullOrWhiteSpace(sha)) return null;
        if (!snapshot.TryGetProperty("apps", out var apps) || !apps.TryGetProperty("windows", out var windows)) return null;
        var url = windows.TryGetProperty("url", out var urlEl) ? urlEl.GetString() ?? "" : "";
        if (string.IsNullOrWhiteSpace(url)) return null;
        var current = AppIdentity.ReadStamp().Sha?.Trim() ?? "";
        if (current.Length > 0 && string.Equals(current, sha, StringComparison.OrdinalIgnoreCase)) return null;
        return new UpdateOffer(channel, sha, url);
    }

    public async Task DownloadAndApplyAsync(UpdateOffer offer, IProgress<string>? progress = null, CancellationToken cancellationToken = default)
    {
        AppIdentity.EnsureUserFolders();
        var work = Path.Combine(AppIdentity.UpdatesDirectory, "pending");
        if (Directory.Exists(work)) Directory.Delete(work, recursive: true);
        Directory.CreateDirectory(work);
        var zipPath = Path.Combine(work, "update.zip");
        progress?.Report("Downloading update…");
        await DownloadAsync(offer.Url, zipPath, cancellationToken).ConfigureAwait(false);

        progress?.Report("Preparing update…");
        var extracted = Path.Combine(work, "extracted");
        ZipFile.ExtractToDirectory(zipPath, extracted, overwriteFiles: true);
        var payload = FindPayload(extracted)
            ?? throw new InvalidOperationException("The update zip did not contain ShibaStudio.exe.");
        Motw.UnblockTree(payload);

        var script = Path.Combine(AppIdentity.UpdatesDirectory, "apply-update.cmd");
        File.WriteAllText(script, ApplyScript());
        var start = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/c \"\"{script}\" {Environment.ProcessId} \"{payload}\" \"{AppIdentity.InstallDirectory}\" \"{Path.Combine(AppIdentity.InstallDirectory, "ShibaStudio.exe")}\"\"",
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        Process.Start(start);
    }

    static HttpRequestMessage FreshGet(string url)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true, NoStore = true };
        request.Headers.Pragma.ParseAdd("no-cache");
        return request;
    }

    static string ManifestUrlFor(string channel)
    {
        return $"{AppIdentity.ManifestUrl}?channel={Uri.EscapeDataString(channel)}&t={DateTimeOffset.UtcNow.ToUnixTimeSeconds()}";
    }

    static async Task DownloadAsync(string url, string dest, CancellationToken cancellationToken)
    {
        using var request = FreshGet(url);
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using var output = File.Create(dest);
        await input.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
    }

    static string? FindPayload(string extracted)
    {
        var direct = Path.Combine(extracted, "ShibaStudio.exe");
        if (File.Exists(direct)) return extracted;
        foreach (var dir in Directory.GetDirectories(extracted))
        {
            if (File.Exists(Path.Combine(dir, "ShibaStudio.exe"))) return dir;
        }
        foreach (var exe in Directory.GetFiles(extracted, "ShibaStudio.exe", SearchOption.AllDirectories))
        {
            return Path.GetDirectoryName(exe);
        }
        return null;
    }

    static string ApplyScript() => """
        @echo off
        setlocal
        set PID=%~1
        set SRC=%~2
        set DST=%~3
        set EXE=%~4
        :wait
        timeout /t 1 /nobreak >nul
        tasklist /FI "PID eq %PID%" | findstr /I "%PID%" >nul && goto wait
        robocopy "%SRC%" "%DST%" /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP
        start "" "%EXE%"
        """;
}

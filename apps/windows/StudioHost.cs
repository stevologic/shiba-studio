using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace ShibaStudio;

/// <summary>
/// Locates a Shiba Studio checkout and optionally starts <c>npm run start</c>.
/// The Windows app is a host, not a second copy of the Node server.
/// </summary>
sealed class StudioHost : IDisposable
{
    public const string DefaultOrigin = "http://127.0.0.1:3000";
    public const string HealthPath = "/api/health";

    static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(2),
    };

    Process? _process;
    bool _disposed;

    public Process? Process => _process;

    public static string? FindNode()
    {
        return FindOnPath("node.exe") ?? FindOnPath("node");
    }

    public static string? FindNpm()
    {
        return FindOnPath("npm.cmd") ?? FindOnPath("npm");
    }

    public static string? FindStudioRoot()
    {
        var fromEnv = Environment.GetEnvironmentVariable("SHIBA_STUDIO_ROOT");
        if (IsStudioRoot(fromEnv)) return Path.GetFullPath(fromEnv!);

        var configured = ReadConfiguredRoot();
        if (IsStudioRoot(configured)) return Path.GetFullPath(configured!);

        var exeDir = AppContext.BaseDirectory;
        foreach (var candidate in new[]
        {
            exeDir,
            Path.GetFullPath(Path.Combine(exeDir, "..", "..", "..", "..")),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ShibaStudio", "checkout"),
        })
        {
            if (IsStudioRoot(candidate)) return candidate;
        }

        return null;
    }

    public static bool IsStudioRoot(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return false;
        var packageJson = Path.Combine(path, "package.json");
        if (!File.Exists(packageJson)) return false;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(packageJson));
            return doc.RootElement.TryGetProperty("name", out var name)
                && string.Equals(name.GetString(), "shiba-studio", StringComparison.Ordinal);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    public static async Task<bool> IsHealthyAsync(string origin, CancellationToken cancellationToken = default)
    {
        try
        {
            using var response = await Http.GetAsync(Combine(origin, HealthPath), cancellationToken).ConfigureAwait(false);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or UriFormatException)
        {
            return false;
        }
    }

    public async Task<string> StartAsync(string origin, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (await IsHealthyAsync(origin, cancellationToken).ConfigureAwait(false))
        {
            return "Already running";
        }

        var root = FindStudioRoot()
            ?? throw new InvalidOperationException(
                "No Shiba Studio checkout found. Clone the repo, set SHIBA_STUDIO_ROOT, or connect to a Studio that is already running.");
        var npm = FindNpm()
            ?? throw new InvalidOperationException("npm was not found on PATH. Install Node.js 22.5 or later.");

        var startInfo = new ProcessStartInfo
        {
            FileName = npm,
            Arguments = "run start",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.Environment["HOST"] = "127.0.0.1";

        _process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start npm run start.");

        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_process.HasExited)
            {
                throw new InvalidOperationException($"Studio host exited with code {_process.ExitCode}.");
            }
            if (await IsHealthyAsync(origin, cancellationToken).ConfigureAwait(false))
            {
                return $"Started from {root}";
            }
            await Task.Delay(500, cancellationToken).ConfigureAwait(false);
        }

        throw new TimeoutException("Studio started but /api/health did not become ready in 90s.");
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_process is { HasExited: false })
        {
            try { _process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { /* already gone */ }
        }
        _process?.Dispose();
    }

    static string Combine(string origin, string path)
    {
        return new Uri(new Uri(origin.EndsWith('/') ? origin : origin + "/", UriKind.Absolute), path.TrimStart('/')).ToString();
    }

    static string? FindOnPath(string fileName)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), fileName);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    static string? ReadConfiguredRoot()
    {
        var file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "ShibaStudio",
            "host.json");
        if (!File.Exists(file)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            return doc.RootElement.TryGetProperty("studioRoot", out var root) ? root.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

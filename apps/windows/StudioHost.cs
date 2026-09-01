using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace ShibaStudio;

/// <summary>
/// Starts the bundled Studio production server (`next start`) on loopback.
/// The Windows app is a native host around that same web UI — not a second product.
/// </summary>
sealed class StudioHost : IDisposable
{
    public const string HealthPath = "/api/health";

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    Process? _process;
    bool _disposed;

    public Uri? Origin { get; private set; }

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

    public async Task<Uri> StartAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!AppIdentity.IsBundledRuntime())
        {
            throw new InvalidOperationException(
                "This copy of Shiba Studio is missing its bundled runtime. Download a packages build from https://shiba-studio.io/packages.html");
        }

        var port = ReservePort(AppIdentity.ReadStamp().PreferredPort ?? AppIdentity.PreferredPort);
        var origin = new Uri($"http://127.0.0.1:{port}");
        if (await IsHealthyAsync(origin.ToString(), cancellationToken).ConfigureAwait(false))
        {
            Origin = origin;
            return origin;
        }

        AppIdentity.EnsureUserFolders();
        Motw.Unblock(AppIdentity.NodeBinary);
        Motw.UnblockTree(AppIdentity.RuntimeDirectory);
        Directory.CreateDirectory(Path.GetDirectoryName(AppIdentity.LogFile)!);
        var log = new StreamWriter(new FileStream(AppIdentity.LogFile, FileMode.Create, FileAccess.Write, FileShare.Read))
        {
            AutoFlush = true,
        };

        var stamp = AppIdentity.ReadStamp();
        var startInfo = new ProcessStartInfo
        {
            FileName = AppIdentity.NodeBinary,
            Arguments = $"\"{AppIdentity.NextCli}\" start -H 127.0.0.1 --port {port}",
            WorkingDirectory = AppIdentity.RuntimeDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.Environment["HOST"] = "127.0.0.1";
        startInfo.Environment["PORT"] = port.ToString();
        startInfo.Environment["NODE_ENV"] = "production";
        startInfo.Environment["SHIBA_PROJECT_ROOT"] = AppIdentity.RuntimeDirectory;
        startInfo.Environment["SHIBA_DATA_DIR"] = AppIdentity.DataDirectory;
        startInfo.Environment["SHIBA_SECRET_KEY_FILE"] = Path.Combine(AppIdentity.DataDirectory, "shiba-studio.key");
        startInfo.Environment["SHIBA_GIT_COMMIT"] = stamp.Sha ?? "";
        startInfo.Environment["TERMINAL_WS_PORT"] = (port + 1).ToString();
        startInfo.Environment["TERMINAL_WS_HOST"] = "127.0.0.1";
        startInfo.Environment["PUPPETEER_SKIP_DOWNLOAD"] = "1";
        startInfo.Environment["NEXT_TELEMETRY_DISABLED"] = "1";

        _process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start the bundled Studio server.");
        _process.OutputDataReceived += (_, e) => { if (e.Data is not null) { try { log.WriteLine(e.Data); } catch (ObjectDisposedException) { } } };
        _process.ErrorDataReceived += (_, e) => { if (e.Data is not null) { try { log.WriteLine(e.Data); } catch (ObjectDisposedException) { } } };
        _process.Exited += (_, _) => { try { log.Dispose(); } catch (ObjectDisposedException) { } };
        _process.EnableRaisingEvents = true;
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        try
        {
            var deadline = DateTime.UtcNow.AddSeconds(120);
            while (DateTime.UtcNow < deadline)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_process.HasExited)
                {
                    throw new InvalidOperationException(
                        $"Studio exited with code {_process.ExitCode}. See {AppIdentity.LogFile}");
                }
                if (await IsHealthyAsync(origin.ToString(), cancellationToken).ConfigureAwait(false))
                {
                    Origin = origin;
                    return origin;
                }
                await Task.Delay(400, cancellationToken).ConfigureAwait(false);
            }

            throw new TimeoutException($"Studio started but /api/health did not become ready. See {AppIdentity.LogFile}");
        }
        catch
        {
            if (_process is { HasExited: false })
            {
                try { _process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) { }
            }
            throw;
        }
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

    static int ReservePort(int preferred)
    {
        for (var port = preferred; port < preferred + 16; port++)
        {
            try
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                listener.Stop();
                return port;
            }
            catch (SocketException)
            {
                // try the next port
            }
        }
        throw new InvalidOperationException("No free loopback port was found for Shiba Studio.");
    }

    static string Combine(string origin, string path)
    {
        return new Uri(new Uri(origin.EndsWith('/') ? origin : origin + "/", UriKind.Absolute), path.TrimStart('/')).ToString();
    }
}

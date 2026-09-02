using System.Text.Json;
using System.Text.Json.Serialization;

namespace ShibaStudio;

sealed record AppStamp(
    int Version,
    string? Kind,
    string? Platform,
    string? Channel,
    string? Sha,
    string? BuiltAt,
    string? Node,
    int? PreferredPort,
    string? ManifestUrl,
    string? PackagesPage);

sealed class UserPrefs
{
    public string? Channel { get; set; }
    public bool AutoUpdate { get; set; } = true;
    /// <summary>Minimize and close hide the window to the notification area instead of exiting.</summary>
    public bool MinimizeToTray { get; set; } = true;
}

static class AppIdentity
{
    public const int PreferredPort = 18765;
    public const string ManifestUrl = "https://shiba-studio.io/packages/manifest.json";
    public const string PackagesPage = "https://shiba-studio.io/packages.html";
    public const string ProductName = "Shiba Studio";

    static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string InstallDirectory => AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    public static string UserDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ShibaStudio");

    public static string DataDirectory => Path.Combine(UserDirectory, "data");
    public static string WebViewDirectory => Path.Combine(UserDirectory, "webview");
    public static string LogDirectory => Path.Combine(UserDirectory, "logs");
    public static string LogFile => Path.Combine(LogDirectory, "studio.log");
    public static string PrefsFile => Path.Combine(UserDirectory, "prefs.json");
    public static string UpdatesDirectory => Path.Combine(UserDirectory, "updates");

    public static string RuntimeDirectory
    {
        get
        {
            var bundled = Path.Combine(InstallDirectory, "runtime");
            if (Directory.Exists(bundled)) return bundled;
            return InstallDirectory;
        }
    }

    public static string AppJsonPath => Path.Combine(RuntimeDirectory, "app.json");

    public static string NodeBinary
    {
        get
        {
            var bundled = Path.Combine(RuntimeDirectory, "node.exe");
            if (File.Exists(bundled)) return bundled;
            bundled = Path.Combine(RuntimeDirectory, "bin", "node.exe");
            if (File.Exists(bundled)) return bundled;
            return bundled;
        }
    }

    public static string NextCli => Path.Combine(RuntimeDirectory, "node_modules", "next", "dist", "bin", "next");

    public static bool IsBundledRuntime()
    {
        return File.Exists(Path.Combine(RuntimeDirectory, "package.json"))
            && Directory.Exists(Path.Combine(RuntimeDirectory, ".next"))
            && File.Exists(NextCli)
            && File.Exists(NodeBinary);
    }

    public static AppStamp ReadStamp()
    {
        if (!File.Exists(AppJsonPath))
        {
            return new AppStamp(1, "bundled-desktop", "windows", "development", null, null, null, PreferredPort, ManifestUrl, PackagesPage);
        }
        try
        {
            var stamp = JsonSerializer.Deserialize<AppStamp>(File.ReadAllText(AppJsonPath), JsonOptions);
            return stamp ?? new AppStamp(1, "bundled-desktop", "windows", "development", null, null, null, PreferredPort, ManifestUrl, PackagesPage);
        }
        catch (JsonException)
        {
            return new AppStamp(1, "bundled-desktop", "windows", "development", null, null, null, PreferredPort, ManifestUrl, PackagesPage);
        }
    }

    public static UserPrefs ReadPrefs()
    {
        if (!File.Exists(PrefsFile)) return new UserPrefs();
        try
        {
            return JsonSerializer.Deserialize<UserPrefs>(File.ReadAllText(PrefsFile), JsonOptions) ?? new UserPrefs();
        }
        catch (JsonException)
        {
            return new UserPrefs();
        }
    }

    public static void WritePrefs(UserPrefs prefs)
    {
        Directory.CreateDirectory(UserDirectory);
        File.WriteAllText(PrefsFile, JsonSerializer.Serialize(prefs, JsonOptions));
    }

    public static string ResolvedChannel()
    {
        var prefs = ReadPrefs().Channel?.Trim();
        if (prefs is "main" or "development") return prefs;
        var stamp = ReadStamp().Channel?.Trim();
        return stamp is "main" or "development" ? stamp : "development";
    }

    public static string ShortSha()
    {
        var sha = ReadStamp().Sha?.Trim() ?? "";
        return sha.Length <= 7 ? sha : sha[..7];
    }

    public static void EnsureUserFolders()
    {
        Directory.CreateDirectory(DataDirectory);
        Directory.CreateDirectory(WebViewDirectory);
        Directory.CreateDirectory(LogDirectory);
        Directory.CreateDirectory(UpdatesDirectory);
    }
}

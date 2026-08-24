using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ShibaStudio;

sealed class MainForm : Form
{
    static readonly Color Bg = Color.FromArgb(10, 10, 10);
    static readonly Color Ink = Color.FromArgb(245, 245, 245);
    static readonly Color Muted = Color.FromArgb(163, 163, 163);

    readonly StudioHost _host = new();
    readonly AppUpdater _updater = new();
    readonly WebView2 _web;
    readonly Panel _splash;
    readonly Label _splashTitle;
    readonly Label _splashDetail;
    readonly MenuStrip _menu;
    bool _webReady;
    Uri? _origin;
    bool _updateInFlight;

    public MainForm()
    {
        Text = AppIdentity.ProductName;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(960, 640);
        Size = new Size(1280, 840);
        BackColor = Bg;
        ForeColor = Ink;
        Font = new Font("Segoe UI", 10f, FontStyle.Regular, GraphicsUnit.Point);
        Icon = LoadIcon();

        _menu = BuildMenu();
        _web = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.Black,
            Visible = false,
        };
        _splash = BuildSplash(out _splashTitle, out _splashDetail);

        Controls.Add(_web);
        Controls.Add(_splash);
        Controls.Add(_menu);
        MainMenuStrip = _menu;

        HandleCreated += (_, _) => NativeWindowChrome.Apply(this);
        Load += async (_, _) => await BootAsync();
        FormClosed += (_, _) => _host.Dispose();
        KeyPreview = true;
        KeyDown += async (_, e) =>
        {
            if (e.KeyCode == Keys.F5 || (e.Control && e.KeyCode == Keys.R))
            {
                e.Handled = true;
                await ReloadAsync();
            }
            else if (e.KeyCode == Keys.F12)
            {
                e.Handled = true;
                _web.CoreWebView2?.OpenDevToolsWindow();
            }
            else if (e.Control && e.KeyCode == Keys.Oemcomma)
            {
                e.Handled = true;
                ShowPreferences();
            }
        };
    }

    MenuStrip BuildMenu()
    {
        var menu = new MenuStrip
        {
            Dock = DockStyle.Top,
            BackColor = Bg,
            ForeColor = Ink,
            Renderer = new DarkMenuRenderer(),
            Padding = new Padding(6, 2, 6, 2),
            GripStyle = ToolStripGripStyle.Hidden,
        };
        var studio = new ToolStripMenuItem("&Studio");
        studio.DropDownItems.Add(Item("&Reload", async () => await ReloadAsync(), Keys.F5));
        studio.DropDownItems.Add(Item("&Companion", async () => await OpenCompanionAsync()));
        studio.DropDownItems.Add(new ToolStripSeparator());
        studio.DropDownItems.Add(Item("Check for &Updates…", async () => await CheckForUpdatesAsync(manual: true)));
        studio.DropDownItems.Add(Item("&Preferences…", ShowPreferences));
        studio.DropDownItems.Add(new ToolStripSeparator());
        studio.DropDownItems.Add(Item("E&xit", Close));

        var view = new ToolStripMenuItem("&View");
        view.DropDownItems.Add(Item("&Developer Tools", () => _web.CoreWebView2?.OpenDevToolsWindow(), Keys.F12));

        var help = new ToolStripMenuItem("&Help");
        help.DropDownItems.Add(Item("&Packages page", OpenPackagesPage));
        help.DropDownItems.Add(Item("&About Shiba Studio", ShowAbout));

        menu.Items.Add(studio);
        menu.Items.Add(view);
        menu.Items.Add(help);
        return menu;
    }

    static ToolStripMenuItem Item(string text, Action action, Keys shortcut = Keys.None)
    {
        var item = new ToolStripMenuItem(text);
        if (shortcut != Keys.None) item.ShortcutKeys = shortcut;
        item.Click += (_, _) => action();
        return item;
    }

    static ToolStripMenuItem Item(string text, Func<Task> action, Keys shortcut = Keys.None)
    {
        var item = new ToolStripMenuItem(text);
        if (shortcut != Keys.None) item.ShortcutKeys = shortcut;
        item.Click += async (_, _) => await action();
        return item;
    }

    Panel BuildSplash(out Label title, out Label detail)
    {
        var panel = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Bg,
        };
        title = new Label
        {
            Text = AppIdentity.ProductName,
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI Semibold", 22f, FontStyle.Bold, GraphicsUnit.Point),
            ForeColor = Ink,
            Dock = DockStyle.None,
        };
        detail = new Label
        {
            Text = "Starting…",
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Muted,
            Dock = DockStyle.None,
        };
        panel.Controls.Add(title);
        panel.Controls.Add(detail);
        panel.Resize += (_, _) =>
        {
            title.Size = new Size(panel.ClientSize.Width, 40);
            title.Location = new Point(0, Math.Max(40, panel.ClientSize.Height / 2 - 36));
            detail.Size = new Size(panel.ClientSize.Width, 28);
            detail.Location = new Point(0, title.Bottom + 8);
        };
        return panel;
    }

    async Task BootAsync()
    {
        NativeWindowChrome.Apply(this);
        SetSplash("Starting Shiba Studio…");
        try
        {
            await InitializeWebAsync();
            _origin = await _host.StartAsync();
            await NavigateAsync(_origin);
            ShowStudio();
            _ = CheckForUpdatesAsync(manual: false);
        }
        catch (Exception ex)
        {
            SetSplash(ex.Message);
        }
    }

    async Task InitializeWebAsync()
    {
        AppIdentity.EnsureUserFolders();
        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: AppIdentity.WebViewDirectory);
        await _web.EnsureCoreWebView2Async(env);
        _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
        _web.CoreWebView2.Settings.AreDevToolsEnabled = true;
        _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
        _web.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;
        _web.CoreWebView2.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Dark;
        _web.CoreWebView2.DocumentTitleChanged += (_, _) =>
        {
            var title = _web.CoreWebView2.DocumentTitle;
            Text = string.IsNullOrWhiteSpace(title) || title.Contains(AppIdentity.ProductName, StringComparison.OrdinalIgnoreCase)
                ? (string.IsNullOrWhiteSpace(title) ? AppIdentity.ProductName : title)
                : $"{title} — {AppIdentity.ProductName}";
        };
        _web.CoreWebView2.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenUrl(e.Uri);
        };
        _web.CoreWebView2.NavigationStarting += (_, e) =>
        {
            if (!IsStudioUrl(e.Uri))
            {
                e.Cancel = true;
                OpenExternal(e.Uri);
            }
        };
        _web.CoreWebView2.PermissionRequested += (_, e) =>
        {
            if (IsStudioUrl(e.Uri)) e.State = CoreWebView2PermissionState.Allow;
        };
        _webReady = true;
    }

    async Task NavigateAsync(Uri url)
    {
        if (!_webReady) return;
        _web.CoreWebView2.Navigate(url.ToString());
        await Task.CompletedTask;
    }

    async Task ReloadAsync()
    {
        if (_webReady) _web.CoreWebView2.Reload();
        await Task.CompletedTask;
    }

    async Task OpenCompanionAsync()
    {
        if (_origin is null) return;
        await NavigateAsync(new Uri(_origin, "companion"));
    }

    void ShowStudio()
    {
        _splash.Visible = false;
        _web.Visible = true;
        _web.BringToFront();
    }

    void SetSplash(string detail)
    {
        _splash.Visible = true;
        _splash.BringToFront();
        _web.Visible = false;
        _splashDetail.Text = detail;
    }

    void ShowPreferences()
    {
        using var dialog = new PreferencesForm();
        if (dialog.ShowDialog(this) == DialogResult.OK && AppIdentity.ReadPrefs().AutoUpdate)
        {
            _ = CheckForUpdatesAsync(manual: true);
        }
    }

    void ShowAbout()
    {
        var stamp = AppIdentity.ReadStamp();
        var sha = AppIdentity.ShortSha();
        MessageBox.Show(
            this,
            $"{AppIdentity.ProductName}\nChannel: {AppIdentity.ResolvedChannel()}\nRevision: {(string.IsNullOrEmpty(sha) ? "local" : sha)}\n{(stamp.BuiltAt ?? "")}\n\n{AppIdentity.PackagesPage}",
            "About Shiba Studio",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    static void OpenPackagesPage() => OpenExternal(AppIdentity.PackagesPage);

    async Task CheckForUpdatesAsync(bool manual)
    {
        if (_updateInFlight) return;
        _updateInFlight = true;
        try
        {
            var offer = await _updater.CheckAsync();
            if (offer is null)
            {
                if (manual)
                {
                    MessageBox.Show(this, "You're on the latest build for this channel.", AppIdentity.ProductName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return;
            }

            var prefs = AppIdentity.ReadPrefs();
            if (!manual && !prefs.AutoUpdate) return;
            if (!manual && prefs.AutoUpdate)
            {
                await ApplyUpdateAsync(offer);
                return;
            }

            var result = MessageBox.Show(
                this,
                $"A newer {offer.Channel} build is available ({offer.Sha[..Math.Min(7, offer.Sha.Length)]}). Update now?",
                AppIdentity.ProductName,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (result == DialogResult.Yes) await ApplyUpdateAsync(offer);
        }
        catch (Exception ex)
        {
            if (manual)
            {
                MessageBox.Show(this, ex.Message, AppIdentity.ProductName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        finally
        {
            _updateInFlight = false;
        }
    }

    async Task ApplyUpdateAsync(UpdateOffer offer)
    {
        SetSplash("Updating Shiba Studio…");
        var progress = new Progress<string>(SetSplash);
        await _updater.DownloadAndApplyAsync(offer, progress);
        Close();
    }

    void OpenUrl(string uri)
    {
        if (IsStudioUrl(uri) && _webReady) _web.CoreWebView2.Navigate(uri);
        else OpenExternal(uri);
    }

    static bool IsStudioUrl(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme is not ("http" or "https")) return false;
        return parsed.Host is "127.0.0.1" or "localhost" or "::1";
    }

    static void OpenExternal(string uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // The user can still copy the URL from the packages page.
        }
    }

    static Icon? LoadIcon()
    {
        var ico = Path.Combine(AppContext.BaseDirectory, "shiba.ico");
        return File.Exists(ico) ? new Icon(ico) : null;
    }
}

using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ShibaStudio;

sealed class MainForm : Form
{
    static readonly Color Bg = Color.FromArgb(10, 10, 10);
    static readonly Color Panel = Color.FromArgb(17, 17, 17);
    static readonly Color Border = Color.FromArgb(38, 38, 38);
    static readonly Color Text = Color.FromArgb(245, 245, 245);
    static readonly Color Muted = Color.FromArgb(163, 163, 163);

    readonly TextBox _address;
    readonly Button _go;
    readonly Button _start;
    readonly Button _companion;
    readonly Label _status;
    readonly WebView2 _web;
    readonly StudioHost _host = new();
    bool _webReady;

    public MainForm()
    {
        Text = "Shiba Studio";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(960, 640);
        Size = new Size(1280, 840);
        BackColor = Bg;
        ForeColor = Text;
        Font = new Font("Segoe UI", 10f, FontStyle.Regular, GraphicsUnit.Point);

        var chrome = new Panel
        {
            Dock = DockStyle.Top,
            Height = 56,
            BackColor = Panel,
            Padding = new Padding(12, 10, 12, 10),
        };

        _address = new TextBox
        {
            Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top,
            Location = new Point(12, 14),
            Width = 640,
            Height = 28,
            BorderStyle = BorderStyle.FixedSingle,
            BackColor = Color.Black,
            ForeColor = Text,
            Text = StudioHost.DefaultOrigin,
        };

        _go = MakeButton("Open", 0);
        _start = MakeButton("Start local Studio", 1);
        _companion = MakeButton("Companion", 2);

        _status = new Label
        {
            Dock = DockStyle.Bottom,
            Height = 28,
            TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(12, 0, 12, 0),
            ForeColor = Muted,
            BackColor = Panel,
            Text = "Connecting…",
        };

        _web = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.Black,
        };

        chrome.Controls.Add(_address);
        chrome.Controls.Add(_go);
        chrome.Controls.Add(_start);
        chrome.Controls.Add(_companion);
        chrome.Resize += (_, _) => LayoutChrome(chrome);

        Controls.Add(_web);
        Controls.Add(_status);
        Controls.Add(chrome);
        LayoutChrome(chrome);

        _go.Click += async (_, _) => await NavigateAsync(Companion: false);
        _companion.Click += async (_, _) => await NavigateAsync(Companion: true);
        _start.Click += async (_, _) => await StartStudioAsync();
        _address.KeyDown += async (_, e) =>
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                await NavigateAsync(Companion: false);
            }
        };
        Load += async (_, _) => await InitializeWebAsync();
        FormClosed += (_, _) => _host.Dispose();
    }

    Button MakeButton(string label, int index)
    {
        return new Button
        {
            Text = label,
            Tag = index,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.White,
            ForeColor = Color.Black,
            Height = 30,
            Width = index == 1 ? 150 : 110,
            Cursor = Cursors.Hand,
        };
    }

    void LayoutChrome(Control chrome)
    {
        var right = chrome.ClientSize.Width - 12;
        foreach (var button in new[] { _companion, _start, _go })
        {
            right -= button.Width;
            button.Location = new Point(right, 13);
            right -= 8;
        }
        _address.Width = Math.Max(240, right - 20);
    }

    async Task InitializeWebAsync()
    {
        try
        {
            var profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ShibaStudio",
                "webview");
            Directory.CreateDirectory(profile);
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            await _web.EnsureCoreWebView2Async(env);
            _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            _web.CoreWebView2.Settings.AreDevToolsEnabled = true;
            _web.CoreWebView2.DocumentTitleChanged += (_, _) =>
            {
                var title = _web.CoreWebView2.DocumentTitle;
                Text = string.IsNullOrWhiteSpace(title) ? "Shiba Studio" : $"{title} — Shiba Studio";
            };
            _webReady = true;
            _status.Text = StudioHost.FindStudioRoot() is string root
                ? $"Ready · checkout {root}"
                : "Ready · connect a running Studio or set SHIBA_STUDIO_ROOT";
            await NavigateAsync(Companion: false);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            _status.Text = "Install the Evergreen WebView2 runtime, then reopen Shiba Studio.";
            MessageBox.Show(
                this,
                "Microsoft Edge WebView2 Runtime is required.\nDownload it from https://developer.microsoft.com/microsoft-edge/webview2/",
                "Shiba Studio",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            _status.Text = ex.Message;
        }
    }

    async Task NavigateAsync(bool Companion)
    {
        if (!_webReady) return;
        if (!TryNormalizeOrigin(_address.Text, out var origin, out var error))
        {
            _status.Text = error;
            return;
        }
        _address.Text = origin;
        var url = Companion ? new Uri(new Uri(origin + "/"), "companion").ToString() : origin;
        _status.Text = $"Opening {url}";
        _web.CoreWebView2.Navigate(url);
        await Task.CompletedTask;
    }

    async Task StartStudioAsync()
    {
        _start.Enabled = false;
        try
        {
            if (!TryNormalizeOrigin(_address.Text, out var origin, out var error))
            {
                _status.Text = error;
                return;
            }
            _address.Text = origin;
            _status.Text = "Starting local Studio…";
            var result = await _host.StartAsync(origin);
            _status.Text = result;
            await NavigateAsync(Companion: false);
        }
        catch (Exception ex)
        {
            _status.Text = ex.Message;
        }
        finally
        {
            _start.Enabled = true;
        }
    }

    static bool TryNormalizeOrigin(string raw, out string origin, out string error)
    {
        origin = StudioHost.DefaultOrigin;
        error = "";
        var text = string.IsNullOrWhiteSpace(raw) ? StudioHost.DefaultOrigin : raw.Trim();
        if (!text.Contains("://", StringComparison.Ordinal)) text = "http://" + text;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            error = "Enter an http(s) Studio origin such as http://127.0.0.1:3000";
            return false;
        }
        origin = uri.GetLeftPart(UriPartial.Authority);
        return true;
    }
}

using System.Drawing;
using System.Windows.Forms;

namespace ShibaStudio;

sealed class PreferencesForm : Form
{
    readonly RadioButton _main;
    readonly RadioButton _development;
    readonly CheckBox _autoUpdate;

    public PreferencesForm()
    {
        Text = "Preferences";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(440, 248);
        BackColor = Color.FromArgb(10, 10, 10);
        ForeColor = Color.FromArgb(245, 245, 245);
        Font = new Font("Segoe UI", 10f, FontStyle.Regular, GraphicsUnit.Point);
        Padding = new Padding(20);

        var prefs = AppIdentity.ReadPrefs();
        var channel = AppIdentity.ResolvedChannel();

        var intro = new Label
        {
            AutoSize = false,
            Location = new Point(20, 18),
            Size = new Size(400, 40),
            Text = "This app stays on the channel you downloaded and updates when that branch moves.",
        };

        _main = new RadioButton
        {
            Text = "Stable (main)",
            Location = new Point(20, 68),
            AutoSize = true,
            Checked = channel == "main",
        };
        _development = new RadioButton
        {
            Text = "Development",
            Location = new Point(20, 96),
            AutoSize = true,
            Checked = channel != "main",
        };
        _autoUpdate = new CheckBox
        {
            Text = "Install updates automatically",
            Location = new Point(20, 136),
            AutoSize = true,
            Checked = prefs.AutoUpdate,
        };

        var ok = new Button
        {
            Text = "OK",
            DialogResult = DialogResult.OK,
            Location = new Point(248, 196),
            Size = new Size(80, 28),
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.White,
            ForeColor = Color.Black,
        };
        var cancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(336, 196),
            Size = new Size(80, 28),
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(38, 38, 38),
            ForeColor = Color.White,
        };

        Controls.Add(intro);
        Controls.Add(_main);
        Controls.Add(_development);
        Controls.Add(_autoUpdate);
        Controls.Add(ok);
        Controls.Add(cancel);
        AcceptButton = ok;
        CancelButton = cancel;

        ok.Click += (_, _) =>
        {
            AppIdentity.WritePrefs(new UserPrefs
            {
                Channel = _main.Checked ? "main" : "development",
                AutoUpdate = _autoUpdate.Checked,
            });
        };
    }
}

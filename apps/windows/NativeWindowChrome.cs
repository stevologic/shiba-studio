using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ShibaStudio;

static class NativeWindowChrome
{
    const int DwmwaUseImmersiveDarkModeBefore20H1 = 19;
    const int DwmwaUseImmersiveDarkMode = 20;
    const int DwmwaCaptionColor = 35;
    const int DwmwaTextColor = 36;
    const int DwmwaBorderColor = 34;

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public static void Apply(Form form)
    {
        if (!form.IsHandleCreated) return;
        var hwnd = form.Handle;
        var dark = 1;
        _ = DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkModeBefore20H1, ref dark, sizeof(int));
        _ = DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int));

        var caption = ToColorRef(Color.FromArgb(10, 10, 10));
        var text = ToColorRef(Color.FromArgb(245, 245, 245));
        var border = ToColorRef(Color.FromArgb(38, 38, 38));
        _ = DwmSetWindowAttribute(hwnd, DwmwaCaptionColor, ref caption, sizeof(int));
        _ = DwmSetWindowAttribute(hwnd, DwmwaTextColor, ref text, sizeof(int));
        _ = DwmSetWindowAttribute(hwnd, DwmwaBorderColor, ref border, sizeof(int));
    }

    static int ToColorRef(Color color) => color.R | (color.G << 8) | (color.B << 16);
}

sealed class DarkMenuRenderer : ToolStripProfessionalRenderer
{
    public DarkMenuRenderer() : base(new DarkMenuColors())
    {
        RoundedEdges = false;
    }

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        // No 3D edge — keep the menu flush with the title bar and web view.
    }
}

sealed class DarkMenuColors : ProfessionalColorTable
{
    static readonly Color Bg = Color.FromArgb(10, 10, 10);
    static readonly Color Hover = Color.FromArgb(38, 38, 38);
    static readonly Color Line = Color.FromArgb(38, 38, 38);

    public override Color MenuStripGradientBegin => Bg;
    public override Color MenuStripGradientEnd => Bg;
    public override Color MenuBorder => Line;
    public override Color MenuItemBorder => Hover;
    public override Color MenuItemSelected => Hover;
    public override Color MenuItemSelectedGradientBegin => Hover;
    public override Color MenuItemSelectedGradientEnd => Hover;
    public override Color MenuItemPressedGradientBegin => Hover;
    public override Color MenuItemPressedGradientEnd => Hover;
    public override Color ImageMarginGradientBegin => Bg;
    public override Color ImageMarginGradientMiddle => Bg;
    public override Color ImageMarginGradientEnd => Bg;
    public override Color ToolStripDropDownBackground => Bg;
    public override Color SeparatorDark => Line;
    public override Color SeparatorLight => Line;
}

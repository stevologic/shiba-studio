using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ShibaStudio;

static class Program
{
    const string MutexName = @"Local\ShibaStudio.Desktop";
    static readonly IntPtr HwndBroadcast = (IntPtr)0xffff;

    internal static readonly int RestoreMessage = RegisterWindowMessage("ShibaStudio.Restore");

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int RegisterWindowMessage(string lpString);

    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--unblock-motw")
        {
            if (!Directory.Exists(args[1])) Environment.Exit(1);
            Motw.UnblockTree(args[1]);
            Environment.Exit(0);
            return;
        }

        Motw.UnblockTree(AppIdentity.InstallDirectory);
        Motw.UnblockTree(AppIdentity.RuntimeDirectory);

        using var mutex = new Mutex(true, MutexName, out var created);
        if (!created)
        {
            ActivateExisting();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
        GC.KeepAlive(mutex);
    }

    static void ActivateExisting()
    {
        PostMessage(HwndBroadcast, RestoreMessage, IntPtr.Zero, IntPtr.Zero);
        foreach (var process in Process.GetProcessesByName("ShibaStudio"))
        {
            if (process.Id == Environment.ProcessId) continue;
            var handle = process.MainWindowHandle;
            if (handle == IntPtr.Zero) continue;
            ShowWindow(handle, 9);
            SetForegroundWindow(handle);
            break;
        }
    }
}

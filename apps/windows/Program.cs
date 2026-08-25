using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ShibaStudio;

static class Program
{
    const string MutexName = @"Local\ShibaStudio.Desktop";

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [STAThread]
    static void Main()
    {
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

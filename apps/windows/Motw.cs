using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

namespace ShibaStudio
{
    /// <summary>
    /// Clears NTFS Mark-of-the-Web (Zone.Identifier) from files this process
    /// is about to run. A zip downloaded from GitHub copies ZoneId=3 onto
    /// extracted .exe files; Windows then shows Unknown publisher before
    /// node.exe (and on later launches of the host).
    /// </summary>
    public static class Motw
    {
        static readonly string[] UnblockExtensions = new string[]
        {
            ".exe", ".dll", ".com", ".scr", ".msi", ".msix", ".cmd", ".bat", ".ps1",
        };

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool DeleteFile(string lpFileName);

        /// <summary>Delete the Zone.Identifier ADS on one file. Returns whether an ADS was removed.</summary>
        public static bool Unblock(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return false;
            try
            {
                return DeleteFile(path + ":Zone.Identifier");
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>Unblock launchable files under root (not a full node_modules walk of every .js).</summary>
        public static int UnblockTree(string root)
        {
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return 0;
            var removed = 0;
            foreach (var file in EnumerateLaunchable(root))
            {
                if (Unblock(file)) removed++;
            }
            return removed;
        }

        static IEnumerable<string> EnumerateLaunchable(string root)
        {
            var found = new List<string>();
            var stack = new Stack<string>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                var dir = stack.Pop();
                string[] entries;
                try { entries = Directory.GetFileSystemEntries(dir); }
                catch (Exception) { continue; }
                foreach (var entry in entries)
                {
                    FileAttributes attrs;
                    try { attrs = File.GetAttributes(entry); }
                    catch (Exception) { continue; }
                    if ((attrs & FileAttributes.Directory) != 0)
                    {
                        var name = Path.GetFileName(entry);
                        if (name == "node_modules" || name == ".next" || name == "webview") continue;
                        stack.Push(entry);
                        continue;
                    }
                    var ext = Path.GetExtension(entry);
                    if (ext.Length > 0 && UnblockExtensions.Contains(ext, StringComparer.OrdinalIgnoreCase))
                    {
                        found.Add(entry);
                    }
                }
            }
            return found;
        }
    }
}

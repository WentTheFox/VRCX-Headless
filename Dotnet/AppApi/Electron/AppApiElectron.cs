using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32;
using NLog;

namespace VRCX
{
    public partial class AppApiElectron : AppApi
    {
        private static readonly Logger logger = LogManager.GetCurrentClassLogger();

        public override void ShowDevTools()
        {
        }

        public override void SetVR(bool active, bool hmdOverlay, bool wristOverlay, bool menuButton, int overlayHand)
        {
            Program.VRCXVRInstance.SetActive(active, hmdOverlay, wristOverlay, menuButton, overlayHand);
        }

        public override void SetZoom(double zoomLevel)
        {
        }

        public override async Task<double> GetZoom()
        {
            return 1;
        }

        public override void DesktopNotification(string BoldText, string Text = "", string Image = "")
        {
        }

        public override void RestartApplication(bool isUpgrade)
        {
        }

        public override bool CheckForUpdateExe()
        {
            return false;
        }

        public override void ExecuteVrOverlayFunction(string function, string json)
        {
            Program.VRCXVRInstance.ExecuteVrOverlayFunction(function, json);
        }

        public override void FocusWindow()
        {
        }

        public override void ChangeTheme(int value)
        {
        }

        public override void DoFunny()
        {
        }

        public override string GetClipboard()
        {
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "xclip",
                    Arguments = "-o",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true
                }
            };
            try
            {
                process.Start();
                var output = process.StandardOutput.ReadToEnd();
                process.WaitForExit();
                return output;
            }
            catch (Exception ex)
            {
                logger.Error($"Failed to get clipboard: {ex.Message}");
                return string.Empty;
            }
        }

        /// <summary>
        /// Was a permanent no-op here, unlike the CefSharp/Windows client's own implementation —
        /// correct on Linux, where autostart is a manual "--startup" arg on the .desktop file
        /// (see the Settings page's own startup_linux hint), but this Electron client also runs on
        /// native Windows now, and the Settings toggle silently persisted its config bool there
        /// without ever touching the Run key, so "start with Windows" never actually did anything.
        /// </summary>
        public override void SetStartup(bool enabled)
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                return;

            try
            {
                using var key = Registry.CurrentUser.OpenSubKey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run", true);
                if (key == null)
                {
                    logger.Warn("Failed to open startup registry key");
                    return;
                }

                if (enabled)
                {
                    var path = Environment.ProcessPath;
                    if (path == null)
                    {
                        logger.Warn("Failed to determine process path for startup registration");
                        return;
                    }

                    key.SetValue("VRCX", $"\"{path}\" --startup");
                }
                else
                {
                    key.DeleteValue("VRCX", false);
                }
            }
            catch (Exception e)
            {
                logger.Warn(e, "Failed to set startup");
            }
        }

        public override void CopyImageToClipboard(string path)
        {
            if (!File.Exists(path) ||
                (!path.EndsWith(".png") &&
                 !path.EndsWith(".jpg") &&
                 !path.EndsWith(".jpeg") &&
                 !path.EndsWith(".gif") &&
                 !path.EndsWith(".bmp") &&
                 !path.EndsWith(".webp")))
                return;

            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "xclip",
                    Arguments = $"-selection clipboard -t image/png -i \"{path}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };
            try
            {
                process.Start();
                process.WaitForExit();
            }
            catch (Exception ex)
            {
                logger.Error($"Failed to copy image to clipboard: {ex.Message}");
            }
        }

        public override void FlashWindow()
        {
        }

        public override void SetUserAgent()
        {
        }

        public override void SetTrayIconNotification(bool notify)
        {
        }

        public override void OpenCalendarFile(string icsContent)
        {
        }
    }
}

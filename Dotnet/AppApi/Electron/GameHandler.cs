using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace VRCX
{
    public partial class AppApiElectron
    {
        public override void OnProcessStateChanged(MonitoredProcess monitoredProcess)
        {
            // unused
        }

        /// <summary>
        /// for Cef only, checks if VRChat and SteamVR are currently running and updates the browser using JavaScript with the results.
        /// </summary>
        public override void CheckGameRunning()
        {
        }

        /// <summary>
        /// .NET's <see cref="Process.ProcessName"/> never includes the ".exe" suffix on
        /// native Windows — <c>GetProcessesByName("VRChat.exe")</c> can never match there,
        /// it always returns zero results. On Linux, a Wine-run VRChat.exe keeps the
        /// suffix in the OS process table, so that's still the right name there. Found
        /// live (2026-08-17): the "game" status indicator and GameLog tailing stayed dead
        /// on Windows even with VRChat.exe confirmed running in Task Manager — this method
        /// (and <see cref="QuitGame"/>, which has the same bug) was written Linux-only and
        /// never OS-branched, unlike <see cref="StartGame"/>.
        /// </summary>
        private static string GetVrChatProcessName()
        {
            return RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "VRChat" : "VRChat.exe";
        }

        public override bool IsGameRunning()
        {
            var processes = Process.GetProcessesByName(GetVrChatProcessName());
            var isGameRunning = processes.Length > 0;
            foreach (var process in processes)
                process.Dispose();

            return isGameRunning;
        }

        public override bool IsSteamVRRunning()
        {
            var processNames = new[] { "vrmonitor", "monado-service" };
            foreach (var name in processNames)
            {
                var processes = Process.GetProcessesByName(name);
                var isSteamVRRunning = processes.Length > 0;
                foreach (var process in processes)
                    process.Dispose();

                if (isSteamVRRunning)
                    return true;
            }

            // Check for wivrn-server (requires full scan)
            var allProcesses = Process.GetProcesses();
            var isRunning = allProcesses.Any(process => process.ProcessName.EndsWith("wivrn-server"));
            foreach (var process in allProcesses)
                process.Dispose();

            return isRunning;
        }

        public override int QuitGame()
        {
            var processes = Process.GetProcessesByName(GetVrChatProcessName());
            if (processes.Length == 1)
                processes[0].Kill();
            foreach (var process in processes)
                process.Dispose();

            return processes.Length;
        }

        public override bool StartGame(string arguments)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                return StartGameWindows(arguments);

            return StartGameLinux(arguments);
        }

        /// <summary>
        /// The Electron client's native layer (this file, `Folders.cs`) was written
        /// Linux-only end to end, but the Electron *shell* itself runs unmodified on
        /// Windows too (the same headless-server connection code applies there) — so a
        /// Windows user pointed at a self-hosted server hits real "can't find VRChat"
        /// failures with no Windows-aware detection at all. Mirrors
        /// `Dotnet/AppApi/Cef/GameHandler.cs`'s own registry-based lookup (the classic
        /// upstream Windows client), which is the one piece of this file's job that
        /// doesn't depend on any of the Linux-only Steam-library/Proton-prefix state
        /// `Folders.cs` computes at class load.
        /// </summary>
        private bool StartGameWindows(string arguments)
        {
            // try steam first
            try
            {
                using var key = Registry.ClassesRoot.OpenSubKey(@"steam\shell\open\command");
                // "C:\Program Files (x86)\Steam\steam.exe" -- "%1"
                var match = Regex.Match(key?.GetValue(string.Empty) as string ?? string.Empty, "^\"(.+?)\\\\steam.exe\"");
                if (match.Success)
                {
                    var path = match.Groups[1].Value;
                    Process.Start(new ProcessStartInfo
                    {
                        WorkingDirectory = path,
                        FileName = $"{path}\\steam.exe",
                        UseShellExecute = false,
                        Arguments = $"-applaunch 438100 {arguments}"
                    })?.Dispose();
                    return true;
                }
            }
            catch (Exception e)
            {
                logger.Warn($"Failed to start VRChat from Steam: {e.Message}");
            }

            // fallback
            try
            {
                using var key = Registry.ClassesRoot.OpenSubKey(@"VRChat\shell\open\command");
                // "C:\Program Files (x86)\Steam\steamapps\common\VRChat\launch.exe" "%1" %*
                var match = Regex.Match(key?.GetValue(string.Empty) as string ?? string.Empty, "(?!\")(.+?\\\\VRChat.*)(!?\\\\launch.exe\")");
                if (match.Success)
                {
                    var path = match.Groups[1].Value;
                    return StartGameFromPathWindows(path, arguments);
                }
            }
            catch (Exception e)
            {
                logger.Warn($"Failed to start VRChat from registry: {e.Message}");
            }

            return false;
        }

        private bool StartGameLinux(string arguments)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "steam",
                    Arguments = $"-applaunch 438100 {arguments}",
                    UseShellExecute = false,
                })?.Dispose();
                return true; // Steam accepted launch command (no exception thrown)
            }
            catch (Exception e)
            {
                logger.Error($"Failed to start VRChat: {e.Message}, attempting to start via Steam path.");
            }

            try
            {
                var steamPath = _steamPath;
                if (string.IsNullOrEmpty(steamPath))
                {
                    logger.Error("Steam path could not be determined.");
                    return false;
                }

                var steamExecutable = Path.Join(steamPath, "steam.sh");
                if (!File.Exists(steamExecutable))
                {
                    logger.Error("Steam executable not found.");
                    return false;
                }

                Process.Start(new ProcessStartInfo
                {
                    FileName = steamExecutable,
                    Arguments = $"-applaunch 438100 {arguments}",
                    UseShellExecute = false,
                })?.Dispose();

                return true;
            }
            catch (Exception ex)
            {
                logger.Error($"Failed to start VRChat: {ex.Message}");
                return false;
            }
        }

        public override bool StartGameFromPath(string path, string arguments)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                return StartGameFromPathWindows(path, arguments);

            // Linux: not used — `src/stores/launch.js`'s `vrcLaunchPathOverride` branch
            // is gated on `!LINUX`, which this build (`Dotnet/VRCX-Electron.csproj`'s
            // `DefineConstants` mirrors the JS `LINUX` global) never satisfies.
            return false;
        }

        private bool StartGameFromPathWindows(string path, string arguments)
        {
            if (!path.EndsWith(".exe"))
                path = Path.Join(path, "launch.exe");

            if (!path.EndsWith("launch.exe") || !File.Exists(path))
                return false;

            Process.Start(new ProcessStartInfo
            {
                WorkingDirectory = Path.GetDirectoryName(path),
                FileName = path,
                UseShellExecute = false,
                Arguments = arguments
            })?.Dispose();
            return true;
        }

        public override Task<bool> TryOpenInstanceInVrc(string launchUrl)
        {
            try
            {
                var pid = FindVRChatPid();
                if (pid <= 0)
                    return Task.FromResult(false);

                var launchExe = Path.Join(_vrcInstallPath, "launch.exe");
                if (!File.Exists(launchExe))
                {
                    logger.Error($"TryOpenInstanceInVrc: launch.exe not found at {launchExe}");
                    return Task.FromResult(false);
                }

                // attach=1 tells launch.exe to forward into the running client instead of cold-starting
                var url = launchUrl.Contains("attach=1") ? launchUrl : launchUrl + "&attach=1";

                // enter the running game's user + mount namespaces (we own the pressure-vessel
                // userns, so no privilege is required), re-import its environment, then run
                // launch.exe inside the container so it reaches VRChat's URL pipe
                const string inner =
                    "while IFS= read -r -d '' kv; do export \"$kv\"; done < \"/proc/$1/environ\"; exec wine \"$2\" \"$3\"";

                var psi = new ProcessStartInfo
                {
                    FileName = "nsenter",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                foreach (var arg in new[]
                         {
                             "-t", pid.ToString(), "-U", "-m", "--preserve-credentials", "--",
                             "/bin/bash", "-c", inner, "_", pid.ToString(), launchExe, url
                         })
                    psi.ArgumentList.Add(arg);

                // launch.exe hands the deeplink to the running client, then exits on wine's
                // own schedule and its exit code is not a reliable success signal, so a clean
                // spawn is treated as success. Gating on the exit code would race the frontend
                // self-invite fallback and fire both. stdout/stderr are left un-redirected so
                // wine log spam cannot fill an undrained pipe and stall the forward.
                using var process = Process.Start(psi);
                return Task.FromResult(process != null);
            }
            catch (Exception e)
            {
                logger.Error($"TryOpenInstanceInVrc failed: {e.Message}");
                return Task.FromResult(false);
            }
        }

        private static int FindVRChatPid()
        {
            var processes = Process.GetProcessesByName("VRChat.exe");
            try
            {
                // prefer the VRChat whose environment points at the 438100 compat prefix
                foreach (var process in processes)
                {
                    try
                    {
                        var environ = File.ReadAllText($"/proc/{process.Id}/environ");
                        if (environ.Contains("compatdata/438100"))
                            return process.Id;
                    }
                    catch
                    {
                        // unreadable environ, skip
                    }
                }

                return processes.Length > 0 ? processes[0].Id : -1;
            }
            finally
            {
                foreach (var process in processes)
                    process.Dispose();
            }
        }
    }
}

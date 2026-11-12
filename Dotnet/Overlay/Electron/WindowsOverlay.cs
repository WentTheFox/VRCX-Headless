using System;
using System.Runtime.InteropServices;

namespace VRCX
{
    /// <summary>
    /// Fork-only (CLAUDE.md §5): the Windows half of the Electron VR overlay's frame transport. Upstream's overlay
    /// is Linux-only (frames in a /dev/shm file). On Windows, Electron's main process runs .NET in-process
    /// (node-api-dotnet), so each paint is handed over directly (<c>OverlayFrameSinkElectron.Submit</c>) and
    /// parked here until the overlay thread takes it: no file I/O, which matters because the overlay repaints at up
    /// to 48 fps and a frame is 6 MB. Upload then goes through the same OpenGL texture path as on Linux, on a WGL
    /// context (<see cref="GLContextWindows"/>). Free of OpenVR and Electron types so it can be unit tested
    /// (<c>tests/dotnet</c>).
    /// </summary>
    public sealed class OverlayFrameMailbox
    {
        private readonly object _lock = new object();
        private readonly byte[] _frame;
        private bool _ready;

        public OverlayFrameMailbox(int frameSize)
        {
            _frame = new byte[frameSize];
        }

        public int FrameSize => _frame.Length;

        /// <summary>Stores the newest frame, replacing one not taken yet. Returns false for a short buffer.</summary>
        public bool Post(ReadOnlySpan<byte> frame)
        {
            if (frame.Length < _frame.Length)
                return false;
            lock (_lock)
            {
                frame[.._frame.Length].CopyTo(_frame);
                _ready = true;
            }

            return true;
        }

        /// <summary>Copies the newest frame into <paramref name="destination"/> if one arrived since the last take.</summary>
        public bool TryTake(byte[] destination)
        {
            if (destination == null) throw new ArgumentNullException(nameof(destination));
            if (destination.Length < _frame.Length)
                throw new ArgumentException("Destination is smaller than a frame.", nameof(destination));
            lock (_lock)
            {
                if (!_ready)
                    return false;
                Buffer.BlockCopy(_frame, 0, destination, 0, _frame.Length);
                _ready = false;
                return true;
            }
        }
    }

    /// <summary>Windows counters for <see cref="SystemMonitorElectron"/> (the Linux ones read /proc).</summary>
    public static class WindowsSystemTimes
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime
        {
            public uint Low;
            public uint High;

            public long Value => ((long)High << 32) | Low;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user);

        /// <summary>
        /// GetSystemTimes' kernel time already includes idle time, so busy time is kernel + user - idle and
        /// the total is kernel + user. Returns the same (total, idle) pair the Linux /proc/stat reader does.
        /// </summary>
        public static (long TotalTime, long IdleTime) ToTotalAndIdle(long idle, long kernel, long user)
        {
            return (kernel + user, idle);
        }

        public static (long TotalTime, long IdleTime)? Read()
        {
            if (!GetSystemTimes(out var idle, out var kernel, out var user))
                return null;

            return ToTotalAndIdle(idle.Value, kernel.Value, user.Value);
        }

        /// <summary>Milliseconds since boot, as the Linux reader gets from /proc/uptime.</summary>
        public static double UptimeMilliseconds() => Environment.TickCount64;
    }
}

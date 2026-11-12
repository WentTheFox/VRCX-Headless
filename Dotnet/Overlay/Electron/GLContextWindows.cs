using System;
using System.Reflection;
using System.Runtime.InteropServices;

/// <summary>
/// Native-Windows counterpart of <see cref="GLContextX11"/>/<see cref="GLContextWayland"/>: a WGL context on a
/// hidden 1x1 window, current on the overlay thread, so <see cref="GLTextureWriter"/> can create the OpenGL
/// texture handed to SteamVR (ETextureType.OpenGL works on Windows too). GLTextureWriter only uses OpenGL 1.1
/// entry points, which opengl32.dll exports directly; <see cref="Initialise"/> maps its "libGL.so.1" imports there.
/// Must be called from the thread that later uploads textures and calls SetOverlayTexture.
/// </summary>
public static class GLContextWindows
{
    private const uint WS_POPUP = 0x80000000;
    private const uint PFD_DRAW_TO_WINDOW = 0x00000004;
    private const uint PFD_SUPPORT_OPENGL = 0x00000020;
    private const uint PFD_DOUBLEBUFFER = 0x00000001;
    private const byte PFD_TYPE_RGBA = 0;
    private const byte PFD_MAIN_PLANE = 0;
    private const uint PM_REMOVE = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    private struct PIXELFORMATDESCRIPTOR
    {
        public ushort nSize;
        public ushort nVersion;
        public uint dwFlags;
        public byte iPixelType;
        public byte cColorBits;
        public byte cRedBits, cRedShift, cGreenBits, cGreenShift, cBlueBits, cBlueShift;
        public byte cAlphaBits, cAlphaShift;
        public byte cAccumBits, cAccumRedBits, cAccumGreenBits, cAccumBlueBits, cAccumAlphaBits;
        public byte cDepthBits;
        public byte cStencilBits;
        public byte cAuxBuffers;
        public byte iLayerType;
        public byte bReserved;
        public uint dwLayerMask, dwVisibleMask, dwDamageMask;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX, ptY;
        public uint lPrivate;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("user32.dll")]
    private static extern bool PeekMessageW(out MSG msg, IntPtr hWnd, uint filterMin, uint filterMax, uint remove);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessageW(ref MSG msg);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string moduleName);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int ChoosePixelFormat(IntPtr hdc, ref PIXELFORMATDESCRIPTOR pfd);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool SetPixelFormat(IntPtr hdc, int format, ref PIXELFORMATDESCRIPTOR pfd);

    [DllImport("opengl32.dll", SetLastError = true)]
    private static extern IntPtr wglCreateContext(IntPtr hdc);

    [DllImport("opengl32.dll", SetLastError = true)]
    private static extern bool wglMakeCurrent(IntPtr hdc, IntPtr hglrc);

    [DllImport("opengl32.dll")]
    private static extern bool wglDeleteContext(IntPtr hglrc);

    private static readonly object ResolverLock = new object();
    private static bool _resolverRegistered;

    private static IntPtr _window;
    private static IntPtr _dc;
    private static IntPtr _context;

    private static void RegisterGlResolver()
    {
        lock (ResolverLock)
        {
            if (_resolverRegistered)
                return;
            NativeLibrary.SetDllImportResolver(typeof(GLContextWindows).Assembly, ResolveGl);
            _resolverRegistered = true;
        }
    }

    private static IntPtr ResolveGl(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (OperatingSystem.IsWindows() && libraryName == "libGL.so.1")
            return NativeLibrary.Load("opengl32.dll", assembly, searchPath);
        return IntPtr.Zero; // default probing for everything else
    }

    public static bool Initialise()
    {
        if (!OperatingSystem.IsWindows())
            return false;

        if (_context != IntPtr.Zero)
            return wglMakeCurrent(_dc, _context);

        try
        {
            RegisterGlResolver();

            // never shown; the overlay thread pumps its messages (PumpMessages) so it can't stall broadcasts
            _window = CreateWindowExW(0, "STATIC", "VRCX overlay GL", WS_POPUP, 0, 0, 1, 1,
                IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
            if (_window == IntPtr.Zero)
            {
                Console.WriteLine($"GLContextWindows: CreateWindowEx failed ({Marshal.GetLastWin32Error()})");
                return false;
            }

            _dc = GetDC(_window);
            var pfd = new PIXELFORMATDESCRIPTOR
            {
                nSize = (ushort)Marshal.SizeOf<PIXELFORMATDESCRIPTOR>(),
                nVersion = 1,
                dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
                iPixelType = PFD_TYPE_RGBA,
                cColorBits = 32,
                cAlphaBits = 8,
                cDepthBits = 24,
                iLayerType = PFD_MAIN_PLANE
            };
            var format = ChoosePixelFormat(_dc, ref pfd);
            if (format == 0 || !SetPixelFormat(_dc, format, ref pfd))
            {
                Console.WriteLine($"GLContextWindows: pixel format failed ({Marshal.GetLastWin32Error()})");
                Cleanup();
                return false;
            }

            _context = wglCreateContext(_dc);
            if (_context == IntPtr.Zero || !wglMakeCurrent(_dc, _context))
            {
                Console.WriteLine($"GLContextWindows: WGL context failed ({Marshal.GetLastWin32Error()})");
                Cleanup();
                return false;
            }

            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"GLContextWindows: {ex.Message}");
            Cleanup();
            return false;
        }
    }

    /// <summary>Drain the hidden window's message queue; call from the thread that created the context.</summary>
    public static void PumpMessages()
    {
        if (_window == IntPtr.Zero)
            return;
        while (PeekMessageW(out var msg, IntPtr.Zero, 0, 0, PM_REMOVE))
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
    }

    public static void Cleanup()
    {
        if (!OperatingSystem.IsWindows())
            return;

        if (_context != IntPtr.Zero)
        {
            wglMakeCurrent(IntPtr.Zero, IntPtr.Zero);
            wglDeleteContext(_context);
            _context = IntPtr.Zero;
        }

        if (_dc != IntPtr.Zero)
        {
            ReleaseDC(_window, _dc);
            _dc = IntPtr.Zero;
        }

        if (_window != IntPtr.Zero)
        {
            DestroyWindow(_window);
            _window = IntPtr.Zero;
        }
    }
}

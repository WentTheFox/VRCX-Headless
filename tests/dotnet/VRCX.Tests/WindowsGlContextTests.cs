using System;
using Valve.VR;
using Xunit;

namespace VRCX.Tests
{
    /// <summary>
    /// The Windows overlay uploads frames as an OpenGL texture on a WGL context (GLContextWindows) instead of
    /// SetOverlayRaw. Hosted Windows runners have no GPU but ship Microsoft's software OpenGL 1.1, which is all
    /// GLTextureWriter uses, so this exercises the real WGL setup, the libGL.so.1 -> opengl32.dll import remap
    /// and a full-size texture upload. It can't prove SteamVR accepts the texture; that still needs a headset.
    /// The context is thread-affine and static, so the tests share one collection and never run in parallel.
    /// </summary>
    [Collection("WGL")]
    public class WindowsGlContextTests
    {
        private const int Width = 1024;
        private const int Height = 1536;

        [Fact]
        public void Initialise_is_false_off_Windows()
        {
            if (OperatingSystem.IsWindows())
                return;

            Assert.False(GLContextWindows.Initialise());
            GLContextWindows.PumpMessages(); // no window, must be a no-op
            GLContextWindows.Cleanup();
        }

        [WindowsFact]
        public void Creates_a_context_and_uploads_a_full_size_frame()
        {
            Assert.True(GLContextWindows.Initialise(), "WGL context should be created");
            try
            {
                Assert.True(GLContextWindows.Initialise(), "a second call re-uses the context");

                using var writer = new GLTextureWriter(Width, Height);
                var frame = new byte[Width * Height * 4];
                for (var i = 0; i < frame.Length; i++)
                    frame[i] = (byte)i;

                writer.WriteImageToBuffer(frame);
                writer.UpdateTexture();

                var texture = writer.AsTextureT();
                Assert.NotEqual(IntPtr.Zero, texture.handle);
                Assert.Equal(ETextureType.OpenGL, texture.eType);

                GLContextWindows.PumpMessages();
            }
            finally
            {
                GLContextWindows.Cleanup();
            }
        }

        [WindowsFact]
        public void Can_be_torn_down_and_recreated()
        {
            // SteamVR restarting makes the overlay thread initialise again
            for (var i = 0; i < 2; i++)
            {
                Assert.True(GLContextWindows.Initialise());
                using var writer = new GLTextureWriter(16, 16);
                writer.UpdateTexture();
                Assert.NotEqual(IntPtr.Zero, writer.AsTextureT().handle);
                GLContextWindows.Cleanup();
            }
        }

        [WindowsFact]
        public void Rejects_a_frame_of_the_wrong_size()
        {
            Assert.True(GLContextWindows.Initialise());
            try
            {
                using var writer = new GLTextureWriter(16, 16);
                Assert.Throws<ArgumentException>(() => writer.WriteImageToBuffer(new byte[10]));
            }
            finally
            {
                GLContextWindows.Cleanup();
            }
        }
    }
}

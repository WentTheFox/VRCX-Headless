using System;

namespace VRCX
{
    /// <summary>
    /// Entry point for Electron's main process (src-electron/main.js, via node-api-dotnet in the same process) to
    /// hand the offscreen overlay window's BGRA paint bitmap to the VR overlay thread on native Windows.
    /// <para>
    /// JS registers one long-lived Buffer once (<see cref="SetSharedBuffer"/>), then per frame copies the bitmap
    /// into it and calls <see cref="Commit"/>, which takes no arguments. Do not pass a fresh Buffer per frame:
    /// each JS typed array marshalled to <c>Memory&lt;byte&gt;</c> holds a reference that keeps the JS buffer
    /// alive until .NET finalizes it, and the overlay allocates so little managed memory that the GC hardly runs.
    /// That leaked a 6 MB frame per repaint (13 GB in 20 minutes, then "RangeError: Failed to allocate memory").
    /// </para>
    /// </summary>
    public class OverlayFrameSinkElectron
    {
        // The single JS-backed buffer; deliberately kept for the app's lifetime. Only touched on the JS thread.
        private static Memory<byte> _shared;

        public void SetSharedBuffer(Memory<byte> buffer)
        {
            _shared = buffer;
        }

        public void Commit()
        {
            VRCXVRElectron.FrameMailbox.Post(_shared.Span);
        }
    }
}

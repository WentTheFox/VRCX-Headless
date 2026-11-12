using System;
using Xunit;

namespace VRCX.Tests
{
    public class OverlayFrameTests
    {
        [Fact]
        public void Mailbox_is_empty_until_a_frame_is_posted()
        {
            var mailbox = new OverlayFrameMailbox(4);
            Assert.False(mailbox.TryTake(new byte[4]));
        }

        [Fact]
        public void Mailbox_hands_a_frame_over_once()
        {
            var mailbox = new OverlayFrameMailbox(4);
            Assert.True(mailbox.Post(new byte[] { 1, 2, 3, 4 }));

            var dest = new byte[4];
            Assert.True(mailbox.TryTake(dest));
            Assert.Equal(new byte[] { 1, 2, 3, 4 }, dest);
            Assert.False(mailbox.TryTake(dest)); // already taken
        }

        [Fact]
        public void Mailbox_keeps_only_the_newest_frame()
        {
            var mailbox = new OverlayFrameMailbox(2);
            mailbox.Post(new byte[] { 1, 1 });
            mailbox.Post(new byte[] { 2, 2 });

            var dest = new byte[2];
            Assert.True(mailbox.TryTake(dest));
            Assert.Equal(new byte[] { 2, 2 }, dest);
        }

        [Fact]
        public void Mailbox_rejects_a_short_frame_and_ignores_extra_bytes()
        {
            var mailbox = new OverlayFrameMailbox(4);
            Assert.False(mailbox.Post(new byte[3]));
            Assert.True(mailbox.Post(new byte[] { 1, 2, 3, 4, 5, 6 }));

            var dest = new byte[4];
            Assert.True(mailbox.TryTake(dest));
            Assert.Equal(new byte[] { 1, 2, 3, 4 }, dest);
        }

        [Fact]
        public void Mailbox_rejects_a_destination_smaller_than_a_frame()
        {
            var mailbox = new OverlayFrameMailbox(4);
            Assert.Throws<ArgumentException>(() => mailbox.TryTake(new byte[3]));
        }

        [Fact]
        public void SystemTimes_total_is_kernel_plus_user_because_kernel_includes_idle()
        {
            var (total, idle) = WindowsSystemTimes.ToTotalAndIdle(idle: 100, kernel: 300, user: 200);
            Assert.Equal(500, total);
            Assert.Equal(100, idle);
        }

        [Fact]
        public void SystemTimes_uptime_is_positive_and_in_milliseconds()
        {
            Assert.True(WindowsSystemTimes.UptimeMilliseconds() > 0);
        }

        [WindowsFact]
        public void SystemTimes_read_returns_a_sane_cpu_snapshot_on_windows()
        {
            var times = WindowsSystemTimes.Read();
            Assert.NotNull(times);
            Assert.True(times.Value.TotalTime > 0);
            Assert.InRange(times.Value.IdleTime, 0, times.Value.TotalTime);
        }
    }
}

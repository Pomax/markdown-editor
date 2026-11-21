//! Pictures of the screen, from the portal session's stream.
//!
//! The stream is of the whole monitor, so a picture of a window is a picture
//! of the monitor with the window's place cut out of it: whatever is on top
//! of the window is in it.
//!
//! GStreamer reads the stream. The portal hands over a connection to
//! PipeWire as a file descriptor, and `pipewiresrc` is given that descriptor
//! and the stream's node.

use std::os::fd::{AsRawFd, OwnedFd};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use super::Rect;
use super::portal::Portal;

/// How long one picture of the monitor may take to arrive.
const ONE_FRAME: Duration = Duration::from_secs(5);

/// A connection to the stream that a program started from here can use.
///
/// A descriptor is closed in a program that is started unless it is marked to
/// be kept, so it is marked. It keeps its number in the new program, which is
/// how `pipewiresrc` is told which one it is.
fn stream(portal: &Portal) -> Result<(OwnedFd, String), String> {
    let fd = portal.pipewire()?;
    let raw = fd.as_raw_fd();
    let kept = unsafe {
        let flags = libc::fcntl(raw, libc::F_GETFD);
        flags >= 0 && libc::fcntl(raw, libc::F_SETFD, flags & !libc::FD_CLOEXEC) >= 0
    };
    if !kept {
        return Err("the screen stream could not be handed to its reader".to_string());
    }
    let source = format!("fd={raw}");
    Ok((fd, source))
}

/// One picture of the whole monitor, written as a PNG.
pub fn frame(portal: &Portal, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let (fd, source) = stream(portal)?;
    let mut reader = Command::new("gst-launch-1.0")
        .arg("-q")
        .args([
            "pipewiresrc",
            &source,
            &format!("path={}", portal.node()),
            "num-buffers=1",
        ])
        .args(["!", "videoconvert", "!", "pngenc", "!", "filesink"])
        .arg(format!("location={}", to.display()))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("running gst-launch-1.0, which reads the screen: {e}"))?;
    drop(fd);

    let deadline = Instant::now() + ONE_FRAME;
    loop {
        match reader.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let said = reader
                    .wait_with_output()
                    .map(|out| String::from_utf8_lossy(&out.stderr).trim().to_string())
                    .unwrap_or_default();
                return Err(format!("the screen could not be read: {said}"));
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = reader.kill();
                let _ = reader.wait();
                return Err(format!(
                    "the screen stream gave no picture within {} seconds",
                    ONE_FRAME.as_secs()
                ));
            }
            Ok(None) => sleep(Duration::from_millis(10)),
            Err(e) => return Err(format!("waiting for the screen's reader: {e}")),
        }
    }
}

/// Where a part of the desktop is in a picture of the monitor, in the
/// picture's own pixels: left, top, width, height.
///
/// `monitor` is the monitor's place and size in the desktop's units, and
/// `frame` the size of a picture of it. The two need not be the same size: a
/// monitor drawn at twice the scale has pictures twice the size. Whatever of
/// the area is off the monitor is not in the picture and is left out.
pub fn cut(area: Rect, monitor: (i32, i32, i32, i32), frame: (u32, u32)) -> (u32, u32, u32, u32) {
    let scale = frame.0 as f64 / monitor.2.max(1) as f64;
    let edge =
        |at: i32, limit: u32| -> u32 { ((at as f64 * scale).round().max(0.0) as u32).min(limit) };
    let left = edge(area.x - monitor.0, frame.0);
    let top = edge(area.y - monitor.1, frame.1);
    let right = edge(area.x - monitor.0 + area.width, frame.0);
    let bottom = edge(area.y - monitor.1 + area.height, frame.1);
    (
        left,
        top,
        right.saturating_sub(left),
        bottom.saturating_sub(top),
    )
}

/// Photograph the screen where `area` is.
pub fn shot(portal: &Portal, area: Rect, to: &Path) -> Result<(), String> {
    let whole = to.with_extension("monitor.png");
    frame(portal, &whole)?;
    let picture =
        image::open(&whole).map_err(|e| format!("the picture of the screen does not open: {e}"))?;
    let _ = std::fs::remove_file(&whole);

    let (left, top, width, height) =
        cut(area, portal.monitor(), (picture.width(), picture.height()));
    if width == 0 || height == 0 {
        return Err(format!(
            "nothing of {},{} {}x{} is on the monitor to photograph",
            area.x, area.y, area.width, area.height
        ));
    }
    picture
        .crop_imm(left, top, width, height)
        .save(to)
        .map_err(|e| format!("writing {}: {e}", to.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: (i32, i32, i32, i32) = (0, 0, 1920, 1080);

    #[test]
    fn a_region_is_cut_out_at_the_frames_scale() {
        let window = Rect {
            x: 543,
            y: 215,
            width: 900,
            height: 683,
        };

        // A picture the size of the monitor: the window is where it is.
        assert_eq!(cut(window, MONITOR, (1920, 1080)), (543, 215, 900, 683));
        // A picture twice the size: everything is twice as far in, and twice
        // as big.
        assert_eq!(cut(window, MONITOR, (3840, 2160)), (1086, 430, 1800, 1366));
        // A monitor that is not at the desktop's origin: the picture starts
        // where the monitor does.
        assert_eq!(
            cut(window, (500, 200, 1920, 1080), (1920, 1080)),
            (43, 15, 900, 683)
        );
    }

    #[test]
    fn a_region_hanging_off_the_monitor_is_clamped() {
        let over_the_top_left = Rect {
            x: -10,
            y: -20,
            width: 100,
            height: 100,
        };
        assert_eq!(
            cut(over_the_top_left, MONITOR, (1920, 1080)),
            (0, 0, 90, 80)
        );

        let over_the_bottom_right = Rect {
            x: 1900,
            y: 1060,
            width: 100,
            height: 100,
        };
        assert_eq!(
            cut(over_the_bottom_right, MONITOR, (1920, 1080)),
            (1900, 1060, 20, 20)
        );

        let off_it = Rect {
            x: 2000,
            y: 100,
            width: 50,
            height: 50,
        };
        let (_, _, width, _) = cut(off_it, MONITOR, (1920, 1080));
        assert_eq!(width, 0);
    }
}

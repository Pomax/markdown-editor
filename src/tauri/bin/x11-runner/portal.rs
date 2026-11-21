//! The desktop portal session a run's input and pictures go through.
//!
//! One session carries both. Keys and pointer moves are handed to the desktop
//! through the RemoteDesktop interface, and the desktop delivers them with its
//! own keyboard focus and pointer, the way `SendInput` and `CGEvent` posting
//! do on the other platforms. The screen is read from the ScreenCast stream
//! of the same session.
//!
//! The desktop asks the person at the machine before it allows either. It
//! hands back a token with its answer, and a session started with that token
//! is allowed without asking again.

use std::future::Future;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ashpd::desktop::remote_desktop::{DeviceType, KeyState, RemoteDesktop};
use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};
use ashpd::desktop::{PersistMode, Session};

/// How long the desktop is given to answer, which is how long the person at
/// the machine has to answer its dialog.
const PATIENCE: Duration = Duration::from_secs(200);

/// The kernel's input event code of an X button number: 1 is the left
/// button, 2 the middle one and 3 the right one.
fn button_code(number: u8) -> Result<i32, String> {
    match number {
        1 => Ok(0x110),
        2 => Ok(0x112),
        3 => Ok(0x111),
        _ => Err(format!("no button {number}")),
    }
}

pub struct Portal {
    remote: RemoteDesktop<'static>,
    screencast: Screencast<'static>,
    session: Session<'static, RemoteDesktop<'static>>,
    /// The PipeWire node the monitor's pictures arrive on.
    node: u32,
    /// Where the monitor is in the desktop, and how big, in the units the
    /// desktop lays windows out in.
    position: (i32, i32),
    size: (i32, i32),
}

impl Portal {
    /// Open the session, asking the desktop for the keyboard, the pointer and
    /// the screen.
    ///
    /// `cache` is where the token from the last answer is kept.
    pub fn open(cache: &Path) -> Result<Portal, String> {
        let kept = cache.join("portal-token");
        let token = std::fs::read_to_string(&kept)
            .ok()
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty());

        eprintln!(
            "portal: asking the desktop for the keyboard, the pointer and the screen. \
             If it puts up a dialog, allow it: the run carries on by itself"
        );
        let asked = Instant::now();
        // On a thread of its own, so that an answer that never comes can be
        // given up on.
        let (answer, answered) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = answer.send(pollster::block_on(connect(token)));
        });
        let (portal, token) = answered.recv_timeout(PATIENCE).map_err(|_| {
            format!(
                "the desktop did not answer within {} seconds, so no UI test can run",
                PATIENCE.as_secs()
            )
        })??;
        eprintln!(
            "portal: answered after {:.1} seconds",
            asked.elapsed().as_secs_f64()
        );

        if let Some(token) = token {
            let _ = std::fs::create_dir_all(cache);
            std::fs::write(&kept, token).map_err(|e| format!("writing {}: {e}", kept.display()))?;
        }
        Ok(portal)
    }

    pub fn node(&self) -> u32 {
        self.node
    }

    /// The monitor's place and size: x, y, width, height.
    pub fn monitor(&self) -> (i32, i32, i32, i32) {
        (self.position.0, self.position.1, self.size.0, self.size.1)
    }

    fn wait<T>(
        &self,
        what: &str,
        call: impl Future<Output = ashpd::Result<T>>,
    ) -> Result<T, String> {
        pollster::block_on(call).map_err(|e| format!("{what}: {e}"))
    }

    /// Put the pointer at a place on the desktop.
    pub fn pointer_to(&self, x: f64, y: f64) -> Result<(), String> {
        self.wait(
            "moving the pointer",
            self.remote.notify_pointer_motion_absolute(
                &self.session,
                self.node,
                x - self.position.0 as f64,
                y - self.position.1 as f64,
            ),
        )
    }

    /// Press or release a mouse button, by its X button number.
    pub fn button(&self, number: u8, pressed: bool) -> Result<(), String> {
        let button = button_code(number)?;
        self.wait(
            "pressing the mouse button",
            self.remote
                .notify_pointer_button(&self.session, button, state(pressed)),
        )
    }

    /// Press or release the key that produces `keysym`.
    pub fn key(&self, keysym: u32, pressed: bool) -> Result<(), String> {
        self.wait(
            "pressing a key",
            self.remote
                .notify_keyboard_keysym(&self.session, keysym as i32, state(pressed)),
        )
    }

    /// A connection to PipeWire that the session's stream can be read on.
    pub fn pipewire(&self) -> Result<OwnedFd, String> {
        self.wait(
            "opening the screen stream",
            self.screencast.open_pipe_wire_remote(&self.session),
        )
    }
}

fn state(pressed: bool) -> KeyState {
    if pressed {
        KeyState::Pressed
    } else {
        KeyState::Released
    }
}

async fn connect(token: Option<String>) -> Result<(Portal, Option<String>), String> {
    let no_portal = |e: ashpd::Error| {
        format!("the desktop portal is not there to ask, so no UI test can run: {e}")
    };
    let refused = |e: ashpd::Error| {
        format!(
            "the desktop did not allow the keyboard, the pointer and the screen, \
             so no UI test can run: {e}"
        )
    };

    let remote = RemoteDesktop::new().await.map_err(no_portal)?;
    let screencast = Screencast::new().await.map_err(no_portal)?;
    let session = remote.create_session().await.map_err(no_portal)?;

    // The answer is remembered through the devices alone. A session that
    // carries both may not ask for the screen to be remembered as well.
    remote
        .select_devices(
            &session,
            DeviceType::Keyboard | DeviceType::Pointer,
            token.as_deref(),
            PersistMode::ExplicitlyRevoked,
        )
        .await
        .and_then(|request| request.response())
        .map_err(refused)?;
    screencast
        .select_sources(
            &session,
            CursorMode::Hidden,
            SourceType::Monitor.into(),
            false,
            None,
            PersistMode::DoNot,
        )
        .await
        .and_then(|request| request.response())
        .map_err(refused)?;

    let granted = remote
        .start(&session, None)
        .await
        .and_then(|request| request.response())
        .map_err(refused)?;

    let devices = granted.devices();
    if !devices.contains(DeviceType::Keyboard) || !devices.contains(DeviceType::Pointer) {
        return Err(
            "the desktop allowed less than the keyboard and the pointer, so no UI test can run"
                .to_string(),
        );
    }
    let stream = granted
        .streams()
        .and_then(|streams| streams.first())
        .ok_or("the desktop allowed no monitor to be read, so no UI test can run")?;
    let size = stream
        .size()
        .ok_or("the desktop did not say how big its monitor is")?;

    let token = granted.restore_token().map(str::to_string);
    let portal = Portal {
        node: stream.pipe_wire_node_id(),
        position: stream.position().unwrap_or((0, 0)),
        size,
        remote,
        screencast,
        session,
    };
    Ok((portal, token))
}

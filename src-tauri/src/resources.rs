use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub struct ResourceState {
    pub low_memory: AtomicBool,
    pub input: Mutex<super::InputSignal>,
    gate: Mutex<KeyGate>,
}

impl Default for ResourceState {
    fn default() -> Self {
        let mut gate = KeyGate::default();
        Self {
            low_memory: AtomicBool::new(false),
            input: Mutex::new(gated_input_sample(&mut gate)),
            gate: Mutex::new(gate),
        }
    }
}

/// Key presses made while a password field has focus (macOS Secure Event
/// Input) are left out of the count the webview sees: neither how many nor
/// when. The replay recording, the statistics and the typing paw all read
/// that count, so none of them can give away a password's length or rhythm.
#[derive(Default)]
pub struct KeyGate {
    last_raw: Option<u64>,
    hidden: u64,
    was_secure: bool,
}

impl KeyGate {
    /// The key count to show for the system's `raw` count.
    pub fn pass(&mut self, raw: u64, secure: bool) -> u64 {
        let previous = self.last_raw.unwrap_or(raw);
        // Secure input at either end of the interval hides what was pressed in it.
        if secure || self.was_secure {
            self.hidden = self.hidden.saturating_add(raw.saturating_sub(previous));
        }
        self.last_raw = Some(raw);
        self.was_secure = secure;
        raw.saturating_sub(self.hidden)
    }
}

fn gated_input_sample(gate: &mut KeyGate) -> super::InputSignal {
    let mut signal = super::platform::input_sample();
    let secure = super::live::secure_input_active();
    signal.keyboard_sequence = gate.pass(signal.keyboard_sequence, secure);
    if secure && signal.recent_kind == "keyboard" {
        signal.recent_kind = "none";
    }
    signal
}

pub fn sample_delay(low_memory: bool, quiet_ms: u128) -> Duration {
    Duration::from_millis(if low_memory {
        250
    } else if quiet_ms >= 2_000 {
        50
    } else {
        16
    })
}

pub fn start_input_monitor(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut changed_at = Instant::now();
        loop {
            let state = app.state::<ResourceState>();
            let next = gated_input_sample(
                &mut state.gate.lock().unwrap_or_else(|error| error.into_inner()),
            );
            let changed = {
                let mut current = state
                    .input
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let changed = current.keyboard_sequence != next.keyboard_sequence
                    || current.pointer_sequence != next.pointer_sequence
                    || current.pointer_click_sequence != next.pointer_click_sequence;
                *current = next.clone();
                changed
            };
            if changed {
                changed_at = Instant::now();
                let _ = app.emit_to("main", "mewlink-input", next);
            }
            std::thread::sleep(sample_delay(
                state.low_memory.load(Ordering::Relaxed),
                changed_at.elapsed().as_millis(),
            ));
        }
    });
}

#[tauri::command]
pub async fn set_low_memory_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ResourceState>,
    low_memory: bool,
) -> Result<(), String> {
    state.low_memory.store(low_memory, Ordering::Relaxed);
    #[cfg(target_os = "windows")]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        window
            .with_webview(move |webview| {
                let result = (|| unsafe {
                    let core = webview.controller().CoreWebView2()?;
                    let advanced = core.cast::<ICoreWebView2_19>()?;
                    advanced.SetMemoryUsageTargetLevel(if low_memory {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    })
                })()
                .map_err(|error: windows_core::Error| error.to_string());
                let _ = sender.try_send(result);
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .await
            .ok_or("WebView memory request cancelled")?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_input_stays_responsive_and_quiet_input_backs_off() {
        assert_eq!(sample_delay(false, 0).as_millis(), 16);
        assert_eq!(sample_delay(false, 2_000).as_millis(), 50);
        assert_eq!(sample_delay(true, 0).as_millis(), 250);
    }

    #[test]
    fn keys_pressed_in_a_password_field_are_never_counted() {
        let mut gate = KeyGate::default();
        // Counting starts from wherever the system's counter is.
        assert_eq!(gate.pass(1_000, false), 1_000);
        assert_eq!(gate.pass(1_005, false), 1_005);
        // A password field takes focus: its 8 keys, and the Return that leaves it, stay hidden.
        assert_eq!(gate.pass(1_005, true), 1_005);
        assert_eq!(gate.pass(1_009, true), 1_005);
        assert_eq!(gate.pass(1_013, true), 1_005);
        assert_eq!(gate.pass(1_014, false), 1_005);
        // Typing afterwards counts again, from where it left off.
        assert_eq!(gate.pass(1_017, false), 1_008);
        // If the system's counter starts over, later keys still count one for one
        // (the webview ignores the step back).
        assert_eq!(gate.pass(10, false), 1);
        assert_eq!(gate.pass(12, false), 3);
    }
}

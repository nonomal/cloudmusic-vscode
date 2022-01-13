use {
    neon::prelude::*,
    souvlaki::{
        MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition,
        PlatformConfig,
    },
    std::{
        cell::RefCell,
        ffi::c_void,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    },
};

static ACCESSABLE: AtomicBool = AtomicBool::new(true);

pub struct MediaSession {
    controls: MediaControls,
}

impl Finalize for MediaSession {}

impl MediaSession {
    #[inline]
    fn new(
        #[cfg(all(
            target_os = "windows",
            any(target_arch = "x86_64", target_arch = "x86")
        ))]
        hwnd: String,
        #[cfg(not(all(
            target_os = "windows",
            any(target_arch = "x86_64", target_arch = "x86")
        )))]
        _hwnd: String,
    ) -> Self {
        const TITLE: &str = "Cloudmusic VSCode";

        #[cfg(all(
            target_os = "windows",
            any(target_arch = "x86_64", target_arch = "x86")
        ))]
        fn fallback() -> Option<*mut c_void> {
            use {
                raw_window_handle::{HasRawWindowHandle, RawWindowHandle},
                winit::{event_loop::EventLoop, window::WindowBuilder},
            };
            match WindowBuilder::new()
                .with_title(TITLE)
                .with_visible(false)
                .with_transparent(true)
                .with_decorations(false)
                .build(&EventLoop::new())
                .unwrap()
                .raw_window_handle()
            {
                RawWindowHandle::Win32(han) => Some(han.hwnd),
                _ => panic!("No hwnd was found! Try to use wasm mode."),
            }
        }
        #[cfg(not(all(
            target_os = "windows",
            any(target_arch = "x86_64", target_arch = "x86")
        )))]
        fn fallback() -> Option<*mut c_void> {
            None
        }

        let hwnd = {
            #[cfg(target_os = "windows")]
            {
                #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
                {
                    match hwnd.is_empty() {
                        true => fallback(),
                        false => Some(hwnd.parse::<u64>().unwrap() as _),
                    }
                }
                #[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
                {
                    panic!("No hwnd was found! Try to use wasm mode.");
                    None
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                None
            }
        };

        fn config<'a>(hwnd: Option<*mut c_void>) -> PlatformConfig<'a> {
            PlatformConfig {
                dbus_name: "cloudmusic-vscode",
                display_name: TITLE,
                hwnd,
            }
        }

        let controls = match MediaControls::new(config(hwnd)) {
            Ok(controls) => controls,
            // Access to other windows requires admin rights,
            // so it almost always fails on Windows, we still
            // need to use a fake window as fallback.
            Err(_) => {
                ACCESSABLE.store(false, Ordering::Relaxed);
                MediaControls::new(config(fallback())).unwrap()
            }
        };

        MediaSession { controls }
    }

    #[inline]
    fn set_metadata(
        &mut self,
        title: String,
        album: String,
        artist: String,
        cover_url: String,
        duration: f64,
    ) {
        self.controls
            .set_metadata(MediaMetadata {
                title: Some(title.as_str()),
                album: album.is_empty().then_some(album.as_str()),
                artist: artist.is_empty().then_some(artist.as_str()),
                cover_url: cover_url.starts_with("http").then_some(cover_url.as_str()),
                duration: (duration == 0.).then_some(Duration::from_secs_f64(duration)),
            })
            .unwrap();
    }

    #[inline]
    fn set_playback(&mut self, playing: bool, position: f64) {
        let progress = Some(MediaPosition(Duration::from_secs_f64(position)));
        self.controls
            .set_playback(match playing {
                true => MediaPlayback::Playing { progress },
                false => MediaPlayback::Paused { progress },
            })
            .unwrap();
    }
}

#[cfg(target_os = "windows")]
pub fn media_session_hwnd(mut cx: FunctionContext) -> JsResult<JsString> {
    if !ACCESSABLE.load(Ordering::Relaxed) {
        return Ok(cx.string("".to_string()));
    }

    fn decode_utf16(buf: &[u16]) -> String {
        use std::char::{decode_utf16, REPLACEMENT_CHARACTER};

        decode_utf16(buf.iter().take_while(|&i| *i != 0).cloned())
            .map(|r| r.unwrap_or(REPLACEMENT_CHARACTER))
            .collect::<String>()
    }

    use {
        std::sync::atomic::{AtomicU32, AtomicU64},
        winapi::{
            shared::{
                minwindef::{BOOL, FALSE, LPARAM, TRUE},
                windef::HWND,
            },
            um::winuser::{EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId},
        },
    };

    static PID: AtomicU32 = AtomicU32::new(0);
    static PSTR: AtomicU64 = AtomicU64::new(0);

    PID.store(
        cx.argument::<JsString>(0)?.value(&mut cx).parse().unwrap(),
        Ordering::Relaxed,
    );

    extern "system" fn callback(hwnd: HWND, _: LPARAM) -> BOOL {
        const LEN: usize = 1 << 8;
        let mut buf = [0u16; LEN];

        if unsafe { GetClassNameW(hwnd, &mut buf[0], LEN as i32) } < 0 {
            return TRUE;
        }
        let class_name = decode_utf16(&buf);
        if class_name != "Chrome_WidgetWin_1" {
            return TRUE;
        }

        if unsafe { GetWindowTextW(hwnd, &mut buf[0], LEN as i32) } < 0 {
            return TRUE;
        }
        let title = decode_utf16(&buf);
        if title != "Code" {
            return TRUE;
        }

        let mut pid: u32 = 0;
        let _creator = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if PID.load(Ordering::SeqCst) != pid {
            return TRUE;
        }

        PSTR.store(hwnd as u64, Ordering::SeqCst);
        FALSE
    }

    Ok(cx.string(match unsafe { EnumWindows(Some(callback), 0) } {
        FALSE => PSTR.load(Ordering::Relaxed).to_string(),
        _ => "".to_string(),
    }))
}

pub fn media_session_new(mut cx: FunctionContext) -> JsResult<JsValue> {
    let hwnd = cx.argument::<JsString>(0)?.value(&mut cx);
    let play_handler = Arc::new(cx.argument::<JsFunction>(1)?.root(&mut cx));
    let pause_handler = Arc::new(cx.argument::<JsFunction>(2)?.root(&mut cx));
    let toggle_handler = Arc::new(cx.argument::<JsFunction>(3)?.root(&mut cx));
    let next_handler = Arc::new(cx.argument::<JsFunction>(4)?.root(&mut cx));
    let previous_handler = Arc::new(cx.argument::<JsFunction>(5)?.root(&mut cx));
    let stop_handler = Arc::new(cx.argument::<JsFunction>(6)?.root(&mut cx));

    let media_session = cx.boxed(RefCell::new(MediaSession::new(hwnd)));
    let channel = cx.channel();

    let _ = media_session
        .borrow_mut()
        .controls
        .attach(move |event: MediaControlEvent| {
            let callback = match event {
                MediaControlEvent::Play => play_handler.clone(),
                MediaControlEvent::Pause => pause_handler.clone(),
                MediaControlEvent::Toggle => toggle_handler.clone(),
                MediaControlEvent::Next => next_handler.clone(),
                MediaControlEvent::Previous => previous_handler.clone(),
                MediaControlEvent::Stop => stop_handler.clone(),
                _ => return,
            };

            channel.send(move |mut cx| {
                let callback = callback.to_inner(&mut cx);
                let this = cx.undefined();
                let args: [Handle<JsUndefined>; 0] = [];
                callback.call(&mut cx, this, args)?;
                Ok(())
            });
        });

    let _ = media_session
        .borrow_mut()
        .controls
        .set_playback(MediaPlayback::Stopped);

    Ok(media_session.upcast())
}

pub fn media_session_set_metadata(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let media_session = cx.argument::<JsBox<RefCell<MediaSession>>>(0)?;
    let title = cx.argument::<JsString>(1)?.value(&mut cx);
    let album = cx.argument::<JsString>(2)?.value(&mut cx);
    let artist = cx.argument::<JsString>(3)?.value(&mut cx);
    let cover_url = cx.argument::<JsString>(4)?.value(&mut cx);
    let duration = cx.argument::<JsNumber>(5)?.value(&mut cx);

    media_session
        .borrow_mut()
        .set_metadata(title, album, artist, cover_url, duration);

    Ok(cx.undefined())
}

pub fn media_session_set_playback(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let media_session = cx.argument::<JsBox<RefCell<MediaSession>>>(0)?;
    let playing = cx.argument::<JsBoolean>(1)?.value(&mut cx);
    let position = cx.argument::<JsNumber>(2)?.value(&mut cx);

    media_session.borrow_mut().set_playback(playing, position);

    Ok(cx.undefined())
}

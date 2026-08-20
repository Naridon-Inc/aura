//! macOS notifications that actually arrive.
//!
//! The app has had a notification path since v0.19.19 and it has never
//! delivered a single banner on macOS. `tauri-plugin-notification`'s desktop
//! implementation posts through `notify-rust` → `mac-notification-sys` →
//! **`NSUserNotificationCenter`**, the API Apple deprecated in 10.14 and no
//! longer delivers from. The tell is that `sh.aura.shell` has never appeared
//! in `~/Library/Preferences/com.apple.ncprefs.plist` — sixty other apps on
//! this machine are listed there, because posting once is what puts you
//! there. Aura never registered, so System Settings › Notifications has no row
//! for it, and there was no switch a user could have flipped to fix it.
//!
//! Two more things that path silently dropped: the desktop builder never reads
//! `actionTypeId` or `extra`, and `register_action_types` is a mobile-only
//! command. So the inline "Reply" field on a chat notification, and the tap
//! that should land you in the conversation, were never wired to anything
//! either — the JS asked for both and the Rust threw them away.
//!
//! This module replaces all of it with the modern `UNUserNotificationCenter`:
//! ask for authorization once, register one category carrying a text-input
//! Reply action, post through it, and forward the tap or the typed reply back
//! to the webview as a `notification://action` event.
//!
//! **Requires a real `.app`.** `UNUserNotificationCenter.currentNotificationCenter`
//! raises when the process has no bundle proxy, which is exactly how the binary
//! runs under `cargo run` and `tauri dev`. It raises from inside its own
//! `dispatch_once`, and libdispatch terminates on any exception escaping a
//! callout, so this genuinely cannot be caught — it has to be checked for
//! first. Every entry point goes through [`mac::center`], which asks whether
//! the main bundle URL is a `.app` before touching the API, so a dev build
//! degrades to silence instead of aborting the app.
//!
//! Other platforms keep the plugin: Linux and Windows have no Notification
//! Center, their plugin paths deliver, and `os_notify_available` answers
//! `false` there so the frontend falls back without having to know why.

use tauri::AppHandle;

/// The event a tap or a typed reply arrives on. One event for both: `text` is
/// empty for a bare tap, which is the difference between "take me there" and
/// "here is my answer".
pub const ACTION_EVENT: &str = "notification://action";

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::OnceLock;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSSet, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
        UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSound, UNTextInputNotificationAction, UNTextInputNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use serde::Serialize;
    use tauri::{AppHandle, Emitter};

    /// The category every chat notification is posted under, so every one of
    /// them offers Reply. Registered once at startup.
    const CHAT_CATEGORY: &str = "aura.chat.reply";
    /// Action id inside that category. The webview matches this exact string.
    const REPLY_ACTION: &str = "REPLY";
    /// `userInfo` key holding the caller's opaque JSON, round-tripped back out
    /// on the response so the webview knows which repo and channel a reply is
    /// for.
    const EXTRA_KEY: &str = "auraExtra";

    #[derive(Serialize, Clone)]
    pub struct NotificationAction {
        /// `REPLY` for the inline field, `com.apple.UNNotificationDefaultActionIdentifier`
        /// for a plain tap on the banner.
        pub action_id: String,
        /// What they typed. Empty on a bare tap.
        pub text: String,
        /// The `extra` the notification was posted with, verbatim.
        pub extra: serde_json::Value,
    }

    /// Set once at startup so the delegate can reach the webview. The system
    /// calls delegate methods long after `init` has returned, and it hands
    /// them nothing of ours to carry a handle in.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// Whether this process is running from inside a real `.app`.
    ///
    /// This is the precondition, and it has to be checked before the call —
    /// there is no catching it afterwards. `+[UNUserNotificationCenter
    /// currentNotificationCenter]` raises `bundleProxyForCurrentProcess is
    /// nil` from **inside its `dispatch_once`**, and libdispatch calls
    /// `std::terminate` on any exception escaping a callout, so the process
    /// aborts with `objc2::exception::catch` sitting right there on the stack,
    /// unreached. A loose `target/debug/aura-shell` — how `tauri dev` runs —
    /// took the whole app down the first time the webview asked whether
    /// notifications were available.
    ///
    /// A bundle identifier is not the test. `NSBundle::mainBundle()` for an
    /// unbundled executable roots itself at the containing directory and still
    /// answers with an identifier, which is why the earlier guard let the call
    /// through. The bundle *URL* is the honest signal: it ends in `.app` when
    /// there is a bundle proxy and points at a plain build directory when
    /// there isn't.
    fn inside_app_bundle() -> bool {
        NSBundle::mainBundle()
            .bundleURL()
            .path()
            .is_some_and(|p| p.to_string().trim_end_matches('/').ends_with(".app"))
    }

    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        if !inside_app_bundle() {
            return None;
        }
        // Still worth catching: a signed, bundled app can raise here for its
        // own reasons (a damaged bundle, a revoked entitlement), and those
        // throws do reach us. It is not what saves the dev build.
        objc2::exception::catch(UNUserNotificationCenter::currentNotificationCenter).ok()
    }

    define_class!(
        // SAFETY: NSObject imposes no subclassing requirements, this type adds
        // no instance variables, and it has no Drop impl. Everything the
        // delegate needs is in the `APP` static.
        #[unsafe(super(NSObject))]
        #[name = "AuraNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                // Without this, macOS drops any notification that arrives while
                // Aura is the frontmost app. The caller already decided this one
                // is worth showing — it skips the banner itself when the window
                // has focus — and "frontmost app" is not "focused window": the
                // HUD or a popout can hold focus while the chat window sits
                // behind it, unread.
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &block2::DynBlock<dyn Fn()>,
            ) {
                let action_id = response.actionIdentifier().to_string();
                // `userText` only exists on the text-input subclass. Ask by
                // downcast rather than by action id, so a category that grows a
                // second text action later keeps working.
                let text = response
                    .downcast_ref::<UNTextInputNotificationResponse>()
                    .map(|r| r.userText().to_string())
                    .unwrap_or_default();
                let extra = extra_of(response);
                if let Some(app) = APP.get() {
                    let _ = app.emit(
                        super::ACTION_EVENT,
                        NotificationAction { action_id, text, extra },
                    );
                }
                completion.call(());
            }
        }
    );

    /// Dig the caller's `extra` back out of the notification's `userInfo`.
    fn extra_of(response: &UNNotificationResponse) -> serde_json::Value {
        let content = response.notification().request().content();
        let info = content.userInfo();
        let key = NSString::from_str(EXTRA_KEY);
        // `userInfo` is typed as a dictionary of anything, so this goes through
        // `objectForKey:` by hand and checks the class on the way out.
        let raw: Option<Retained<NSObject>> = unsafe { msg_send![&*info, objectForKey: &*key] };
        raw.and_then(|o| o.downcast::<NSString>().ok())
            .and_then(|s| serde_json::from_str(&s.to_string()).ok())
            .unwrap_or(serde_json::Value::Null)
    }

    /// Install the delegate, register the Reply category, ask for permission.
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        let Some(center) = center() else { return };

        // `delegate` is a weak property, so the object has to stay alive on its
        // own or the system's reference goes nil and every tap is dropped. It
        // lives for the process, which is what leaking it says: there is
        // exactly one, and nothing ever replaces it.
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        std::mem::forget(delegate);

        let reply = UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
            &NSString::from_str(REPLY_ACTION),
            &NSString::from_str("Reply"),
            UNNotificationActionOptions::empty(),
            &NSString::from_str("Send"),
            &NSString::from_str("Reply…"),
        );
        let reply: Retained<UNNotificationAction> = Retained::into_super(reply);
        let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &NSString::from_str(CHAT_CATEGORY),
            &NSArray::from_retained_slice(&[reply]),
            &NSArray::from_slice(&[]),
            UNNotificationCategoryOptions::empty(),
        );
        center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));

        // The first call is what puts Aura in System Settings › Notifications
        // and pops the consent sheet. Later calls answer from the stored
        // decision without prompting, so running this every launch is free and
        // repairs the row if a user ever removes it.
        let done = RcBlock::new(|_granted: Bool, _err: *mut NSError| {});
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert
                | UNAuthorizationOptions::Sound
                | UNAuthorizationOptions::Badge,
            &done,
        );
    }

    pub fn available() -> bool {
        center().is_some()
    }

    pub fn post(
        title: &str,
        body: Option<&str>,
        sound: Option<&str>,
        thread_id: Option<&str>,
        extra: Option<&serde_json::Value>,
    ) -> bool {
        let Some(center) = center() else { return false };

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        if let Some(b) = body.filter(|b| !b.is_empty()) {
            content.setBody(&NSString::from_str(b));
        }
        match sound.filter(|s| !s.is_empty()) {
            Some(name) => content.setSound(Some(&UNNotificationSound::soundNamed(
                &NSString::from_str(name),
            ))),
            None => content.setSound(None),
        }
        content.setCategoryIdentifier(&NSString::from_str(CHAT_CATEGORY));
        // A thread identifier is what makes ten messages in one channel stack
        // into a single group in Notification Center instead of ten separate
        // banners to dismiss one at a time.
        if let Some(t) = thread_id.filter(|t| !t.is_empty()) {
            content.setThreadIdentifier(&NSString::from_str(t));
        }
        if let Some(json) = extra.and_then(|e| serde_json::to_string(e).ok()) {
            let dict = NSDictionary::from_slices::<NSString>(
                &[&*NSString::from_str(EXTRA_KEY)],
                &[&*NSString::from_str(&json)],
            );
            // SAFETY: the dictionary is a fresh NSString→NSString map, which is
            // property-list safe and the only shape `extra_of` reads back.
            unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(dict)) };
        }

        // A fresh identifier per post. Reusing one replaces the banner already
        // on screen, so the second message in a channel would eat the first
        // before anyone had read it.
        let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &id, &content, // no trigger: deliver now
            None,
        );
        center.addNotificationRequest_withCompletionHandler(&request, None);
        true
    }

    #[cfg(test)]
    mod tests {
        /// The test binary is a loose executable under `target/debug/deps` — the
        /// same shape as `tauri dev`. So this test *is* the regression: before
        /// the bundle-URL check, calling `available()` here aborted the process
        /// from inside libdispatch, which no `#[should_panic]` can express
        /// because the process never gets to unwind.
        ///
        /// Returning `false` is the honest answer, not a degraded one: an
        /// unbundled process has no bundle proxy, so the system genuinely
        /// cannot deliver a notification for it. The frontend falls back to the
        /// plugin.
        #[test]
        fn an_unbundled_process_reports_no_notification_centre_instead_of_aborting() {
            assert!(!super::inside_app_bundle());
            assert!(!super::available());
        }
    }
}

/// Install the notification delegate and ask for permission. Call once from
/// `setup`. A no-op where there is no Notification Center to talk to.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::init(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Post a notification through the OS. `sound` names a system sound ("Ping",
/// "Glass"); `None` is silent. `extra` comes back verbatim on [`ACTION_EVENT`]
/// when the notification is tapped or replied to.
///
/// `Ok(false)` means there was nothing to post through — an unbundled dev
/// build, or a platform where the plugin owns this. That is an answer for the
/// caller to act on, not an error to show anybody.
#[tauri::command]
pub async fn os_notify(
    title: String,
    body: Option<String>,
    sound: Option<String>,
    thread_id: Option<String>,
    extra: Option<serde_json::Value>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(mac::post(
            &title,
            body.as_deref(),
            sound.as_deref(),
            thread_id.as_deref(),
            extra.as_ref(),
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body, sound, thread_id, extra);
        Ok(false)
    }
}

/// Whether this build can post through the OS at all, so the frontend can fall
/// back to the plugin instead of dropping the notification on the floor.
#[tauri::command]
pub async fn os_notify_available() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(mac::available())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

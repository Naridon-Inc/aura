fn main() {
    // telemetry.rs bakes the PostHog capture key/host at compile time via
    // option_env!("AURA_POSTHOG_KEY") / option_env!("AURA_POSTHOG_HOST"). Cargo does NOT
    // track env vars read through option_env! on its own, so once this crate's object is
    // cached it keeps a stale value across rebuilds — which silently shipped every release
    // with an empty key (emit() no-ops: no events, no error logs). These directives force a
    // recompile whenever the baked values change, so release builds actually carry the key.
    println!("cargo:rerun-if-env-changed=AURA_POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=AURA_POSTHOG_HOST");
    tauri_build::build()
}

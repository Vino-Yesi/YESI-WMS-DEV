#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|_app| {
            log::info!("Yesi-WMS Lite 1.2.0 started (session · Neural Ops · users · PWA-parity UI)");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Yesi-WMS Lite");
}

// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `Baton.exe --hook <Event>` runs as a Claude Code hook (no window), so PCs without Node work too.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--hook" {
        baton_lib::hook::run(&args[2]);
        return;
    }
    baton_lib::run();
}

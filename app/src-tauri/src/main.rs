// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `Baton.exe --hook <Event>` runs as a Claude Code hook (no window), so PCs without Node work too.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--hook" {
        baton_lib::hook::run(&args[2]);
        return;
    }
    // `Baton.exe --picture <file> [--project <slug>]`: a Claude adds a picture from this PC.
    if args.len() >= 3 && args[1] == "--picture" {
        std::process::exit(baton_lib::picture::run(&args[2..]));
    }
    baton_lib::run();
}

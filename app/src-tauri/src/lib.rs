pub mod hook;

use serde::Serialize;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Same file the `baton` CLI uses, so both stay in sync.
pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("BATON_CONFIG") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".baton")
        .join("config.json")
}

pub fn read_config() -> Value {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_else(|| json!({}))
}

fn claude_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude")
}

/// A command without a console window flashing up on Windows.
fn quiet(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

#[tauri::command]
fn load_config() -> String {
    read_config().to_string()
}

#[tauri::command]
fn save_config(json: String) -> Result<(), String> {
    let v: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let path = config_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, serde_json::to_string_pretty(&v).unwrap() + "\n").map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatus {
    mcp: bool,
    hooks: bool,
    claude_found: bool,
}

fn is_baton_hook(cmd: &str) -> bool {
    cmd.contains("--baton") || (cmd.contains("hook.mjs") && cmd.to_lowercase().contains("baton"))
}

fn settings_path() -> PathBuf {
    claude_dir().join("settings.json")
}

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_else(|| json!({}))
}

fn has_baton_hooks(settings: &Value) -> bool {
    settings["hooks"]
        .as_object()
        .map(|events| {
            events
                .values()
                .flat_map(|groups| groups.as_array().cloned().unwrap_or_default())
                .any(|g| {
                    g["hooks"]
                        .as_array()
                        .map(|hs| {
                            hs.iter()
                                .any(|h| h["command"].as_str().is_some_and(is_baton_hook))
                        })
                        .unwrap_or(false)
                })
        })
        .unwrap_or(false)
}

#[tauri::command]
fn claude_status() -> ClaudeStatus {
    let user_json = read_json(&dirs::home_dir().unwrap_or_default().join(".claude.json"));
    ClaudeStatus {
        mcp: user_json["mcpServers"]["baton"].is_object(),
        hooks: has_baton_hooks(&read_json(&settings_path())),
        claude_found: quiet("claude")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false),
    }
}

/// Removes our hook entries (from this app or the CLI), keeping everything else as it was.
fn strip_baton(settings: &mut Value) {
    let Some(events) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return;
    };
    let names: Vec<String> = events.keys().cloned().collect();
    for name in names {
        let groups = events.get_mut(&name).and_then(|g| g.as_array_mut());
        if let Some(groups) = groups {
            for g in groups.iter_mut() {
                if let Some(hs) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                    hs.retain(|h| !h["command"].as_str().is_some_and(is_baton_hook));
                }
            }
            groups.retain(|g| g["hooks"].as_array().is_some_and(|h| !h.is_empty()));
            if groups.is_empty() {
                events.remove(&name);
            }
        }
    }
}

fn write_settings(settings: &Value) -> Result<(), String> {
    let path = settings_path();
    fs::create_dir_all(claude_dir()).map_err(|e| e.to_string())?;
    if path.exists() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        fs::copy(
            &path,
            claude_dir().join(format!("settings.json.baton-{stamp}.bak")),
        )
        .map_err(|e| e.to_string())?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(settings).unwrap() + "\n",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn connect_claude() -> Result<String, String> {
    let cfg = read_config();
    let server = cfg["server"]
        .as_str()
        .ok_or("No server in the config.")?
        .trim_end_matches('/')
        .to_string();
    let key = cfg["agentKey"]
        .as_str()
        .ok_or("Create this PC's Claude key first.")?
        .to_string();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();

    let mut settings = read_json(&settings_path());
    if !settings.is_object() {
        settings = json!({});
    }
    strip_baton(&mut settings);
    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let add = |hooks: &mut Value, event: &str, matcher: Option<&str>| {
        let mut group = json!({ "hooks": [{ "type": "command", "command": format!("\"{exe}\" --hook {event} --baton"), "timeout": 5 }] });
        if let Some(m) = matcher {
            group["matcher"] = json!(m);
        }
        let list = hooks
            .as_object_mut()
            .unwrap()
            .entry(event)
            .or_insert_with(|| json!([]));
        list.as_array_mut().unwrap().push(group);
    };
    add(hooks, "SessionStart", None);
    add(hooks, "UserPromptSubmit", None);
    add(
        hooks,
        "PostToolUse",
        Some(
            "Edit|Write|MultiEdit|NotebookEdit|mcp__Roblox_Studio__multi_edit|mcp__Roblox_Studio__execute_luau|mcp__Roblox_Studio__insert_asset",
        ),
    );
    add(hooks, "Stop", None);
    write_settings(&settings)?;

    let _ = quiet("claude")
        .args(["mcp", "remove", "baton", "-s", "user"])
        .output();
    let out = quiet("claude")
        .args([
            "mcp",
            "add",
            "--transport",
            "http",
            "--scope",
            "user",
            "baton",
            &format!("{server}/mcp"),
            "--header",
            &format!("Authorization: Bearer {key}"),
        ])
        .output()
        .map_err(|_| "Couldn't run `claude`. Is Claude Code installed?".to_string())?;
    if !out.status.success() {
        return Err(format!(
            "claude mcp add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok("Connected. New Claude Code sessions get the brief and the baton tools.".into())
}

#[tauri::command]
fn disconnect_claude() -> Result<String, String> {
    let mut settings = read_json(&settings_path());
    if has_baton_hooks(&settings) {
        strip_baton(&mut settings);
        if settings["hooks"].as_object().is_some_and(|h| h.is_empty()) {
            settings.as_object_mut().unwrap().remove("hooks");
        }
        write_settings(&settings)?;
    }
    let _ = quiet("claude")
        .args(["mcp", "remove", "baton", "-s", "user"])
        .output();
    Ok("Disconnected. Claude Code no longer loads Baton.".into())
}

/// Writes the project's shared skills into ~/.claude/skills, never over a skill Baton didn't put there.
#[tauri::command]
fn install_skills(project: String, bundle: String) -> Result<String, String> {
    let skills: Vec<Value> = serde_json::from_str(&bundle).map_err(|e| e.to_string())?;
    let root = claude_dir().join("skills");
    let (mut done, mut skipped) = (0, Vec::new());
    for s in &skills {
        let Some(name) = s["name"].as_str() else {
            continue;
        };
        if name.is_empty() || name.contains(['/', '\\', '.']) {
            continue;
        }
        let dir = root.join(name);
        let marker = dir.join(".baton-skill.json");
        if dir.exists() && !marker.exists() {
            skipped.push(name.to_string());
            continue;
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::write(dir.join("SKILL.md"), s["body"].as_str().unwrap_or(""))
            .map_err(|e| e.to_string())?;
        if let Some(files) = s["files"].as_object() {
            for (rel, content) in files {
                // no escaping the skill folder
                if rel.contains("..") || Path::new(rel).is_absolute() {
                    continue;
                }
                let target = dir.join(rel);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&target, content.as_str().unwrap_or("")).map_err(|e| e.to_string())?;
            }
        }
        fs::write(
            &marker,
            json!({ "project": project, "version": s["version"] }).to_string(),
        )
        .map_err(|e| e.to_string())?;
        done += 1;
    }
    let mut msg = format!(
        "Installed {done} shared skill{} in ~/.claude/skills.",
        if done == 1 { "" } else { "s" }
    );
    if !skipped.is_empty() {
        msg.push_str(&format!(
            " Skipped (you have your own): {}.",
            skipped.join(", ")
        ));
    }
    Ok(msg)
}

#[derive(Serialize)]
struct VaultFile {
    rel: String,
    content: String,
}

/// A note path inside the vault folder; refuses absolute paths and "..".
fn vault_path(folder: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(folder);
    if folder.trim().is_empty() || !root.is_dir() {
        return Err(format!("The Obsidian folder \"{folder}\" doesn't exist on this PC."));
    }
    let rel = rel.replace('\\', "/");
    if rel.starts_with('/') || rel.contains(':') || rel.split('/').any(|p| p == ".." || p.is_empty()) {
        return Err(format!("Refused an unsafe note path: {rel}"));
    }
    Ok(root.join(rel))
}

/// Obsidian sync: every .md note under the folder (skips .obsidian, .trash and other dot folders).
#[tauri::command]
fn vault_scan(folder: String) -> Result<Vec<VaultFile>, String> {
    let root = PathBuf::from(&folder);
    if folder.trim().is_empty() || !root.is_dir() {
        return Err(format!("The Obsidian folder \"{folder}\" doesn't exist on this PC."));
    }
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if name.to_lowercase().ends_with(".md") && e.metadata().map(|m| m.len() < 512 * 1024).unwrap_or(false) {
                if let (Ok(content), Ok(rel)) = (fs::read_to_string(&p), p.strip_prefix(&root)) {
                    out.push(VaultFile { rel: rel.to_string_lossy().replace('\\', "/"), content });
                }
            }
            if out.len() >= 2000 {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn vault_write(folder: String, rel: String, content: String) -> Result<(), String> {
    let path = vault_path(&folder, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Wake: runs this PC's Claude headless for a teammate's request. The app only calls it when the
/// person turned Wake on, within their daily limit. Read-only tools unless they allowed edits.
#[tauri::command]
async fn run_wake(folder: String, prompt: String, max_turns: u32, may_edit: bool) -> Result<String, String> {
    let dir = PathBuf::from(&folder);
    if folder.trim().is_empty() || !dir.is_dir() {
        return Err(format!("The Wake folder \"{folder}\" doesn't exist on this PC."));
    }
    let tools = if may_edit { "Read,Glob,Grep,Edit,Write,MultiEdit,mcp__baton" } else { "Read,Glob,Grep,mcp__baton" };
    let turns = max_turns.clamp(1, 100).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let out = quiet("claude")
            .current_dir(&dir)
            .args(["-p", &prompt, "--max-turns", &turns, "--allowedTools", tools, "--output-format", "text"])
            .output()
            .map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() {
            Ok(text)
        } else {
            let err = format!("{} {}", String::from_utf8_lossy(&out.stderr).trim(), text);
            Err(err.trim().chars().take(400).collect())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hands a to-do to an existing Claude Code chat: resumes that session headless in its folder.
#[tauri::command]
async fn resume_chat(session: String, folder: String, prompt: String, max_turns: u32, may_edit: bool) -> Result<String, String> {
    if !session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || session.len() < 6 {
        return Err("That chat id doesn't look right.".into());
    }
    let dir = PathBuf::from(&folder);
    if folder.trim().is_empty() || !dir.is_dir() {
        return Err(format!("The chat's folder \"{folder}\" doesn't exist on this PC."));
    }
    let tools = if may_edit { "Read,Glob,Grep,Edit,Write,MultiEdit,TodoWrite,mcp__baton" } else { "Read,Glob,Grep,TodoWrite,mcp__baton" };
    let turns = max_turns.clamp(1, 200).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let out = quiet("claude")
            .current_dir(&dir)
            .args(["-p", &prompt, "--resume", &session, "--max-turns", &turns, "--allowedTools", tools, "--output-format", "text"])
            .output()
            .map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() {
            Ok(text)
        } else {
            let err = format!("{} {}", String::from_utf8_lossy(&out.stderr).trim(), text);
            Err(err.trim().chars().take(400).collect())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name == "node_modules" || name.starts_with(".git") {
            continue;
        }
        if p.is_dir() {
            walk_files(&p, out);
        } else {
            out.push(p);
        }
    }
}

/// The skills installed in this PC's Claude Code (~/.claude/skills), ready to share with the project.
#[tauri::command]
fn local_skills() -> Result<Value, String> {
    let root = claude_dir().join("skills");
    let text_ext = ["md", "txt", "lua", "luau", "json", "yml", "yaml", "toml", "js", "mjs", "ts", "tsx", "py", "css", "html", "csv"];
    let mut list = Vec::new();
    let Ok(rd) = fs::read_dir(&root) else { return Ok(Value::Array(list)) };
    for e in rd.flatten() {
        let dir = e.path();
        let skill_md = dir.join("SKILL.md");
        if !dir.is_dir() || !skill_md.is_file() {
            continue;
        }
        let body = fs::read_to_string(&skill_md).unwrap_or_default();
        let mut files = serde_json::Map::new();
        let mut skipped = Vec::new();
        let mut all = Vec::new();
        walk_files(&dir, &mut all);
        let mut total: u64 = 0;
        for f in all {
            let rel = f.strip_prefix(&dir).unwrap_or(&f).to_string_lossy().replace('\\', "/");
            if rel == "SKILL.md" || rel == ".baton-skill.json" {
                continue;
            }
            let size = fs::metadata(&f).map(|m| m.len()).unwrap_or(u64::MAX);
            let ext = f.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !text_ext.contains(&ext.as_str()) || size > 200_000 || total + size > 850_000 {
                skipped.push(Value::String(rel));
                continue;
            }
            match fs::read_to_string(&f) {
                Ok(t) => {
                    total += size;
                    files.insert(rel, Value::String(t));
                }
                Err(_) => skipped.push(Value::String(rel)),
            }
        }
        list.push(serde_json::json!({
            "folder": e.file_name().to_string_lossy(),
            "body": body,
            "files": files,
            "skipped": skipped,
            "fromBaton": dir.join(".baton-skill.json").exists(),
        }));
    }
    Ok(Value::Array(list))
}

/// When on, closing the window hides Baton to the tray so notifications keep coming.
static CLOSE_TO_TRAY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[tauri::command]
fn set_close_to_tray(on: bool) {
    CLOSE_TO_TRAY.store(on, std::sync::atomic::Ordering::Relaxed);
}

fn show_main(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            let open = MenuItem::with_id(app, "open", "Open Baton", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("baton")
                .tooltip("Baton")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if CLOSE_TO_TRAY.load(std::sync::atomic::Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            claude_status,
            connect_claude,
            disconnect_claude,
            install_skills,
            local_skills,
            resume_chat,
            set_close_to_tray,
            run_wake,
            vault_scan,
            vault_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running Baton");
}

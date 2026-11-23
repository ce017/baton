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
    dirs::home_dir().unwrap_or_default().join(".baton").join("config.json")
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
            events.values().flat_map(|groups| groups.as_array().cloned().unwrap_or_default()).any(|g| {
                g["hooks"].as_array().map(|hs| hs.iter().any(|h| h["command"].as_str().is_some_and(is_baton_hook))).unwrap_or(false)
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
        claude_found: quiet("claude").arg("--version").output().map(|o| o.status.success()).unwrap_or(false),
    }
}

/// Removes our hook entries (from this app or the CLI), keeping everything else as it was.
fn strip_baton(settings: &mut Value) {
    let Some(events) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) else { return };
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
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        fs::copy(&path, claude_dir().join(format!("settings.json.baton-{stamp}.bak"))).map_err(|e| e.to_string())?;
    }
    fs::write(&path, serde_json::to_string_pretty(settings).unwrap() + "\n").map_err(|e| e.to_string())
}

#[tauri::command]
fn connect_claude() -> Result<String, String> {
    let cfg = read_config();
    let server = cfg["server"].as_str().ok_or("No server in the config.")?.trim_end_matches('/').to_string();
    let key = cfg["agentKey"].as_str().ok_or("Create this PC's Claude key first.")?.to_string();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();

    let mut settings = read_json(&settings_path());
    if !settings.is_object() {
        settings = json!({});
    }
    strip_baton(&mut settings);
    let hooks = settings.as_object_mut().unwrap().entry("hooks").or_insert_with(|| json!({}));
    let add = |hooks: &mut Value, event: &str, matcher: Option<&str>| {
        let mut group = json!({ "hooks": [{ "type": "command", "command": format!("\"{exe}\" --hook {event} --baton"), "timeout": 5 }] });
        if let Some(m) = matcher {
            group["matcher"] = json!(m);
        }
        let list = hooks.as_object_mut().unwrap().entry(event).or_insert_with(|| json!([]));
        list.as_array_mut().unwrap().push(group);
    };
    add(hooks, "SessionStart", None);
    add(hooks, "UserPromptSubmit", None);
    add(
        hooks,
        "PostToolUse",
        Some("Edit|Write|MultiEdit|NotebookEdit|mcp__Roblox_Studio__multi_edit|mcp__Roblox_Studio__execute_luau|mcp__Roblox_Studio__insert_asset"),
    );
    add(hooks, "Stop", None);
    write_settings(&settings)?;

    let _ = quiet("claude").args(["mcp", "remove", "baton", "-s", "user"]).output();
    let out = quiet("claude")
        .args(["mcp", "add", "--transport", "http", "--scope", "user", "baton", &format!("{server}/mcp"), "--header", &format!("Authorization: Bearer {key}")])
        .output()
        .map_err(|_| "Couldn't run `claude`. Is Claude Code installed?".to_string())?;
    if !out.status.success() {
        return Err(format!("claude mcp add failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
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
    let _ = quiet("claude").args(["mcp", "remove", "baton", "-s", "user"]).output();
    Ok("Disconnected. Claude Code no longer loads Baton.".into())
}

/// Writes the project's shared skills into ~/.claude/skills, never over a skill Baton didn't put there.
#[tauri::command]
fn install_skills(project: String, bundle: String) -> Result<String, String> {
    let skills: Vec<Value> = serde_json::from_str(&bundle).map_err(|e| e.to_string())?;
    let root = claude_dir().join("skills");
    let (mut done, mut skipped) = (0, Vec::new());
    for s in &skills {
        let Some(name) = s["name"].as_str() else { continue };
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
        fs::write(dir.join("SKILL.md"), s["body"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
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
        fs::write(&marker, json!({ "project": project, "version": s["version"] }).to_string()).map_err(|e| e.to_string())?;
        done += 1;
    }
    let mut msg = format!("Installed {done} shared skill{} in ~/.claude/skills.", if done == 1 { "" } else { "s" });
    if !skipped.is_empty() {
        msg.push_str(&format!(" Skipped (you have your own): {}.", skipped.join(", ")));
    }
    Ok(msg)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_config, save_config, claude_status, connect_claude, disconnect_claude, install_skills])
        .run(tauri::generate_context!())
        .expect("error while running Baton");
}

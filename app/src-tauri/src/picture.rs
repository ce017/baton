//! `Baton.exe --picture <file> [--project <slug>]`: lets a Claude add a picture from this PC to
//! Baton. Uploads the file with this PC's Claude key and prints the markdown that shows it, for the
//! Claude to put in a note (baton_write) or a message (baton_post). Big pictures are shrunk first.
use base64::Engine;
use serde_json::{Value, json};
use std::io::Write;
use std::time::Duration;

const MAX_BYTES: usize = 1_800_000;
const MAX_SIDE: u32 = 2400;

/// Runs the command and returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    match upload(args) {
        Ok(markdown) => {
            say(&markdown);
            0
        }
        Err(e) => {
            say(&format!("Baton: {e}"));
            1
        }
    }
}

fn say(s: &str) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{s}");
    let _ = out.flush();
}

fn mime_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else {
        None
    }
}

/// Keeps small pictures as they are; shrinks big ones to a JPEG that fits.
fn prepare(bytes: Vec<u8>) -> Result<(Vec<u8>, &'static str), String> {
    let mime = mime_of(&bytes).ok_or("that file is not a PNG, JPEG, WebP or GIF picture.")?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("could not read the picture ({e})."))?;
    if bytes.len() <= MAX_BYTES && img.width().max(img.height()) <= MAX_SIDE {
        return Ok((bytes, mime));
    }
    if mime == "image/gif" {
        return Err("that GIF is too big (1.8 MB at most).".into());
    }
    let mut side = 2048u32;
    let mut quality = 88u8;
    for _ in 0..7 {
        let small = img.thumbnail(side, side).to_rgb8();
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
            .encode_image(&small)
            .map_err(|e| format!("could not shrink the picture ({e})."))?;
        if out.len() <= MAX_BYTES {
            return Ok((out, "image/jpeg"));
        }
        side = side * 4 / 5;
        quality = quality.saturating_sub(8).max(50);
    }
    Err("that picture is too big, even shrunk.".into())
}

fn upload(args: &[String]) -> Result<String, String> {
    let mut file = None;
    let mut project = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--project" {
            project = it.next().cloned();
        } else if file.is_none() {
            file = Some(a.clone());
        }
    }
    let file = file.ok_or("usage: Baton.exe --picture <file> [--project <slug>]")?;
    let cfg = crate::read_config();
    let server = cfg["server"].as_str().ok_or("this PC is not signed in to Baton.")?.trim_end_matches('/').to_string();
    let key = cfg["agentKey"].as_str().ok_or("this PC has no Claude key yet (open the Baton app).")?;
    let bytes = std::fs::read(&file).map_err(|e| format!("could not open {file} ({e})."))?;
    let (data, mime) = prepare(bytes)?;
    let name = std::path::Path::new(&file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("picture")
        .to_string();
    let body = json!({
        "project": project,
        "mime": mime,
        "name": name,
        "data": base64::engine::general_purpose::STANDARD.encode(&data),
    });
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
    let res = agent
        .post(&format!("{server}/api/images"))
        .set("authorization", &format!("Bearer {key}"))
        .set("content-type", "application/json")
        .send_string(&body.to_string());
    let text = match res {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(_, r)) => {
            let t = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&t).ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or(t);
            return Err(msg);
        }
        Err(e) => return Err(format!("could not reach {server} ({e}).")),
    };
    let v: Value = serde_json::from_str(&text).map_err(|_| "unexpected answer from the server.".to_string())?;
    v["markdown"].as_str().map(String::from).ok_or_else(|| "unexpected answer from the server.".into())
}

/// The line the SessionStart hook adds so Claudes know how to add pictures.
pub fn how_to() -> String {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "Baton.exe".into());
    let p = "<the project slug this brief names>";
    format!(
        "To add a picture from this PC (a screenshot, render or reference) to a Baton note or message: run `\"{exe}\" --picture \"<file path>\" --project {p}` in Bash (in PowerShell: `& \"{exe}\" --picture \"<file path>\" --project {p} | Out-String`). It prints markdown like ![name](link): put that in the baton_write body or baton_post text."
    )
}

//! Subscribes to and downloads Steam Workshop items for Total War Modding Tools
//! extension, as the game (Steam app id) they belong to.
//!
//! The extension runs this as a short-lived child process, so Steam shows the
//! user "in game" only while it runs. Output is one JSON object per line:
//!
//! ```text
//! steam-helper <app id> info <item id>...
//!   {"event":"item","id":"1","title":"…","state":5,"folder":"…","children":["2"]}
//!   {"event":"missing","id":"3"}                 (no such item, or not visible)
//! steam-helper <app id> subscribe <item id>...
//!   {"event":"progress","id":"1","done":123,"total":456}
//!   {"event":"installed","id":"1","folder":"…"}
//!   {"event":"error","id":"1","message":"…"}
//! both end with {"event":"done"}; on failure {"event":"fatal","message":"…"} and exit code 1.
//! ```

use std::collections::{HashMap, HashSet};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread::sleep;
use std::time::{Duration, Instant};

use steamworks::{Client, ItemState, PublishedFileId};

/// Seconds without download progress before an item is reported as failed.
const STALL_TIMEOUT: Duration = Duration::from_secs(120);
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_millis(100);

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn emit(line: String) {
    println!("{line}");
}

fn fatal(message: &str) -> ExitCode {
    emit(format!("{{\"event\":\"fatal\",\"message\":{}}}", json_str(message)));
    ExitCode::from(1)
}

fn installed_folder(client: &Client, id: PublishedFileId) -> Option<String> {
    let ugc = client.ugc();
    let state = ugc.item_state(id);
    if !state.contains(ItemState::INSTALLED) || state.contains(ItemState::NEEDS_UPDATE) {
        return None;
    }
    ugc.item_install_info(id).map(|i| i.folder)
}

fn info(client: &Client, ids: &[PublishedFileId]) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let query = client
        .ugc()
        .query_items(ids.to_vec())
        .map_err(|e| e.to_string())?
        .include_children(true)
        .allow_cached_response(60);
    query.fetch(move |res| {
        let out = res.map(|results| {
            (0..results.returned_results())
                .filter_map(|i| {
                    let item = results.get(i)?;
                    let children = results.get_children(i).unwrap_or_default();
                    Some((item.published_file_id, item.title, item.file_size, children))
                })
                .collect::<Vec<_>>()
        });
        let _ = tx.send(out);
    });

    let deadline = Instant::now() + QUERY_TIMEOUT;
    let results = loop {
        client.run_callbacks();
        match rx.try_recv() {
            Ok(r) => break r.map_err(|e| format!("Workshop query failed: {e}"))?,
            Err(mpsc::TryRecvError::Empty) if Instant::now() < deadline => sleep(TICK),
            Err(_) => return Err("Workshop query timed out.".into()),
        }
    };

    let mut seen = HashSet::new();
    for (id, title, size, children) in results {
        // Steam returns id 0 with an empty title for items that don't exist.
        if id.0 == 0 || (title.is_empty() && size == 0) {
            continue;
        }
        seen.insert(id.0);
        let state = client.ugc().item_state(id);
        let folder = installed_folder(client, id);
        let children: Vec<String> = children.iter().map(|c| json_str(&c.0.to_string())).collect();
        emit(format!(
            "{{\"event\":\"item\",\"id\":{},\"title\":{},\"state\":{},\"folder\":{},\"children\":[{}]}}",
            json_str(&id.0.to_string()),
            json_str(&title),
            state.bits(),
            folder.map(|f| json_str(&f)).unwrap_or_else(|| "null".into()),
            children.join(",")
        ));
    }
    for id in ids {
        if !seen.contains(&id.0) {
            emit(format!("{{\"event\":\"missing\",\"id\":{}}}", json_str(&id.0.to_string())));
        }
    }
    Ok(())
}

fn subscribe(client: &Client, ids: &[PublishedFileId]) {
    let ugc = client.ugc();
    let (tx, rx) = mpsc::channel();
    for &id in ids {
        if ugc.item_state(id).contains(ItemState::SUBSCRIBED) {
            let _ = tx.send((id, Ok(())));
        } else {
            let tx = tx.clone();
            ugc.subscribe_item(id, move |r| {
                let _ = tx.send((id, r));
            });
        }
    }
    drop(tx);

    // Per item: last progress (bytes) and when it last changed.
    let mut pending: HashMap<u64, (u64, Instant)> = HashMap::new();
    let mut waiting_subscribe: HashSet<u64> = ids.iter().map(|i| i.0).collect();
    let started = Instant::now();

    loop {
        client.run_callbacks();
        while let Ok((id, result)) = rx.try_recv() {
            waiting_subscribe.remove(&id.0);
            match result {
                Ok(()) => {
                    ugc.download_item(id, true);
                    pending.insert(id.0, (0, Instant::now()));
                }
                Err(e) => emit(format!(
                    "{{\"event\":\"error\",\"id\":{},\"message\":{}}}",
                    json_str(&id.0.to_string()),
                    json_str(&format!("Could not subscribe: {e}"))
                )),
            }
        }
        if !waiting_subscribe.is_empty() && started.elapsed() > QUERY_TIMEOUT {
            for id in waiting_subscribe.drain() {
                emit(format!(
                    "{{\"event\":\"error\",\"id\":{},\"message\":\"Steam did not answer the subscribe request.\"}}",
                    json_str(&id.to_string())
                ));
            }
        }

        let mut finished = Vec::new();
        for (&raw, (last, changed)) in pending.iter_mut() {
            let id = PublishedFileId(raw);
            if let Some(folder) = installed_folder(client, id) {
                emit(format!(
                    "{{\"event\":\"installed\",\"id\":{},\"folder\":{}}}",
                    json_str(&raw.to_string()),
                    json_str(&folder)
                ));
                finished.push(raw);
                continue;
            }
            if let Some((done, total)) = ugc.item_download_info(id) {
                if done != *last {
                    *last = done;
                    *changed = Instant::now();
                    emit(format!(
                        "{{\"event\":\"progress\",\"id\":{},\"done\":{done},\"total\":{total}}}",
                        json_str(&raw.to_string())
                    ));
                }
            }
            if changed.elapsed() > STALL_TIMEOUT {
                emit(format!(
                    "{{\"event\":\"error\",\"id\":{},\"message\":\"The download made no progress for {} seconds.\"}}",
                    json_str(&raw.to_string()),
                    STALL_TIMEOUT.as_secs()
                ));
                finished.push(raw);
            }
        }
        for raw in finished {
            pending.remove(&raw);
        }

        if pending.is_empty() && waiting_subscribe.is_empty() {
            return;
        }
        sleep(TICK);
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        return fatal("usage: steam-helper <app id> info|subscribe <item id>...");
    }
    let Ok(app_id) = args[0].parse::<u32>() else {
        return fatal("The app id must be a number.");
    };
    let mut ids = Vec::new();
    for a in &args[2..] {
        match a.parse::<u64>() {
            Ok(id) => ids.push(PublishedFileId(id)),
            Err(_) => return fatal(&format!("\"{a}\" is not a Workshop item id.")),
        }
    }

    let client = match Client::init_app(app_id) {
        Ok(c) => c,
        Err(e) => return fatal(&format!("Steam is not available ({e}). Start Steam and sign in with the account that owns the game.")),
    };

    match args[1].as_str() {
        "info" => {
            if let Err(e) = info(&client, &ids) {
                return fatal(&e);
            }
        }
        "subscribe" => subscribe(&client, &ids),
        other => return fatal(&format!("Unknown command \"{other}\".")),
    }
    emit("{\"event\":\"done\"}".into());
    ExitCode::SUCCESS
}

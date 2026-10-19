//! Explicit offline operations, under the very same storage lease as the host.
//! No provider/config/network startup and no archive reachability guessing.
use super::{database::Database, format::StorageLease, inbox::TelegramStore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
#[path = "maintenance_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "maintenance_wal_tests.rs"]
mod wal_tests;

const USAGE: &str = "Usage: pi-acp-workbenchd storage export|reset|gc --root ABSOLUTE [--destination ABSOLUTE] --confirm";

pub async fn run(args: &[String]) -> io::Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("");
    if !matches!(command, "export" | "reset" | "gc") {
        return Err(io::Error::other(USAGE));
    }
    let (mut root, mut destination, mut confirmed) = (None, None, false);
    let mut args = args[1..].iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" if root.is_none() => root = args.next().map(PathBuf::from),
            "--destination" if destination.is_none() => {
                destination = args.next().map(PathBuf::from)
            }
            "--confirm" if !confirmed => confirmed = true,
            _ => return Err(io::Error::other(USAGE)),
        }
    }
    if !confirmed {
        return Err(io::Error::other("explicit --confirm is required"));
    }
    let root = root.ok_or_else(|| io::Error::other(USAGE))?;
    if !root.is_absolute() || root.parent().is_none() || fs::canonicalize(&root)? != root {
        return Err(io::Error::other(
            "root must be a canonical absolute non-root path",
        ));
    }
    if (command == "export") != destination.is_some() {
        return Err(io::Error::other(USAGE));
    }
    // A persistent lock file is normal, NOT evidence that it must be unlinked.
    // Never unlink it: doing so would create two independent flock identities.
    let lease = StorageLease::acquire_existing(&root)?;
    if fs::symlink_metadata(root.join("workbench.sock")).is_ok() {
        return Err(io::Error::other(
            "socket exists; stop/inspect the host before maintenance",
        ));
    }
    // Preflight every descendant before any destination creation or deletion.
    // Reject symlinks, sockets, FIFOs and other special files, even if dangling.
    let mut files = Vec::new();
    inventory(&root, Path::new(""), &mut files)?;
    match command {
        "export" => export(&root, &destination.unwrap(), files),
        "reset" => {
            if fs::read_dir(&root)?.any(|entry| {
                entry.map_or(true, |entry| {
                    entry.file_name() != ".workbench.lock"
                        && entry.file_name() != "storage-format.json"
                })
            }) {
                return Err(io::Error::other("reset refuses data-bearing storage"));
            }
            // Keep directory and stable lock inode. Another host may already
            // have opened that inode and be waiting for this lease to release.
            fs::remove_file(root.join("storage-format.json"))?;
            File::open(&root)?.sync_all()?;
            println!("reset marker-only storage (directory/lease inode retained)");
            Ok(())
        }
        "gc" => {
            // Only completed inbox / unreferenced expired callbacks are compacted.
            let (inbox, callbacks) = if root.join("workbench.sqlite3").exists() {
                let database = Database::open(root.clone(), &lease)
                    .await
                    .map_err(io::Error::other)?;
                let result = TelegramStore::new(database.clone(), 1024)
                    .compact(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map_err(io::Error::other)?
                            .as_secs(),
                    )
                    .await;
                let closed = database.shutdown().await;
                let counts = result.map_err(io::Error::other)?;
                closed.map_err(io::Error::other)?;
                counts
            } else {
                (0, 0)
            };
            println!("{{\"removed_inbox\":{inbox},\"removed_callbacks\":{callbacks}}}");
            Ok(())
        }
        _ => unreachable!(),
    }
}

fn inventory(root: &Path, relative: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let path = relative.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            inventory(root, &path, files)?;
        } else if kind.is_file() {
            if path != Path::new(".workbench.lock") {
                files.push(path);
            }
        } else {
            return Err(io::Error::other("storage contains symlink or special file"));
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct ExportFile {
    path: PathBuf,
    bytes: u64,
    sha256: String,
}
#[derive(Serialize)]
struct Manifest<'a> {
    source: &'a Path,
    format_version: u32,
    files: Vec<ExportFile>,
}
fn export(root: &Path, destination: &Path, mut files: Vec<PathBuf>) -> io::Result<()> {
    let name = destination
        .file_name()
        .ok_or_else(|| io::Error::other("invalid destination"))?;
    if !destination.is_absolute() || destination.exists() {
        return Err(io::Error::other("destination must be new and absolute"));
    }
    // Canonicalize the existing parent before overlap checks; a symlink alias
    // may not place the export inside its source or overwrite another tree.
    let parent = fs::canonicalize(destination.parent().unwrap())?;
    let destination = parent.join(name);
    if destination.starts_with(root) || root.starts_with(&destination) {
        return Err(io::Error::other("destination overlaps storage root"));
    }
    if files
        .iter()
        .any(|file| file == Path::new("EXPORT-MANIFEST.json"))
    {
        return Err(io::Error::other(
            "source already contains an export manifest",
        ));
    }
    fs::DirBuilder::new().mode(0o700).create(&destination)?;
    // An interrupted/failed export is retained for inspection, never claimed
    // successful. No recursive cleanup can remove an operator's added files.
    files.sort();
    let mut manifest = Manifest {
        source: root,
        format_version: super::FORMAT_VERSION,
        files: Vec::new(),
    };
    for path in files {
        let target = destination.join(&path);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(target.parent().unwrap())?;
        let mut source = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join(&path))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(target)?;
        let mut hash = Sha256::new();
        let mut bytes = 0;
        let mut buffer = [0; 65536];
        loop {
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            hash.update(&buffer[..count]);
            bytes += count as u64;
        }
        output.sync_all()?;
        File::open(destination.join(&path).parent().unwrap())?.sync_all()?;
        manifest.files.push(ExportFile {
            path,
            bytes,
            sha256: format!("{:x}", hash.finalize()),
        });
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination.join("EXPORT-MANIFEST.json"))?;
    serde_json::to_writer_pretty(&mut output, &manifest)?;
    output.write_all(b"\n")?;
    output.sync_all()?;
    File::open(&destination)?.sync_all()?;
    File::open(parent)?.sync_all()?;
    println!("exported {} files", manifest.files.len());
    Ok(())
}

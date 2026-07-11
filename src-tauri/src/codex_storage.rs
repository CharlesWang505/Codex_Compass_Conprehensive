use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use tauri::{App, Manager};

pub fn setup(app: &App) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let target = app_data.join("codex");
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;

    let legacy = directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().join(".codex_plus"))
        .filter(|path| path.exists());
    if let Some(legacy) = legacy {
        // Migration is deliberately additive: keep the legacy tree intact and
        // never replace files that already exist in the unified directory.
        copy_missing_tree(&legacy, &target).map_err(|error| error.to_string())?;
    }

    if let Some(legacy_scripts) = legacy_user_scripts_root().filter(|path| path.exists()) {
        migrate_legacy_user_scripts(&legacy_scripts, &target).map_err(|error| error.to_string())?;
    }

    codex_plus_core::paths::set_app_state_dir_override(Some(target.clone()));
    Ok(target)
}

fn legacy_user_scripts_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Codex_Plus"));
    }

    #[cfg(not(windows))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.home_dir().join(".config")))
            .map(|path| path.join("Codex_Plus"))
    }
}

fn migrate_legacy_user_scripts(legacy_root: &Path, codex_target: &Path) -> io::Result<()> {
    let scripts_target = codex_target.join("scripts");
    let legacy_config = legacy_root.join("user_scripts.json");
    if legacy_config.is_file() {
        fs::create_dir_all(&scripts_target)?;
        copy_missing_file(&legacy_config, &scripts_target.join("user_scripts.json"))?;
    }

    let legacy_scripts = legacy_root.join("user_scripts");
    if legacy_scripts.is_dir() {
        copy_missing_tree(&legacy_scripts, &scripts_target)?;
    }
    Ok(())
}

fn copy_missing_tree(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            // Do not follow links out of the legacy state directory.
            continue;
        }
        if file_type.is_dir() {
            copy_missing_tree(&source_path, &target_path)?;
        } else if file_type.is_file() {
            copy_missing_file(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn copy_missing_file(source: &Path, target: &Path) -> io::Result<()> {
    let mut source_file = fs::File::open(source)?;
    let mut target_file = match OpenOptions::new().write(true).create_new(true).open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };

    if let Err(error) = io::copy(&mut source_file, &mut target_file) {
        drop(target_file);
        let _ = fs::remove_file(target);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_copies_missing_files_without_overwriting_or_deleting_source() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(source.path().join("nested")).unwrap();
        fs::create_dir_all(target.path().join("nested")).unwrap();
        fs::write(source.path().join("settings.json"), b"legacy").unwrap();
        fs::write(source.path().join("nested").join("new.json"), b"new").unwrap();
        fs::write(source.path().join("nested").join("keep.json"), b"old").unwrap();
        fs::write(target.path().join("nested").join("keep.json"), b"current").unwrap();

        copy_missing_tree(source.path(), target.path()).unwrap();

        assert_eq!(
            fs::read(target.path().join("settings.json")).unwrap(),
            b"legacy"
        );
        assert_eq!(
            fs::read(target.path().join("nested").join("new.json")).unwrap(),
            b"new"
        );
        assert_eq!(
            fs::read(target.path().join("nested").join("keep.json")).unwrap(),
            b"current"
        );
        assert_eq!(
            fs::read(source.path().join("settings.json")).unwrap(),
            b"legacy"
        );
    }

    #[test]
    fn legacy_user_scripts_move_to_unified_directory_without_overwriting() {
        let legacy = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(legacy.path().join("user_scripts")).unwrap();
        fs::create_dir_all(target.path().join("scripts")).unwrap();
        fs::write(
            legacy.path().join("user_scripts.json"),
            br#"{"enabled":true}"#,
        )
        .unwrap();
        fs::write(
            legacy.path().join("user_scripts").join("new.js"),
            b"legacy-new",
        )
        .unwrap();
        fs::write(
            legacy.path().join("user_scripts").join("keep.js"),
            b"legacy-keep",
        )
        .unwrap();
        fs::write(target.path().join("scripts").join("keep.js"), b"current").unwrap();

        migrate_legacy_user_scripts(legacy.path(), target.path()).unwrap();

        assert_eq!(
            fs::read(target.path().join("scripts").join("user_scripts.json")).unwrap(),
            br#"{"enabled":true}"#
        );
        assert_eq!(
            fs::read(target.path().join("scripts").join("new.js")).unwrap(),
            b"legacy-new"
        );
        assert_eq!(
            fs::read(target.path().join("scripts").join("keep.js")).unwrap(),
            b"current"
        );
        assert_eq!(
            fs::read(legacy.path().join("user_scripts").join("keep.js")).unwrap(),
            b"legacy-keep"
        );
        assert!(legacy.path().join("user_scripts.json").exists());
    }
}

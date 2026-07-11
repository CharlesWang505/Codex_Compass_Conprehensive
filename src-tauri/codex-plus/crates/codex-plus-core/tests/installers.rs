use codex_plus_core::install::{
    InstallOptions, build_macos_app_bundle, build_windows_entrypoint_plan,
    default_install_root_strategy,
};

#[test]
fn windows_entrypoint_plan_contains_unified_app_entrypoint() {
    let options = InstallOptions {
        install_root: Some("C:/Users/A/Desktop".into()),
        launcher_path: Some("C:/Tools/codex_plus.exe".into()),
        manager_path: Some("C:/Tools/codex_plus.exe".into()),
        remove_owned_data: false,
    };

    let plan = build_windows_entrypoint_plan(&options);

    assert!(plan.silent_shortcut.ends_with("Codex_Plus.lnk"));
    assert_eq!(plan.launcher_path, "C:/Tools/codex_plus.exe");
    assert_eq!(plan.manager_path, "C:/Tools/codex_plus.exe");
    assert_eq!(plan.silent_icon_path, "C:/Tools/codex_plus.exe");
    assert_eq!(plan.manager_icon_path, "C:/Tools/codex_plus.exe");
    assert_eq!(plan.uninstall_key, "Codex_Plus");
    assert_eq!(
        plan.uninstaller_path.replace('\\', "/"),
        "C:/Tools/uninstall.exe"
    );
    assert_eq!(
        plan.uninstall_command.replace('\\', "/"),
        "\"C:/Tools/uninstall.exe\""
    );
    assert_eq!(
        plan.quiet_uninstall_command.replace('\\', "/"),
        "\"C:/Tools/uninstall.exe\" /S"
    );
    assert_ne!(plan.uninstall_command, "\"C:/Tools/codex_plus.exe\"");
}

#[test]
fn windows_entrypoint_plan_can_request_owned_data_removal_without_shell_script() {
    let options = InstallOptions {
        install_root: Some("C:/Users/A/Desktop".into()),
        launcher_path: None,
        manager_path: None,
        remove_owned_data: true,
    };

    let plan = build_windows_entrypoint_plan(&options);

    assert!(plan.silent_shortcut.ends_with("Codex_Plus.lnk"));
    assert!(plan.remove_owned_data);
}

#[test]
fn macos_bundle_metadata_contains_one_unified_app() {
    let options = InstallOptions {
        install_root: Some("/Applications".into()),
        launcher_path: Some("/opt/Codex_Plus/codex_plus".into()),
        manager_path: Some("/opt/Codex_Plus/codex_plus".into()),
        remove_owned_data: false,
    };

    let silent = build_macos_app_bundle(&options, false);

    assert!(silent.app_path.ends_with("Codex_Plus.app"));
    assert!(silent.info_plist.contains("<string>Codex_Plus</string>"));
    assert_eq!(silent.binary_target_name.as_deref(), Some("codex_plus"));
    assert!(silent.launch_script.contains("$DIR/codex_plus"));
}

#[test]
#[cfg(target_os = "macos")]
fn macos_dmg_includes_applications_shortcut_for_drag_install() {
    let script = std::fs::read_to_string("../../scripts/installer/macos/package-dmg.sh")
        .expect("read macOS DMG packaging script");

    assert!(script.contains("ln -s /Applications \"$STAGE/Applications\""));
}

#[test]
fn macos_bundle_does_not_wrap_the_bundle_executable_in_itself() {
    let options = InstallOptions {
        install_root: Some("/Applications".into()),
        launcher_path: Some("/Applications/Codex_Plus.app/Contents/MacOS/Codex_Plus".into()),
        manager_path: Some("/Applications/Codex_Plus.app/Contents/MacOS/Codex_Plus".into()),
        remove_owned_data: false,
    };

    let silent = build_macos_app_bundle(&options, false);

    assert_eq!(
        silent.binary_source,
        Some(std::path::PathBuf::from(
            "/Applications/Codex_Plus.app/Contents/MacOS/Codex_Plus"
        ))
    );
    assert!(silent.launch_script.contains("$DIR/codex_plus"));
}

#[test]
fn windows_default_install_root_uses_known_folder_before_userprofile_desktop() {
    let strategy = default_install_root_strategy();

    if cfg!(windows) {
        assert_eq!(strategy, "windows-known-folder");
    } else if cfg!(target_os = "macos") {
        assert_eq!(strategy, "macos-applications");
    } else {
        assert_eq!(strategy, "user-dirs-desktop");
    }
}

use std::fs;
use std::net::Ipv6Addr;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use thiserror::Error;

use super::defaults::{default_remote_name, refs_from_output, worktree_branches_from_output};
use super::git::{qualified_remote_ref, source_ref, string_field};
use super::types::{
    GitOutput, RemoteGitCommand, UpstreamRemoteProject, UpstreamWorktreeCode,
    UpstreamWorktreeError, UpstreamWorktreeRequest, UpstreamWorktreeResult,
    UpstreamWorktreeSourceRequest,
};

#[derive(Debug, Error)]
enum RemoteSshError {
    #[error("{0}")]
    Validation(&'static str),
    #[error("Cannot read Codex remote connection state")]
    StateRead(#[source] std::io::Error),
    #[error("Cannot parse Codex remote connection state")]
    StateParse(#[source] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SshTarget {
    user: String,
    host: String,
    port: Option<u16>,
}

fn state_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn parse_ssh_port(value: Option<&Value>) -> Result<Option<u16>, RemoteSshError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => parse_ssh_port_string(value.trim()),
        Some(Value::Number(value)) => value
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port > 0)
            .map(Some)
            .ok_or(RemoteSshError::Validation("Invalid SSH port")),
        _ => Err(RemoteSshError::Validation("Invalid SSH port")),
    }
}

fn parse_ssh_port_string(value: &str) -> Result<Option<u16>, RemoteSshError> {
    if value.is_empty() {
        return Ok(None);
    }
    if !value.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(RemoteSshError::Validation("Invalid SSH port"));
    }
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .map(Some)
        .ok_or(RemoteSshError::Validation("Invalid SSH port"))
}

fn split_ssh_authority(value: &str) -> Result<(String, String, Option<u16>), RemoteSshError> {
    let mut authority = value.trim();
    let mut user = "";
    if let Some(index) = authority.rfind('@') {
        user = &authority[..index];
        authority = &authority[index + 1..];
    }
    if authority.starts_with('[') {
        if let Some(close_index) = authority.find(']') {
            let host = authority[..=close_index].trim().to_string();
            let suffix = &authority[close_index + 1..];
            let port = suffix
                .strip_prefix(':')
                .map(parse_ssh_port_string)
                .transpose()?
                .flatten();
            return Ok((user.trim().to_string(), host, port));
        }
        return Ok((user.trim().to_string(), authority.trim().to_string(), None));
    }
    if authority.matches(':').count() == 1 {
        let (host, raw_port) = authority.rsplit_once(':').unwrap_or((authority, ""));
        if !raw_port.is_empty() && raw_port.chars().all(|ch| ch.is_ascii_digit()) {
            return Ok((
                user.trim().to_string(),
                host.trim().to_string(),
                parse_ssh_port_string(raw_port)?,
            ));
        }
    }
    Ok((user.trim().to_string(), authority.trim().to_string(), None))
}

fn validate_ssh_host(host: &str) -> Result<String, RemoteSshError> {
    let host = host.trim();
    if host.is_empty() {
        return Err(RemoteSshError::Validation(
            "Cannot determine remote SSH host",
        ));
    }
    if host
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || matches!(ch, '/' | '?' | '#' | '@'))
    {
        return Err(RemoteSshError::Validation("Invalid SSH host"));
    }
    if host.starts_with('[') || host.ends_with(']') {
        if !(host.starts_with('[') && host.ends_with(']')) {
            return Err(RemoteSshError::Validation("Invalid SSH host"));
        }
        host[1..host.len() - 1]
            .parse::<Ipv6Addr>()
            .map_err(|_| RemoteSshError::Validation("Invalid SSH host"))?;
    } else if host.contains('[') || host.contains(']') {
        return Err(RemoteSshError::Validation("Invalid SSH host"));
    }
    Ok(host.to_string())
}

fn target_from_managed_remote_connection(
    connection: &serde_json::Map<String, Value>,
) -> Result<SshTarget, RemoteSshError> {
    let ssh_host = {
        let value = state_string(connection.get("sshHost"));
        if value.is_empty() {
            state_string(connection.get("hostname"))
        } else {
            value
        }
    };
    let ssh_alias = {
        let value = state_string(connection.get("sshAlias"));
        if value.is_empty() {
            state_string(connection.get("alias"))
        } else {
            value
        }
    };
    let (authority_user, authority_host, authority_port) = split_ssh_authority(&ssh_host)?;
    let host = if authority_host.is_empty() {
        ssh_alias
    } else {
        authority_host
    };
    let user = {
        let value = state_string(connection.get("sshUser"));
        let value = if value.is_empty() {
            state_string(connection.get("user"))
        } else {
            value
        };
        if value.is_empty() {
            authority_user
        } else {
            value
        }
    };
    let port = match connection.get("sshPort") {
        Some(Value::Null) | None => authority_port,
        Some(Value::String(value)) if value.trim().is_empty() => authority_port,
        value => parse_ssh_port(value)?,
    };
    Ok(SshTarget {
        user,
        host: validate_ssh_host(&host)?,
        port,
    })
}

fn resolve_ssh_target_from_global_state(
    state: &Value,
    host_id: &str,
) -> Result<SshTarget, RemoteSshError> {
    if host_id.trim().is_empty() {
        return Err(RemoteSshError::Validation("Remote host id is required"));
    }
    for connection in state
        .get("codex-managed-remote-connections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(connection) = connection.as_object() else {
            continue;
        };
        if state_string(connection.get("hostId")) == host_id {
            return target_from_managed_remote_connection(connection);
        }
    }
    Err(RemoteSshError::Validation("Cannot resolve remote SSH host"))
}

fn resolve_ssh_target_for_host_id(host_id: &str) -> Result<SshTarget, RemoteSshError> {
    let data = fs::read_to_string(codex_global_state_path()).map_err(RemoteSshError::StateRead)?;
    let state: Value = serde_json::from_str(&data).map_err(RemoteSshError::StateParse)?;
    resolve_ssh_target_from_global_state(&state, host_id)
}

pub fn codex_global_state_path() -> PathBuf {
    crate::codex_home::default_codex_home_dir().join(".codex-global-state.json")
}

pub fn remote_project_from_state(state: &Value, project_id: &str) -> Option<UpstreamRemoteProject> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return None;
    }
    state
        .get("remote-projects")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_object)
        .find_map(|project| {
            let project_value = Value::Object(project.clone());
            if string_field(&project_value, "id") != project_id {
                return None;
            }
            let host_id = string_field(&project_value, "hostId");
            let remote_path = string_field(&project_value, "remotePath");
            if host_id.is_empty() || !remote_path.starts_with('/') {
                return None;
            }
            Some(UpstreamRemoteProject {
                project_id: project_id.to_string(),
                host_id,
                remote_path,
                label: string_field(&project_value, "label"),
            })
        })
}

pub fn remote_project_from_state_path(
    project_id: &str,
    state_path: &Path,
) -> Option<UpstreamRemoteProject> {
    let data = std::fs::read_to_string(state_path).ok()?;
    let state = serde_json::from_str::<Value>(&data).ok()?;
    remote_project_from_state(&state, project_id)
}

pub fn remote_project_for_id(project_id: &str) -> Option<UpstreamRemoteProject> {
    remote_project_from_state_path(project_id, &codex_global_state_path())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn ssh_destination(target: &SshTarget) -> String {
    if target.user.trim().is_empty() {
        target.host.trim().to_string()
    } else {
        format!("{}@{}", target.user.trim(), target.host.trim())
    }
}

fn remote_git_command(
    project: &UpstreamRemoteProject,
    target: &SshTarget,
    args: &[&str],
) -> RemoteGitCommand {
    let remote_command = std::iter::once("git".to_string())
        .chain(std::iter::once("-C".to_string()))
        .chain(std::iter::once(project.remote_path.clone()))
        .chain(args.iter().map(|arg| (*arg).to_string()))
        .map(|arg| shell_quote(&arg))
        .collect::<Vec<_>>()
        .join(" ");
    RemoteGitCommand {
        destination: ssh_destination(target),
        port: target.port,
        command: remote_command,
    }
}

fn spawn_remote_git(command_spec: &RemoteGitCommand) -> Result<GitOutput, std::io::Error> {
    let mut command = crate::windows_integration::background_command("ssh");
    command.arg("-o").arg("BatchMode=yes");
    command.arg("-o").arg("ConnectTimeout=8");
    if let Some(port) = command_spec.port {
        command.arg("-p").arg(port.to_string());
    }
    command
        .arg(&command_spec.destination)
        .arg(&command_spec.command);
    let output = command.output().map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("Cannot run remote git over SSH: {error}"),
        )
    })?;
    Ok(GitOutput {
        status_success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn remote_git(project: &UpstreamRemoteProject, args: &[&str]) -> UpstreamWorktreeResult<GitOutput> {
    let target = resolve_ssh_target_for_host_id(&project.host_id).map_err(|error| {
        UpstreamWorktreeError::new(UpstreamWorktreeCode::GitMissing, error.to_string())
    })?;
    let command_spec = remote_git_command(project, &target, args);
    let output = spawn_remote_git(&command_spec).map_err(|error| {
        UpstreamWorktreeError::new(UpstreamWorktreeCode::GitMissing, error.to_string())
    })?;
    Ok(output)
}

fn remote_shell(
    project: &UpstreamRemoteProject,
    script: &str,
) -> UpstreamWorktreeResult<GitOutput> {
    let target = resolve_ssh_target_for_host_id(&project.host_id).map_err(|error| {
        UpstreamWorktreeError::new(UpstreamWorktreeCode::GitMissing, error.to_string())
    })?;
    let command_spec = RemoteGitCommand {
        destination: ssh_destination(&target),
        port: target.port,
        command: script.to_string(),
    };
    let output = spawn_remote_git(&command_spec).map_err(|error| {
        UpstreamWorktreeError::new(UpstreamWorktreeCode::GitMissing, error.to_string())
    })?;
    Ok(output)
}

fn remote_defaults_snapshot_script(remote_path: &str) -> String {
    let quoted_remote_path = shell_quote(remote_path);
    [
        "set -e",
        &format!("cd {quoted_remote_path}"),
        "printf '__ROOT__\\n'",
        "git rev-parse --show-toplevel",
        "printf '__BRANCH__\\n'",
        "git branch --show-current || true",
        "printf '__REMOTES__\\n'",
        "git remote",
        "printf '__REFS__\\n'",
        "git for-each-ref '--format=%(refname)' refs/remotes",
        "printf '__WORKTREES__\\n'",
        "git worktree list --porcelain",
    ]
    .join("\n")
}

#[derive(Debug, Default)]
struct RemoteDefaultsSnapshot {
    root: String,
    branch: String,
    remotes: Vec<String>,
    refs_output: String,
    worktrees_output: String,
}

fn parse_remote_defaults_snapshot(output: &str) -> RemoteDefaultsSnapshot {
    let mut snapshot = RemoteDefaultsSnapshot::default();
    let mut section = "";

    for line in output.lines() {
        match line {
            "__ROOT__" => {
                section = "root";
                continue;
            }
            "__BRANCH__" => {
                section = "branch";
                continue;
            }
            "__REMOTES__" => {
                section = "remotes";
                continue;
            }
            "__REFS__" => {
                section = "refs";
                continue;
            }
            "__WORKTREES__" => {
                section = "worktrees";
                continue;
            }
            _ => {}
        }

        match section {
            "root" if snapshot.root.is_empty() => snapshot.root = line.trim().to_string(),
            "branch" if snapshot.branch.is_empty() => snapshot.branch = line.trim().to_string(),
            "remotes" => {
                let remote = line.trim();
                if !remote.is_empty() {
                    snapshot.remotes.push(remote.to_string());
                }
            }
            "refs" => {
                snapshot.refs_output.push_str(line);
                snapshot.refs_output.push('\n');
            }
            "worktrees" => {
                snapshot.worktrees_output.push_str(line);
                snapshot.worktrees_output.push('\n');
            }
            _ => {}
        }
    }

    snapshot
}

fn remote_repo_root(project: &UpstreamRemoteProject) -> UpstreamWorktreeResult<String> {
    let output = remote_git(project, &["rev-parse", "--show-toplevel"])?;
    if output.status_success && !output.stdout.is_empty() {
        Ok(output.stdout)
    } else {
        Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::NotGitRepo,
            if output.stderr.is_empty() {
                "Remote path is not inside a Git repository".to_string()
            } else {
                output.stderr
            },
        ))
    }
}

fn remote_names(project: &UpstreamRemoteProject) -> UpstreamWorktreeResult<Vec<String>> {
    let output = remote_git(project, &["remote"])?;
    if !output.status_success {
        return Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::RemoteMissing,
            if output.stderr.is_empty() {
                "Cannot read remote Git remotes".to_string()
            } else {
                output.stderr
            },
        ));
    }
    Ok(output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

pub fn defaults_for_remote_project(
    project: &UpstreamRemoteProject,
) -> UpstreamWorktreeResult<Value> {
    let output = remote_shell(
        project,
        &remote_defaults_snapshot_script(&project.remote_path),
    )?;
    if !output.status_success {
        return Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::NotGitRepo,
            if output.stderr.is_empty() {
                "Remote path is not inside a Git repository".to_string()
            } else {
                output.stderr
            },
        ));
    }
    let snapshot = parse_remote_defaults_snapshot(&output.stdout);
    let root = snapshot.root;
    if root.is_empty() {
        return Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::NotGitRepo,
            "Remote path is not inside a Git repository",
        ));
    }
    let branch = snapshot.branch;
    let remotes = snapshot.remotes;
    let default_base_branch = if branch.is_empty() {
        "main".to_string()
    } else {
        branch.clone()
    };
    let default_remote = default_remote_name(&remotes);
    Ok(json!({
        "status": "ok",
        "remoteProject": true,
        "projectId": project.project_id,
        "hostId": project.host_id,
        "remotePath": project.remote_path,
        "repoRoot": root,
        "currentBranch": branch,
        "defaultBaseBranch": default_base_branch,
        "remotes": remotes,
        "defaultRemote": default_remote,
        "upstreamRefs": refs_from_output(&snapshot.refs_output, &default_remote, &default_base_branch),
        "worktreeBranches": worktree_branches_from_output(&snapshot.worktrees_output),
    }))
}

fn remote_path_join(root: &str, path: &Path) -> String {
    let raw_path = path.to_string_lossy();
    if raw_path.starts_with('/') {
        raw_path.to_string()
    } else {
        let relative = raw_path
            .strip_prefix("./")
            .unwrap_or(raw_path.as_ref())
            .trim_start_matches('/');
        format!("{}/{}", root.trim_end_matches('/'), relative)
    }
}

fn ensure_remote_exists(remotes: &[String], remote: &str) -> UpstreamWorktreeResult<()> {
    if remotes.iter().any(|candidate| candidate == remote) {
        Ok(())
    } else {
        Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::RemoteMissing,
            format!("Remote does not exist: {remote}"),
        ))
    }
}

fn ensure_remote_branch_is_available(
    project: &UpstreamRemoteProject,
    branch_name: &str,
) -> UpstreamWorktreeResult<()> {
    let output = remote_git(
        project,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch_name}"),
        ],
    )?;
    if output.status_success {
        Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::BranchExists,
            format!("Branch already exists: {branch_name}"),
        ))
    } else {
        Ok(())
    }
}

fn fetch_remote_branch(
    project: &UpstreamRemoteProject,
    remote: &str,
    base_branch: &str,
) -> UpstreamWorktreeResult<()> {
    let refspec = format!("+refs/heads/{base_branch}:refs/remotes/{remote}/{base_branch}");
    let output = remote_git(project, &["fetch", remote, &refspec])?;
    if output.status_success {
        Ok(())
    } else {
        Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::FetchFailed,
            if output.stderr.is_empty() {
                format!("Failed to fetch {remote}/{base_branch}")
            } else {
                output.stderr
            },
        ))
    }
}

pub fn prepare_for_remote_project(
    project: &UpstreamRemoteProject,
    request: &UpstreamWorktreeSourceRequest,
) -> UpstreamWorktreeResult<Value> {
    let root = remote_repo_root(project)?;
    let remotes = remote_names(project)?;
    ensure_remote_exists(&remotes, &request.remote)?;
    if request.fetch {
        fetch_remote_branch(project, &request.remote, &request.base_branch)?;
    }
    let display_source_ref = source_ref(&request.remote, &request.base_branch);
    let qualified_source_ref = qualified_remote_ref(&request.remote, &request.base_branch);
    let source_head = ensure_source_ref_exists(project, &qualified_source_ref)?;
    Ok(json!({
        "status": "ok",
        "remoteProject": true,
        "projectId": project.project_id,
        "hostId": project.host_id,
        "repoRoot": root,
        "sourceRef": display_source_ref,
        "qualifiedSourceRef": qualified_source_ref,
        "sourceHead": source_head,
    }))
}

fn ensure_source_ref_exists(
    project: &UpstreamRemoteProject,
    qualified_ref: &str,
) -> UpstreamWorktreeResult<String> {
    let commit_ref = format!("{qualified_ref}^{{commit}}");
    let output = remote_git(project, &["rev-parse", "--verify", &commit_ref])?;
    if output.status_success && !output.stdout.is_empty() {
        Ok(output.stdout)
    } else {
        Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::BaseBranchMissing,
            format!("Base branch does not exist: {qualified_ref}"),
        ))
    }
}

fn add_remote_worktree(
    project: &UpstreamRemoteProject,
    branch_name: &str,
    worktree_path: &str,
    qualified_ref: &str,
) -> UpstreamWorktreeResult<()> {
    let output = remote_git(
        project,
        &[
            "worktree",
            "add",
            "-b",
            branch_name,
            worktree_path,
            qualified_ref,
        ],
    )?;
    if output.status_success {
        Ok(())
    } else {
        Err(UpstreamWorktreeError::new(
            UpstreamWorktreeCode::WorktreeCreateFailed,
            if output.stderr.is_empty() {
                "Failed to create remote worktree".to_string()
            } else {
                output.stderr
            },
        ))
    }
}

pub fn create_for_remote_project(
    project: &UpstreamRemoteProject,
    request: &UpstreamWorktreeRequest,
) -> UpstreamWorktreeResult<Value> {
    let root = remote_repo_root(project)?;
    let remotes = remote_names(project)?;
    ensure_remote_exists(&remotes, &request.remote)?;
    ensure_remote_branch_is_available(project, &request.branch_name)?;
    let worktree_path = remote_path_join(&root, &request.worktree_path);
    if request.fetch {
        fetch_remote_branch(project, &request.remote, &request.base_branch)?;
    }
    let display_source_ref = source_ref(&request.remote, &request.base_branch);
    let qualified_source_ref = qualified_remote_ref(&request.remote, &request.base_branch);
    let source_head = ensure_source_ref_exists(project, &qualified_source_ref)?;
    add_remote_worktree(
        project,
        &request.branch_name,
        &worktree_path,
        &qualified_source_ref,
    )?;
    Ok(json!({
        "status": "ok",
        "remoteProject": true,
        "projectId": project.project_id,
        "hostId": project.host_id,
        "repoRoot": root,
        "worktreePath": worktree_path,
        "branchName": request.branch_name,
        "sourceRef": display_source_ref,
        "sourceHead": source_head,
    }))
}

#[cfg(test)]
mod tests;

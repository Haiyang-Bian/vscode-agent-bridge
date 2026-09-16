# Shared HTTP service installation and recovery

Version 0.13.0 uses one Windows x64 daemon for the current user. It starts on login and stays ready when no VS Code window exists. Codex uses authenticated Streamable HTTP at a persisted `127.0.0.1` port and `/mcp`; it does not launch a transport process. Extension RPC stays at v11, including compatibility with the 0.12.0 extension. Descriptor discovery remains in use; active extension registration is deferred.

The formal service keeps its protected state and versioned binaries under `%USERPROFILE%\.vscode-agent-bridge\service`. This location is shared by packaged Codex, VS Code and Task Scheduler. Packaged applications can redirect `LocalAppData` writes to their private cache; publishing that logical path as a login-task executable can make the task fail with file-not-found even though the installing process sees the file. Custom isolated service directories should also be outside such application-private redirection.

## Install or migrate

Install the verified VSIX and run **VS Code Agent Bridge: Configure Codex**, or run the verified EXE:

```powershell
.\vscode-agent-bridge-mcp.exe service install
.\vscode-agent-bridge-mcp.exe service status
```

The CLI honors `CODEX_HOME`; `--config <absolute-config-path>` selects another Codex configuration. It validates the TOML and refuses an unmarked bridge entry or concurrent edits. The managed block uses `url`, an Authorization header, the same 64-tool allowlist and 10/120-second timeouts. Credentials are written directly to protected files; the configuration wizard does not put them on the clipboard.

If a TOML editor has inserted unrelated tables inside the bridge's begin/end comments, installation and removal report a conflict before changing the service. Move those settings outside the comments while preserving their table headers and values, then retry. Marker ownership is checked against parsed non-bridge settings; comments alone do not authorize deleting another plugin's configuration.

The installer stages and self-tests a version/hash-specific executable, saves a protected rollback record, stops the authenticated old daemon, updates the login task, starts and verifies the new daemon, and only then commits Codex configuration and the installation record. Repeating a current install keeps the existing daemon. Version files are retained for recovery.

Use a fresh Codex client to initialize, list tools and call `vscode_list_instances` followed by an explicit-instance IDE read. Existing clients can still own legacy 0.12 STDIO processes until they naturally close. Count the new shared daemon separately; never terminate all similarly named processes.

## Lifecycle commands

```powershell
.\vscode-agent-bridge-mcp.exe service start
.\vscode-agent-bridge-mcp.exe service stop
.\vscode-agent-bridge-mcp.exe service restart
.\vscode-agent-bridge-mcp.exe service uninstall
```

`serve` is the foreground daemon entry used directly by Task Scheduler. Its EXE hides the console. `--version` and `--self-test` are short-lived diagnostics. Service management is local CLI functionality and adds no MCP tools.

The login task uses the current identity, InteractiveToken, LeastPrivilege, IgnoreNew, no runtime limit, no network/idle requirement and no battery stop. A failure retries every minute up to three times. `service stop` drains active requests for at most ten seconds, cancels remaining RPC work, flushes usage and releases the single-instance handle. No VS Code instance is a normal ready state; IDE tools then return `NO_VSCODE_INSTANCE`.

## Doctor and failures

**Run Doctor** reports authenticated HTTP health, daemon PID/version, login-task settings and managed configuration state alongside extension lifecycle and workspace health. `service status` is also safe to capture: it omits credentials, raw configuration and internal IPC addresses.

| Condition | Action |
| --- | --- |
| Service installed but stopped | Run `service start` |
| Authentication/identity verification failed | Verify the installed version and protected identity file; do not start a second instance or copy credentials into logs |
| Configured port occupied | Resolve the port owner, then retry; the daemon never silently chooses a new address |
| Login task missing or altered | Rerun `service install` from the verified EXE |
| Unmanaged/invalid Codex entry | Review that entry in the editor; the installer does not overwrite it |
| Installation interrupted | Rerun `service install`; state-changing management commands first recover the protected transaction journal |

Configuration, credential, backup and transaction files have protected DACLs limited to the current SID and SYSTEM. ACL failure prevents publication. The stable singleton identity excludes product version. Management messages use domain-separated HMAC proofs with nonces and timestamps; the management secret is separate from the MCP Bearer credential and is never sent over IPC.

## Rollback and uninstall

A failed migration restores the previous task, identity, managed configuration and running service. It only stops the authenticated candidate boot created during the transaction. If concurrent configuration edits prevent safe restoration, the edits and private recovery record remain for review; no unrelated configuration is overwritten. Do not delete that record before resolving the conflict.

Uninstall stops the shared service, removes the login task and marked Codex block, and keeps other settings, private identity and version files. The configuration backup permits deliberate restoration of the previous client setup. Restoring an older product also requires its matching executable and task/configuration; do not point old STDIO configuration at the HTTP-only 0.13 executable.

## Isolated acceptance

`--service-dir <test-directory>` assigns a separate installation identity, task, credentials and port. Pair it with `--registry-dir <test-registry>` and `--config <test-config>`; neither may point to the formal installation during tests. `scripts/test-http-service.ts` verifies actual login-task install, idempotence, post-start failure rollback, managed restart and uninstall. Artifact acceptance additionally runs 20 competing compiled EXE starts and HTTP calls from an isolated VS Code profile.

The automated login test registers, inspects and runs the actual task without signing out the interactive desktop. A second Windows-user ACL denial test remains a separate acceptance requirement; same-identity ACL inspection is not evidence of that test.

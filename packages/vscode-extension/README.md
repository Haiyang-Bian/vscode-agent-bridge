# VS Code Agent Bridge extension

This package is the IDE runtime and user interface for VS Code Agent Bridge 0.14.0. It publishes one authenticated protocol-v12 descriptor per live trusted local window and exposes VS Code's current buffers, language services, Problems, terminal/Task/Debug state, extension metadata and guarded native actions to the shared HTTP daemon.

## Direct Bridge model

The extension no longer creates or loads Agent experiments. Requests select `instanceId` and `rootUri` directly. Writes revalidate trust, canonical local-root containment and the relevant version, SHA-256, resource, configuration or workflow fingerprint immediately before applying. Prepared change sets, Marketplace plans, Tasks and Debug configurations are short-lived, instance/root-bound and one-use where required.

The extension does not expose generic filesystem or Git operations, terminal input, arbitrary commands or unrestricted Debug Adapter requests. Task and Debug effects outside the workspace are not recoverable. Global extension-configuration changes retain the bounded local undo journal; workspace writes use stale-state checks, atomic replacement where applicable and immediate failure rollback only.

Agent operations do not open or focus editors. Activity presentation is best effort and cannot veto the underlying operation.

## User interface

The **VS Code Agent Bridge** Activity Bar container has exactly two views:

- **Status**: daemon/Codex health, instance publication, protocol compatibility, release alignment, trust, Problems, Task/Debug/terminal summaries, Doctor and usage-insight controls.
- **Agent Activity**: side-effecting operations, running Task/Debug work and failures. Selecting an item reveals its file, output, terminal, Task or Debug target; ordinary reads are not recorded.

Commands remain available for Configure Codex, Configure Bridge, Remove Codex Configuration, Run Doctor, undoing the latest unchanged Global Profile setting, opening the native Profiles UI, and exporting or clearing local insight aggregates.

Legacy experiment storage is never loaded. Status reports its presence and offers **Open Legacy Experiment Data Location** or **Delete Legacy Experiment Data**. Deletion requires a second confirmation and is limited to Bridge-owned metadata/snapshots; it never removes Git branches or worktrees.

## Installation and compatibility

The side-loaded VSIX bundles the hidden-console Windows x64 daemon executable. **Configure Codex** installs or upgrades the per-user service and writes the authenticated Streamable HTTP block. Protocol-v11 descriptors remain visible as incompatible so an old window is distinguishable from a missing window. `releaseAlignment` separately reports `current`, `older`, `newer` or `unknown` for protocol-compatible instances.

See the repository [installation guide](../../docs/installation.md), [ADR 0023](../../docs/adr/0023-direct-ide-bridge.md) and root [README](../../README.md).

## 中文说明

0.14.0 插件不再要求实验、检查点或 Managed Worktree。Agent 直接选择 VS Code 实例与本地根目录，插件在每次操作前检查工作区信任、路径边界和陈旧状态。侧栏只保留 **Status** 与 **Agent Activity**；Agent 操作不会自动打开文件或抢占焦点。旧实验数据只提示、不加载，且必须由用户二次确认后才会删除 Bridge 自己的元数据和快照。

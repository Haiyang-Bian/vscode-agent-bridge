import { createHash, randomUUID } from "node:crypto";

import * as vscode from "vscode";

import {
  BridgeError,
  MAX_PREPARED_WORKFLOWS,
  PREPARED_WORKFLOW_TTL_MS,
  type ListTaskExecutionsParams,
  type ListTaskExecutionsResult,
  type ListTasksParams,
  type ListTasksResult,
  type PersistTaskParams,
  type PersistTaskResult,
  type PrepareTaskParams,
  type PrepareTaskResult,
  type PreparedTaskExecution,
  type RunTaskParams,
  type RunTaskResult,
  type TaskExecution,
  type TaskExecutionPreview,
  type TaskSummary,
  type TerminateTaskParams,
  type TerminateTaskResult,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker, type AgentActivityWorkflow } from "./agent-activity.js";
import { CanonicalPathBoundary } from "./canonical-path-boundary.js";
import { ExperimentManager } from "./experiment-manager.js";
import { TerminalObserver } from "./terminal-observer.js";
import { WorkflowProvenanceStore } from "./workflow-provenance.js";
import { WorkspaceConfigurationManager } from "./workspace-configuration-manager.js";

const TASK_RETENTION_MS = 30 * 60 * 1_000;
const MAX_TASK_EXECUTIONS = 200;
const AGENT_TASK_SOURCE = "Agent Bridge";

interface MutableTaskExecution extends TaskExecution {
  readonly rootUri: string;
  readonly sessionId: string;
  readonly vscodeExecution: vscode.TaskExecution;
  readonly workflow: AgentActivityWorkflow;
}

interface PreparedTaskRecord {
  readonly preparedTaskId: string;
  readonly sessionId: string;
  readonly rootUri: string;
  readonly createdAt: number;
  readonly expiresAt: string;
  readonly params: PrepareTaskParams;
  readonly task: vscode.Task;
  readonly summary: TaskSummary;
  readonly preview: TaskExecutionPreview;
  readonly activityOperationId: string;
}

interface SummarizedTask {
  readonly task: vscode.Task;
  readonly summary: TaskSummary;
  readonly preview: TaskExecutionPreview;
}

export class TaskManager implements vscode.Disposable {
  readonly #instanceId: string;
  readonly #experiments: ExperimentManager;
  readonly #terminals: TerminalObserver;
  readonly #activity: AgentActivityTracker;
  readonly #configurations: WorkspaceConfigurationManager;
  readonly #provenance: WorkflowProvenanceStore;
  readonly #prepared = new Map<string, PreparedTaskRecord>();
  readonly #executions = new Map<string, MutableTaskExecution>();
  readonly #executionIds = new Map<vscode.TaskExecution, string>();
  readonly #disposables: vscode.Disposable[];

  constructor(
    instanceId: string,
    experiments: ExperimentManager,
    terminals: TerminalObserver,
    activity: AgentActivityTracker,
    configurations: WorkspaceConfigurationManager,
    provenance: WorkflowProvenanceStore,
  ) {
    this.#instanceId = instanceId;
    this.#experiments = experiments;
    this.#terminals = terminals;
    this.#activity = activity;
    this.#configurations = configurations;
    this.#provenance = provenance;
    this.#disposables = [
      vscode.tasks.onDidStartTaskProcess((event) => this.#startProcess(event)),
      vscode.tasks.onDidEndTaskProcess((event) => this.#endProcess(event)),
      vscode.tasks.onDidEndTask((event) => void this.#endTask(event.execution)),
    ];
  }

  async prepareTask(params: PrepareTaskParams): Promise<PrepareTaskResult> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    if (experiment.rootUri !== params.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The prepared Task is outside the active experiment root.");
    }
    const root = resolveRoot(params.rootUri);
    const preparedTaskId = randomUUID();
    const execution = await createTaskExecution(params.execution, root);
    const task = new vscode.Task(
      { type: params.execution.kind === "process" ? "process" : "shell", agentBridgePreparedTaskId: preparedTaskId },
      root,
      params.label,
      AGENT_TASK_SOURCE,
      execution,
      [...params.problemMatchers],
    );
    const group = toVsCodeTaskGroup(params.group);
    if (group) task.group = group;
    task.isBackground = params.isBackground;
    task.detail = params.detail ?? `Prepared by VS Code Agent Bridge (${preparedTaskId})`;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      echo: true,
      focus: false,
      panel: vscode.TaskPanelKind.Shared,
      clear: false,
    };
    const summarized = summarizeTask(task, params.rootUri, "agentPrepared");
    const expiresAt = new Date(Date.now() + PREPARED_WORKFLOW_TTL_MS).toISOString();
    const workflow = taskWorkflow(summarized.summary, summarized.preview, null, null);
    const activityOperationId = this.#activity.record(
      {
        toolName: "vscode_prepare_task",
        title: `Prepared Task: ${params.label}`,
        reason: params.reason,
        workflow,
      },
      "succeeded",
    );
    this.#prepared.set(preparedTaskId, {
      preparedTaskId,
      sessionId: params.sessionId,
      rootUri: params.rootUri,
      createdAt: Date.now(),
      expiresAt,
      params,
      task,
      summary: summarized.summary,
      preview: summarized.preview,
      activityOperationId,
    });
    this.#prune();
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      preparedTaskId,
      task: summarized.summary,
      execution: summarized.preview,
      definitionFingerprint: summarized.summary.fingerprint,
      activityOperationId,
      expiresAt,
    };
  }

  async persistTask(params: PersistTaskParams): Promise<PersistTaskResult> {
    const record = await this.#requirePrepared(params.preparedTaskId, params.sessionId, params.rootUri);
    const existingProvenance = this.#provenance.find("task", params.rootUri, record.params.label);
    const value = persistedTaskValue(record.params, record.preparedTaskId);
    const persisted = await this.#configurations.persistWorkflowConfiguration({
      sessionId: params.sessionId,
      rootUri: params.rootUri,
      target: "tasks",
      name: record.params.label,
      value,
      expectedExists: params.expectedExists,
      expectedSha256: params.expectedSha256,
      replaceExisting: existingProvenance?.configurationSha256 === params.expectedSha256,
      conflictCode: "TASK_ALREADY_EXISTS",
      reason: params.reason,
    });
    const synthetic = await createPersistedTask(record.params, resolveRoot(params.rootUri));
    const summarized = summarizeTask(synthetic, params.rootUri, "agentPersisted");
    await this.#provenance.recordConfigurationWrite({
      kind: "task",
      preparedId: record.preparedTaskId,
      rootUri: params.rootUri,
      name: record.params.label,
      definitionFingerprint: summarized.summary.fingerprint,
      configurationSha256: persisted.contentSha256,
      createdAt: new Date().toISOString(),
    }, params.expectedSha256);
    this.#activity.record(
      {
        toolName: "vscode_persist_task",
        title: `Persisted Task: ${record.params.label}`,
        reason: params.reason,
        parentOperationId: record.activityOperationId,
        workflow: taskWorkflow(summarized.summary, summarized.preview, null, null),
      },
      "succeeded",
      { checkpointId: persisted.checkpointId, targets: [persisted.uri.toString(true)] },
    );
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      preparedTaskId: params.preparedTaskId,
      task: summarized.summary,
      uri: persisted.uri.toString(true),
      created: persisted.created,
      contentSha256: persisted.contentSha256,
      checkpointId: persisted.checkpointId,
      persistedAt: new Date().toISOString(),
    };
  }

  async listTasks(params: ListTasksParams): Promise<ListTasksResult> {
    const root = resolveRoot(params.rootUri);
    const [fetched, taskConfiguration] = await Promise.all([
      vscode.tasks.fetchTasks(params.type ? { type: params.type } : undefined),
      this.#configurations.getConfiguration({ rootUri: params.rootUri, target: "tasks" }),
    ]);
    const tasks = fetched
      .filter((task) => isTaskInRoot(task, root))
      .map((task) => {
        const candidate = summarizeTask(task, root.uri.toString(true), "workspace");
        const persisted = this.#provenance.find("task", params.rootUri, candidate.summary.label);
        return persisted
          && taskConfiguration.contentSha256 === persisted.configurationSha256
          ? summarizeTask(task, root.uri.toString(true), "agentPersisted")
          : candidate;
      });
    this.#prune();
    if (params.sessionId) {
      tasks.push(...[...this.#prepared.values()]
        .filter((record) => record.sessionId === params.sessionId && record.rootUri === params.rootUri)
        .map((record) => ({ task: record.task, summary: record.summary, preview: record.preview })));
    }
    const filtered = tasks
      .filter((task) => !params.type || task.summary.type === params.type)
      .filter((task) => !params.group || task.summary.group === params.group)
      .sort((left, right) => left.summary.label.localeCompare(right.summary.label));
    const visible = filtered.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      rootUri: params.rootUri,
      tasks: visible.map(({ summary }) => summary),
      returnedCount: visible.length,
      totalCount: filtered.length,
      truncated: params.offset + visible.length < filtered.length,
    };
  }

  async runTask(params: RunTaskParams): Promise<RunTaskResult> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    if (experiment.rootUri !== params.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The Task is outside the active experiment root.");
    }
    const root = resolveRoot(params.rootUri);
    this.#prune();
    const prepared = [...this.#prepared.values()].find(
      (record) => record.summary.taskId === params.taskId,
    );
    let task: SummarizedTask;
    let parentOperationId: string | null = null;
    if (prepared) {
      if (prepared.sessionId !== params.sessionId || prepared.rootUri !== params.rootUri) {
        throw new BridgeError("TASK_PREPARATION_NOT_FOUND", "The prepared Task belongs to another instance, session, or root.");
      }
      task = { task: prepared.task, summary: prepared.summary, preview: prepared.preview };
      parentOperationId = prepared.activityOperationId;
    } else {
      const [fetched, taskConfiguration] = await Promise.all([
        vscode.tasks.fetchTasks(),
        this.#configurations.getConfiguration({ rootUri: params.rootUri, target: "tasks" }),
      ]);
      const candidate = fetched
        .filter((item) => isTaskInRoot(item, root))
        .map((item) => summarizeTask(item, params.rootUri, "workspace"))
        .find(({ summary }) => summary.taskId === params.taskId);
      if (!candidate) throw new BridgeError("TASK_NOT_FOUND", "The listed Task no longer exists.");
      const persisted = this.#provenance.find("task", params.rootUri, candidate.summary.label);
      task = persisted && taskConfiguration.contentSha256 === persisted.configurationSha256
        ? summarizeTask(candidate.task, params.rootUri, "agentPersisted")
        : candidate;
    }
    if (task.summary.fingerprint !== params.expectedFingerprint) {
      throw new BridgeError("TASK_CHANGED", "The Task execution definition changed after it was listed.");
    }
    let vscodeExecution: vscode.TaskExecution;
    try {
      vscodeExecution = await vscode.tasks.executeTask(task.task);
    } catch {
      throw new BridgeError("TASK_START_FAILED", "VS Code could not start the selected Task.");
    }
    const executionId = randomUUID();
    const workflow = taskWorkflow(task.summary, task.preview, executionId, null);
    const activityOperationId = this.#activity.record(
      {
        toolName: "vscode_run_task",
        title: `Task running: ${task.summary.label}`,
        reason: params.reason,
        parentOperationId,
        workflow,
      },
      "running",
    );
    const execution: MutableTaskExecution = {
      executionId,
      taskId: task.summary.taskId,
      taskLabel: task.summary.label,
      status: "queued",
      startedAt: new Date().toISOString(),
      endedAt: null,
      processId: null,
      exitCode: null,
      terminalId: null,
      terminalExecutionId: null,
      terminalCoverage: "unavailable",
      origin: task.summary.origin,
      definitionFingerprint: task.summary.fingerprint,
      activityOperationId,
      checkpointId: null,
      rootUri: params.rootUri,
      sessionId: params.sessionId,
      vscodeExecution,
      workflow,
    };
    this.#executions.set(executionId, execution);
    this.#executionIds.set(vscodeExecution, executionId);
    this.#prune();
    return { instanceId: this.#instanceId, sessionId: params.sessionId, execution: publicExecution(execution) };
  }

  async assertTaskBinding(
    sessionId: string,
    rootUri: string,
    taskId: string,
    expectedFingerprint: string,
  ): Promise<string> {
    const listed = await this.listTasks({ rootUri, sessionId, offset: 0, limit: 500 });
    const task = listed.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new BridgeError("TASK_NOT_FOUND", "A bound Debug Task no longer exists.");
    if (task.fingerprint !== expectedFingerprint) {
      throw new BridgeError("TASK_CHANGED", "A bound Debug Task changed after the configuration was prepared.");
    }
    return task.label;
  }

  listTaskExecutions(params: ListTaskExecutionsParams): ListTaskExecutionsResult {
    this.#prune();
    const executions = [...this.#executions.values()]
      .filter((execution) => execution.rootUri === params.rootUri)
      .filter((execution) => !params.activeOnly || execution.endedAt === null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const visible = executions.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      rootUri: params.rootUri,
      executions: visible.map(publicExecution),
      returnedCount: visible.length,
      totalCount: executions.length,
      truncated: params.offset + visible.length < executions.length,
    };
  }

  async terminateTask(params: TerminateTaskParams): Promise<TerminateTaskResult> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    const execution = this.#executions.get(params.executionId);
    if (!execution || execution.sessionId !== params.sessionId) {
      throw new BridgeError("TASK_EXECUTION_NOT_FOUND", "The Task execution was not found.");
    }
    if (execution.rootUri !== experiment.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The Task execution belongs to another experiment root.");
    }
    if (execution.endedAt) throw new BridgeError("TASK_TERMINATION_FAILED", "The Task execution has already ended.");
    try {
      execution.vscodeExecution.terminate();
      execution.status = "terminated";
    } catch {
      throw new BridgeError("TASK_TERMINATION_FAILED", "VS Code could not terminate the selected Task.");
    }
    return { instanceId: this.#instanceId, sessionId: params.sessionId, execution: publicExecution(execution) };
  }

  get activeCount(): number {
    return [...this.#executions.values()].filter((execution) => !execution.endedAt).length;
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }

  #startProcess(event: vscode.TaskProcessStartEvent): void {
    const execution = this.#getExecution(event.execution);
    if (!execution) return;
    execution.status = "running";
    execution.processId = event.processId;
    const terminal = this.#terminals.findExecutionByProcessId(event.processId);
    if (terminal) {
      execution.terminalId = terminal.terminalId;
      execution.terminalExecutionId = terminal.executionId;
      execution.terminalCoverage = terminal.executionId ? "partial" : "unavailable";
    }
  }

  #endProcess(event: vscode.TaskProcessEndEvent): void {
    const execution = this.#getExecution(event.execution);
    if (!execution) return;
    execution.exitCode = event.exitCode ?? null;
  }

  async #endTask(vscodeExecution: vscode.TaskExecution): Promise<void> {
    const execution = this.#getExecution(vscodeExecution);
    if (!execution || execution.endedAt) return;
    execution.endedAt = new Date().toISOString();
    execution.status = execution.status === "terminated" ? "terminated" : "exited";
    if (execution.processId !== null) {
      const terminal = this.#terminals.findExecutionByProcessId(execution.processId);
      if (terminal) {
        execution.terminalId = terminal.terminalId;
        execution.terminalExecutionId = terminal.executionId;
        execution.terminalCoverage = terminal.executionId ? "partial" : "unavailable";
      }
    }
    try {
      execution.checkpointId = await this.#experiments.createExplicitCheckpoint(`Task ended: ${execution.taskLabel}`);
    } catch {
      execution.checkpointId = null;
    }
    this.#activity.update(execution.activityOperationId, {
      status: "succeeded",
      completedAt: execution.endedAt,
      checkpointId: execution.checkpointId,
      workflow: { ...execution.workflow, exitCode: execution.exitCode },
    });
  }

  #getExecution(vscodeExecution: vscode.TaskExecution): MutableTaskExecution | undefined {
    const executionId = this.#executionIds.get(vscodeExecution);
    return executionId ? this.#executions.get(executionId) : undefined;
  }

  async #requirePrepared(preparedTaskId: string, sessionId: string, rootUri: string): Promise<PreparedTaskRecord> {
    await this.#experiments.assertResourceChangesAllowed(sessionId);
    const record = this.#prepared.get(preparedTaskId);
    if (!record || record.sessionId !== sessionId || record.rootUri !== rootUri) {
      throw new BridgeError("TASK_PREPARATION_NOT_FOUND", "The prepared Task was not found for this instance, session, and root.");
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      this.#prepared.delete(preparedTaskId);
      throw new BridgeError("TASK_PREPARATION_EXPIRED", "The prepared Task has expired; prepare it again.");
    }
    return record;
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, record] of this.#prepared) {
      if (Date.parse(record.expiresAt) <= now) this.#prepared.delete(id);
    }
    const prepared = [...this.#prepared.values()].sort((left, right) => right.createdAt - left.createdAt);
    for (const record of prepared.slice(MAX_PREPARED_WORKFLOWS)) this.#prepared.delete(record.preparedTaskId);
    const cutoff = now - TASK_RETENTION_MS;
    const ordered = [...this.#executions.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    for (const [index, execution] of ordered.entries()) {
      if ((execution.endedAt && Date.parse(execution.endedAt) < cutoff) || index >= MAX_TASK_EXECUTIONS) {
        this.#executions.delete(execution.executionId);
        this.#executionIds.delete(execution.vscodeExecution);
      }
    }
  }
}

async function createTaskExecution(
  spec: PreparedTaskExecution,
  root: vscode.WorkspaceFolder,
): Promise<vscode.ShellExecution | vscode.ProcessExecution> {
  const cwd = await resolveTaskCwd(spec.options.cwd, root);
  const options = { cwd, env: { ...spec.options.env } };
  if (spec.kind === "shellCommandLine") return new vscode.ShellExecution(spec.commandLine, options);
  if (spec.kind === "shell") return new vscode.ShellExecution(spec.command, [...spec.args], options);
  return new vscode.ProcessExecution(spec.process, [...spec.args], options);
}

async function createPersistedTask(params: PrepareTaskParams, root: vscode.WorkspaceFolder): Promise<vscode.Task> {
  const task = new vscode.Task(
    { type: params.execution.kind === "process" ? "process" : "shell" },
    root,
    params.label,
    AGENT_TASK_SOURCE,
    await createTaskExecution(params.execution, root),
    [...params.problemMatchers],
  );
  const group = toVsCodeTaskGroup(params.group);
  if (group) task.group = group;
  task.isBackground = params.isBackground;
  task.detail = persistedTaskDetail(params.detail);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, echo: true, focus: false, panel: vscode.TaskPanelKind.Shared, clear: false };
  return task;
}

function summarizeTask(task: vscode.Task, rootUri: string, origin: TaskSummary["origin"]): SummarizedTask {
  const scope = typeof task.scope === "object" ? "folder" : "workspace";
  const type = typeof task.definition.type === "string" ? task.definition.type : "unknown";
  const group = taskGroup(task.group);
  const normalizedExecution = normalizeTaskExecution(task.execution);
  const coverage = normalizedExecution.preview.kind === "providerDefined" ? "providerDefined" : "complete";
  const fingerprintValue = {
    label: task.name,
    type,
    group,
    scope,
    detail: task.detail ?? null,
    problemMatchers: task.problemMatchers,
    isBackground: task.isBackground,
    presentation: task.presentationOptions,
    execution: normalizedExecution.normalized,
    providerDefinition: coverage === "providerDefined" ? task.definition : null,
  };
  const definitionFingerprint = sha256(stableStringify(fingerprintValue));
  return {
    task,
    preview: normalizedExecution.preview,
    summary: {
      taskId: sha256(stableStringify({ rootUri, label: task.name, type, definitionFingerprint })),
      fingerprint: definitionFingerprint,
      label: task.name.slice(0, 1_000),
      source: task.source.slice(0, 500),
      type: type.slice(0, 200),
      group,
      scope,
      rootUri,
      detail: task.detail?.slice(0, 1_000) ?? null,
      origin,
      fingerprintCoverage: coverage,
    },
  };
}

function normalizeTaskExecution(execution: vscode.Task["execution"]): { readonly normalized: unknown; readonly preview: TaskExecutionPreview } {
  if (execution instanceof vscode.ShellExecution) {
    const options = execution.options;
    const cwd = options?.cwd ?? "";
    const env = options?.env ?? {};
    if (execution.commandLine !== undefined) {
      return {
        normalized: { kind: "shellCommandLine", commandLine: execution.commandLine, cwd, env },
        preview: { kind: "shellCommandLine", command: execution.commandLine, args: [], cwd, envKeys: Object.keys(env).sort() },
      };
    }
    const command = shellValue(execution.command);
    const args = execution.args.map(shellValue);
    return {
      normalized: { kind: "shell", command, args, cwd, env },
      preview: { kind: "shell", command, args, cwd, envKeys: Object.keys(env).sort() },
    };
  }
  if (execution instanceof vscode.ProcessExecution) {
    const cwd = execution.options?.cwd ?? "";
    const env = execution.options?.env ?? {};
    return {
      normalized: { kind: "process", process: execution.process, args: execution.args, cwd, env },
      preview: { kind: "process", command: execution.process, args: [...execution.args], cwd, envKeys: Object.keys(env).sort() },
    };
  }
  return {
    normalized: null,
    preview: { kind: "providerDefined", command: "", args: [], cwd: "", envKeys: [] },
  };
}

function shellValue(value: string | vscode.ShellQuotedString | undefined): string {
  if (typeof value === "string") return value;
  return value?.value ?? "";
}

function persistedTaskValue(params: PrepareTaskParams, _preparedTaskId: string): Readonly<Record<string, unknown>> {
  const execution = params.execution;
  const value: Record<string, unknown> = {
    label: params.label,
    type: execution.kind === "process" ? "process" : "shell",
    command: execution.kind === "shellCommandLine" ? execution.commandLine : execution.kind === "shell" ? execution.command : execution.process,
    args: execution.kind === "shellCommandLine" ? [] : [...execution.args],
    options: { cwd: execution.options.cwd, env: { ...execution.options.env } },
    problemMatcher: [...params.problemMatchers],
    isBackground: params.isBackground,
    presentation: { reveal: "always", echo: true, focus: false, panel: "shared", clear: false },
    detail: persistedTaskDetail(params.detail),
  };
  if (params.group !== "none") value.group = params.group;
  return value;
}

function persistedTaskDetail(detail: string | null): string {
  return detail ? `Agent Bridge: ${detail}`.slice(0, 1_000) : "Generated by VS Code Agent Bridge";
}

function taskWorkflow(summary: TaskSummary, preview: TaskExecutionPreview, executionId: string | null, exitCode: number | null): AgentActivityWorkflow {
  return {
    kind: "task",
    definitionId: summary.taskId,
    definitionFingerprint: summary.fingerprint,
    executionId,
    command: preview.command || null,
    args: preview.args,
    cwd: preview.cwd || null,
    envKeys: preview.envKeys,
    exitCode,
  };
}

async function resolveTaskCwd(rawCwd: string, root: vscode.WorkspaceFolder): Promise<string> {
  const checked = await new CanonicalPathBoundary([root.uri.fsPath]).assertRelativePath(
    root.uri.fsPath,
    rawCwd,
  );
  return checked.canonicalPath;
}

function resolveRoot(rootUri: string): vscode.WorkspaceFolder {
  const root = (vscode.workspace.workspaceFolders ?? []).find((folder) => folder.uri.toString(true) === rootUri);
  if (!root || root.uri.scheme !== "file") throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The Task root is not a local workspace folder.");
  return root;
}

function isTaskInRoot(task: vscode.Task, root: vscode.WorkspaceFolder): boolean {
  if (typeof task.scope === "object") return task.scope.uri.toString(true) === root.uri.toString(true);
  return task.scope === vscode.TaskScope.Workspace && (vscode.workspace.workspaceFolders?.length ?? 0) === 1;
}

function taskGroup(group: vscode.TaskGroup | undefined): TaskSummary["group"] {
  switch (group?.id) {
    case vscode.TaskGroup.Build.id: return "build";
    case vscode.TaskGroup.Test.id: return "test";
    case vscode.TaskGroup.Clean.id: return "clean";
    case vscode.TaskGroup.Rebuild.id: return "rebuild";
    default: return "none";
  }
}

function toVsCodeTaskGroup(group: TaskSummary["group"]): vscode.TaskGroup | undefined {
  switch (group) {
    case "build": return vscode.TaskGroup.Build;
    case "test": return vscode.TaskGroup.Test;
    case "clean": return vscode.TaskGroup.Clean;
    case "rebuild": return vscode.TaskGroup.Rebuild;
    default: return undefined;
  }
}

function publicExecution(execution: MutableTaskExecution): TaskExecution {
  const {
    rootUri: _rootUri,
    sessionId: _sessionId,
    vscodeExecution: _vscodeExecution,
    workflow: _workflow,
    ...result
  } = execution;
  return result;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

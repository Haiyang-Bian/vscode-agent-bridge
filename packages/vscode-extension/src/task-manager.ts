import { createHash, randomUUID } from "node:crypto";

import * as vscode from "vscode";

import {
  BridgeError,
  type ListTaskExecutionsParams,
  type ListTaskExecutionsResult,
  type ListTasksParams,
  type ListTasksResult,
  type RunTaskParams,
  type RunTaskResult,
  type TaskExecution,
  type TaskSummary,
  type TerminateTaskParams,
  type TerminateTaskResult,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { ExperimentManager } from "./experiment-manager.js";
import { TerminalObserver } from "./terminal-observer.js";

const TASK_RETENTION_MS = 30 * 60 * 1_000;
const MAX_TASK_EXECUTIONS = 200;

interface MutableTaskExecution extends TaskExecution {
  readonly rootUri: string;
  readonly sessionId: string;
  vscodeExecution: vscode.TaskExecution;
}

export class TaskManager implements vscode.Disposable {
  readonly #instanceId: string;
  readonly #experiments: ExperimentManager;
  readonly #terminals: TerminalObserver;
  readonly #activity: AgentActivityTracker;
  readonly #executions = new Map<string, MutableTaskExecution>();
  readonly #executionIds = new Map<vscode.TaskExecution, string>();
  readonly #disposables: vscode.Disposable[];

  constructor(
    instanceId: string,
    experiments: ExperimentManager,
    terminals: TerminalObserver,
    activity: AgentActivityTracker,
  ) {
    this.#instanceId = instanceId;
    this.#experiments = experiments;
    this.#terminals = terminals;
    this.#activity = activity;
    this.#disposables = [
      vscode.tasks.onDidStartTaskProcess((event) => this.#startProcess(event)),
      vscode.tasks.onDidEndTaskProcess((event) => this.#endProcess(event)),
      vscode.tasks.onDidEndTask((event) => this.#endTask(event.execution)),
    ];
  }

  async listTasks(params: ListTasksParams): Promise<ListTasksResult> {
    const root = resolveRoot(params.rootUri);
    const fetched = await vscode.tasks.fetchTasks(params.type ? { type: params.type } : undefined);
    const tasks = fetched
      .filter((task) => isTaskInRoot(task, root))
      .map((task) => summarizeTask(task, root.uri.toString(true)))
      .filter((task) => !params.group || task.summary.group === params.group)
      .sort((left, right) => left.summary.label.localeCompare(right.summary.label));
    const visible = tasks.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      rootUri: params.rootUri,
      tasks: visible.map(({ summary }) => summary),
      returnedCount: visible.length,
      totalCount: tasks.length,
      truncated: params.offset + visible.length < tasks.length,
    };
  }

  async runTask(params: RunTaskParams): Promise<RunTaskResult> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    if (experiment.rootUri !== params.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The task is outside the active experiment root.");
    }
    const root = resolveRoot(params.rootUri);
    const task = (await vscode.tasks.fetchTasks())
      .filter((candidate) => isTaskInRoot(candidate, root))
      .map((candidate) => summarizeTask(candidate, params.rootUri))
      .find(({ summary }) => summary.taskId === params.taskId);
    if (!task) {
      throw new BridgeError("TASK_NOT_FOUND", "The listed task no longer exists.");
    }
    if (task.summary.fingerprint !== params.expectedFingerprint) {
      throw new BridgeError("TASK_CHANGED", "The task definition changed after it was listed.");
    }
    let vscodeExecution: vscode.TaskExecution;
    try {
      vscodeExecution = await vscode.tasks.executeTask(task.task);
    } catch {
      throw new BridgeError("TASK_START_FAILED", "VS Code could not start the selected task.");
    }
    const executionId = randomUUID();
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
      rootUri: params.rootUri,
      sessionId: params.sessionId,
      vscodeExecution,
    };
    this.#executions.set(executionId, execution);
    this.#executionIds.set(vscodeExecution, executionId);
    this.#prune();
    return { instanceId: this.#instanceId, sessionId: params.sessionId, execution: publicExecution(execution) };
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
      throw new BridgeError("TASK_EXECUTION_NOT_FOUND", "The task execution was not found.");
    }
    if (execution.rootUri !== experiment.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The task execution belongs to another experiment root.");
    }
    if (execution.endedAt) {
      throw new BridgeError("TASK_TERMINATION_FAILED", "The task execution has already ended.");
    }
    try {
      execution.vscodeExecution.terminate();
      execution.status = "terminated";
    } catch {
      throw new BridgeError("TASK_TERMINATION_FAILED", "VS Code could not terminate the selected task.");
    }
    return { instanceId: this.#instanceId, sessionId: params.sessionId, execution: publicExecution(execution) };
  }

  get activeCount(): number {
    return [...this.#executions.values()].filter((execution) => !execution.endedAt).length;
  }

  dispose(): void {
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
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
    this.#activity.record(
      { toolName: "vscode_run_task", title: `Task running: ${execution.taskLabel}` },
      "running",
    );
  }

  #endProcess(event: vscode.TaskProcessEndEvent): void {
    const execution = this.#getExecution(event.execution);
    if (!execution) return;
    execution.exitCode = event.exitCode ?? null;
  }

  #endTask(vscodeExecution: vscode.TaskExecution): void {
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
    this.#activity.record(
      { toolName: "vscode_run_task", title: `Task ended: ${execution.taskLabel}` },
      "succeeded",
    );
    void this.#experiments
      .createExplicitCheckpoint(`Task ended: ${execution.taskLabel}`)
      .catch(() => undefined);
  }

  #getExecution(vscodeExecution: vscode.TaskExecution): MutableTaskExecution | undefined {
    const executionId = this.#executionIds.get(vscodeExecution);
    return executionId ? this.#executions.get(executionId) : undefined;
  }

  #prune(): void {
    const cutoff = Date.now() - TASK_RETENTION_MS;
    const ordered = [...this.#executions.values()].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    );
    for (const execution of ordered) {
      if (
        (execution.endedAt && Date.parse(execution.endedAt) < cutoff) ||
        ordered.indexOf(execution) >= MAX_TASK_EXECUTIONS
      ) {
        this.#executions.delete(execution.executionId);
        this.#executionIds.delete(execution.vscodeExecution);
      }
    }
  }
}

function summarizeTask(
  task: vscode.Task,
  rootUri: string,
): { readonly task: vscode.Task; readonly summary: TaskSummary } {
  const scope = typeof task.scope === "object" ? "folder" : "workspace";
  const type = typeof task.definition.type === "string" ? task.definition.type : "unknown";
  const group = taskGroup(task.group);
  const identity = stableStringify({ rootUri, source: task.source, name: task.name, type });
  const fingerprint = stableStringify({
    identity,
    definition: task.definition,
    group,
    scope,
    detail: task.detail ?? null,
    problemMatchers: task.problemMatchers,
  });
  return {
    task,
    summary: {
      taskId: sha256(identity),
      fingerprint: sha256(fingerprint),
      label: task.name.slice(0, 1_000),
      source: task.source.slice(0, 500),
      type: type.slice(0, 200),
      group,
      scope,
      rootUri,
      detail: task.detail?.slice(0, 1_000) ?? null,
    },
  };
}

function resolveRoot(rootUri: string): vscode.WorkspaceFolder {
  const root = (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => folder.uri.toString(true) === rootUri,
  );
  if (!root || root.uri.scheme !== "file") {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The task root is not a local workspace folder.");
  }
  return root;
}

function isTaskInRoot(task: vscode.Task, root: vscode.WorkspaceFolder): boolean {
  if (typeof task.scope === "object") {
    return task.scope.uri.toString(true) === root.uri.toString(true);
  }
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

function publicExecution(execution: MutableTaskExecution): TaskExecution {
  const { rootUri: _rootUri, sessionId: _sessionId, vscodeExecution: _vscodeExecution, ...result } = execution;
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

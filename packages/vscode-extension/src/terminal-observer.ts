import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import {
  type ListTerminalExecutionsParams,
  type ListTerminalExecutionsResult,
  type ListTerminalsResult,
  type ReadTerminalOutputParams,
  type ReadTerminalOutputResult,
} from "@vscode-agent-bridge/protocol";

import { TerminalCaptureStore, type TerminalCaptureStats } from "./terminal-capture.js";
import { canCaptureTerminalSensitiveData } from "./policies.js";

export class TerminalObserver implements vscode.Disposable {
  readonly #capture: TerminalCaptureStore;
  readonly #terminalIds = new Map<vscode.Terminal, string>();
  readonly #executionIds = new Map<vscode.TerminalShellExecution, string>();
  readonly #disposables: vscode.Disposable[] = [];
  #cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(instanceId: string) {
    this.#capture = new TerminalCaptureStore(instanceId);
  }

  start(): void {
    for (const terminal of vscode.window.terminals) {
      this.#registerTerminal(terminal, true);
    }
    this.#disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => this.#registerTerminal(terminal, false)),
      vscode.window.onDidCloseTerminal((terminal) => this.#closeTerminal(terminal)),
      vscode.window.onDidChangeActiveTerminal(() => this.#refreshActiveTerminals()),
      vscode.window.onDidChangeTerminalState((terminal) => this.#refreshTerminal(terminal)),
      vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) =>
        this.#refreshTerminal(terminal),
      ),
      vscode.window.onDidStartTerminalShellExecution((event) => this.#startExecution(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => this.#endExecution(event)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("vscodeAgentBridge.terminalReadPolicy")) {
          this.#handlePolicyChange();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.#refreshActiveTerminals()),
    );
    this.#cleanupTimer = setInterval(() => this.#capture.cleanupExpired(), 60_000);
  }

  listTerminals(access: "full" | "metadata"): ListTerminalsResult {
    return this.#capture.listTerminals(access);
  }

  listExecutions(params: ListTerminalExecutionsParams): ListTerminalExecutionsResult {
    return this.#capture.listExecutions(params);
  }

  readOutput(params: ReadTerminalOutputParams): ReadTerminalOutputResult {
    return this.#capture.readOutput(params);
  }

  getStats(): TerminalCaptureStats {
    return this.#capture.getStats();
  }

  dispose(): void {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }
    for (const disposable of this.#disposables.splice(0)) {
      disposable.dispose();
    }
  }

  #registerTerminal(terminal: vscode.Terminal, existedAtActivation: boolean): string {
    const existing = this.#terminalIds.get(terminal);
    if (existing) {
      return existing;
    }
    const terminalId = randomUUID();
    this.#terminalIds.set(terminal, terminalId);
    this.#capture.registerTerminal({
      terminalId,
      name: terminal.name,
      processId: null,
      isActive: terminal === vscode.window.activeTerminal,
      shellIntegration: Boolean(terminal.shellIntegration),
      cwd: canCaptureTerminalSensitiveData()
        ? terminal.shellIntegration?.cwd?.toString() ?? null
        : null,
      existedAtActivation,
    });
    void terminal.processId.then((processId) => {
      if (this.#terminalIds.get(terminal) === terminalId) {
        this.#capture.updateTerminal(terminalId, { processId: processId ?? null });
      }
    });
    return terminalId;
  }

  #refreshTerminal(terminal: vscode.Terminal): void {
    const terminalId = this.#registerTerminal(terminal, false);
    this.#capture.updateTerminal(terminalId, {
      name: terminal.name,
      isActive: terminal === vscode.window.activeTerminal,
      shellIntegration: Boolean(terminal.shellIntegration),
      cwd: canCaptureTerminalSensitiveData()
        ? terminal.shellIntegration?.cwd?.toString() ?? null
        : null,
    });
  }

  #refreshActiveTerminals(): void {
    for (const terminal of vscode.window.terminals) {
      this.#refreshTerminal(terminal);
    }
  }

  #closeTerminal(terminal: vscode.Terminal): void {
    const terminalId = this.#registerTerminal(terminal, false);
    this.#capture.closeTerminal(terminalId, terminal.exitStatus?.code ?? null);
  }

  #startExecution(event: vscode.TerminalShellExecutionStartEvent): void {
    if (!canCaptureTerminalSensitiveData()) {
      return;
    }
    const terminalId = this.#registerTerminal(event.terminal, false);
    const executionId = randomUUID();
    this.#executionIds.set(event.execution, executionId);
    this.#capture.startExecution({
      executionId,
      terminalId,
      commandLine: event.execution.commandLine.value,
      commandConfidence: toConfidence(event.execution.commandLine.confidence),
      commandLineTrusted: event.execution.commandLine.isTrusted,
      cwd: event.execution.cwd?.toString() ?? null,
    });

    let stream: AsyncIterable<string>;
    try {
      stream = event.execution.read();
    } catch {
      this.#capture.failOutput(executionId);
      return;
    }
    void this.#consumeOutput(executionId, stream);
  }

  async #consumeOutput(executionId: string, stream: AsyncIterable<string>): Promise<void> {
    try {
      for await (const chunk of stream) {
        if (!this.#capture.hasExecution(executionId)) {
          return;
        }
        this.#capture.appendOutput(executionId, chunk);
      }
      if (this.#capture.hasExecution(executionId)) {
        this.#capture.finishOutput(executionId);
      }
    } catch {
      if (this.#capture.hasExecution(executionId)) {
        this.#capture.failOutput(executionId);
      }
    }
  }

  #endExecution(event: vscode.TerminalShellExecutionEndEvent): void {
    const executionId = this.#executionIds.get(event.execution);
    if (!executionId || !this.#capture.hasExecution(executionId)) {
      return;
    }
    this.#capture.updateExecution(executionId, {
      commandLine: event.execution.commandLine.value,
      commandConfidence: toConfidence(event.execution.commandLine.confidence),
      commandLineTrusted: event.execution.commandLine.isTrusted,
      cwd: event.execution.cwd?.toString() ?? null,
    });
    this.#capture.finishExecution(executionId, event.exitCode ?? null);
  }

  #handlePolicyChange(): void {
    if (!canCaptureTerminalSensitiveData()) {
      this.#capture.clearSensitiveData();
      this.#executionIds.clear();
    }
    this.#refreshActiveTerminals();
  }
}

function toConfidence(
  confidence: vscode.TerminalShellExecutionCommandLineConfidence,
): "low" | "medium" | "high" | "unknown" {
  switch (confidence) {
    case vscode.TerminalShellExecutionCommandLineConfidence.Low:
      return "low";
    case vscode.TerminalShellExecutionCommandLineConfidence.Medium:
      return "medium";
    case vscode.TerminalShellExecutionCommandLineConfidence.High:
      return "high";
    default:
      return "unknown";
  }
}

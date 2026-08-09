import { Buffer } from "node:buffer";

import {
  BridgeError,
  CLOSED_TERMINAL_RETENTION_MS,
  MAX_TERMINAL_EXECUTION_OUTPUT_BYTES,
  MAX_TERMINAL_WINDOW_OUTPUT_BYTES,
  type ListTerminalExecutionsParams,
  type ListTerminalExecutionsResult,
  type ListTerminalsResult,
  type ReadTerminalOutputParams,
  type ReadTerminalOutputResult,
  type TerminalOutputCoverage,
} from "@vscode-agent-bridge/protocol";

export interface TerminalCaptureLimits {
  readonly executionBytes?: number;
  readonly windowBytes?: number;
  readonly closedRetentionMs?: number;
}

export interface RegisteredTerminal {
  readonly terminalId: string;
  readonly name: string;
  readonly processId: number | null;
  readonly isActive: boolean;
  readonly shellIntegration: boolean;
  readonly cwd: string | null;
  readonly existedAtActivation: boolean;
}

export interface StartedExecution {
  readonly executionId: string;
  readonly terminalId: string;
  readonly commandLine: string;
  readonly commandConfidence: "low" | "medium" | "high" | "unknown";
  readonly commandLineTrusted: boolean;
  readonly cwd: string | null;
}

interface MutableTerminal extends RegisteredTerminal {
  lifecycle: "open" | "closed";
  status: "idle" | "running" | "exited" | "unknown";
  exitCode: number | null;
  openedAt: string;
  closedAt: string | null;
}

interface MutableExecution extends StartedExecution {
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  output: string;
  droppedCharacters: number;
  totalCapturedCharacters: number;
  streamEnded: boolean;
  captureFailed: boolean;
  sanitizer: TerminalOutputSanitizer;
}

export interface TerminalCaptureStats {
  readonly terminalCount: number;
  readonly executionCount: number;
  readonly executionsWithOutput: number;
  readonly executionsWithCompleteCoverage: number;
  readonly memoryBytes: number;
}

export class TerminalCaptureStore {
  readonly #instanceId: string;
  readonly #executionBytes: number;
  readonly #windowBytes: number;
  readonly #closedRetentionMs: number;
  readonly #now: () => number;
  readonly #terminals = new Map<string, MutableTerminal>();
  readonly #executions = new Map<string, MutableExecution>();

  constructor(
    instanceId: string,
    limits: TerminalCaptureLimits = {},
    now: () => number = Date.now,
  ) {
    this.#instanceId = instanceId;
    this.#executionBytes = limits.executionBytes ?? MAX_TERMINAL_EXECUTION_OUTPUT_BYTES;
    this.#windowBytes = limits.windowBytes ?? MAX_TERMINAL_WINDOW_OUTPUT_BYTES;
    this.#closedRetentionMs = limits.closedRetentionMs ?? CLOSED_TERMINAL_RETENTION_MS;
    this.#now = now;
  }

  registerTerminal(input: RegisteredTerminal): void {
    const existing = this.#terminals.get(input.terminalId);
    if (existing) {
      Object.assign(existing, input);
      return;
    }
    this.#terminals.set(input.terminalId, {
      ...input,
      lifecycle: "open",
      status: input.shellIntegration ? "idle" : input.existedAtActivation ? "unknown" : "idle",
      exitCode: null,
      openedAt: new Date(this.#now()).toISOString(),
      closedAt: null,
    });
  }

  updateTerminal(
    terminalId: string,
    update: Partial<Pick<RegisteredTerminal, "name" | "processId" | "isActive" | "shellIntegration" | "cwd">>,
  ): void {
    const terminal = this.#requireTerminal(terminalId);
    Object.assign(terminal, update);
    if (terminal.lifecycle === "open" && terminal.status === "unknown" && terminal.shellIntegration) {
      terminal.status = "idle";
    }
  }

  closeTerminal(terminalId: string, exitCode: number | null): void {
    const terminal = this.#requireTerminal(terminalId);
    terminal.lifecycle = "closed";
    terminal.status = "exited";
    terminal.exitCode = exitCode;
    terminal.closedAt = new Date(this.#now()).toISOString();
  }

  startExecution(input: StartedExecution): void {
    this.#requireTerminal(input.terminalId).status = "running";
    this.#executions.set(input.executionId, {
      ...input,
      startedAt: new Date(this.#now()).toISOString(),
      endedAt: null,
      exitCode: null,
      output: "",
      droppedCharacters: 0,
      totalCapturedCharacters: 0,
      streamEnded: false,
      captureFailed: false,
      sanitizer: new TerminalOutputSanitizer(),
    });
  }

  updateExecution(
    executionId: string,
    update: Partial<
      Pick<StartedExecution, "commandLine" | "commandConfidence" | "commandLineTrusted" | "cwd">
    >,
  ): void {
    Object.assign(this.#requireExecution(executionId), update);
  }

  appendOutput(executionId: string, rawChunk: string): void {
    const execution = this.#requireExecution(executionId);
    const chunk = execution.sanitizer.push(rawChunk);
    if (!chunk) {
      return;
    }
    execution.output += chunk;
    execution.totalCapturedCharacters += chunk.length;
    this.#trimExecution(execution, this.#executionBytes);
    this.#enforceWindowLimit(execution);
  }

  finishOutput(executionId: string): void {
    const execution = this.#requireExecution(executionId);
    const tail = execution.sanitizer.finish();
    if (tail) {
      execution.output += tail;
      execution.totalCapturedCharacters += tail.length;
      this.#trimExecution(execution, this.#executionBytes);
      this.#enforceWindowLimit(execution);
    }
    execution.streamEnded = true;
  }

  failOutput(executionId: string): void {
    const execution = this.#requireExecution(executionId);
    execution.captureFailed = true;
    execution.streamEnded = true;
  }

  finishExecution(executionId: string, exitCode: number | null): void {
    const execution = this.#requireExecution(executionId);
    execution.endedAt = new Date(this.#now()).toISOString();
    execution.exitCode = exitCode;
    const terminal = this.#requireTerminal(execution.terminalId);
    if (terminal.lifecycle === "open" && !this.#hasRunningExecution(terminal.terminalId)) {
      terminal.status = "idle";
    }
  }

  listTerminals(access: "full" | "metadata"): ListTerminalsResult {
    this.cleanupExpired();
    const terminals = [...this.#terminals.values()]
      .sort((left, right) => left.openedAt.localeCompare(right.openedAt))
      .map((terminal) => {
        const latest = this.#latestExecution(terminal.terminalId);
        return {
          terminalId: terminal.terminalId,
          name: terminal.name,
          processId: terminal.processId,
          isActive: terminal.isActive,
          lifecycle: terminal.lifecycle,
          status: terminal.status,
          shellIntegration: terminal.shellIntegration ? ("available" as const) : ("unavailable" as const),
          exitCode: terminal.exitCode,
          openedAt: terminal.openedAt,
          closedAt: terminal.closedAt,
          cwd: access === "full" ? terminal.cwd : null,
          coverage: {
            metadata: "complete" as const,
            commandLine:
              access === "metadata"
                ? ("redacted" as const)
                : latest
                  ? ("captured" as const)
                  : ("unavailable" as const),
            cwd:
              access === "metadata"
                ? ("redacted" as const)
                : terminal.cwd
                  ? ("captured" as const)
                  : ("unavailable" as const),
            output:
              access === "metadata"
                ? ("redacted" as const)
                : latest
                  ? this.#coverage(latest)
                  : terminal.existedAtActivation
                    ? ("started-before-activation" as const)
                    : ("unavailable" as const),
          },
        };
      });
    return {
      instanceId: this.#instanceId,
      terminals,
      returnedCount: terminals.length,
      totalCount: terminals.length,
      truncated: false,
    };
  }

  listExecutions(params: ListTerminalExecutionsParams): ListTerminalExecutionsResult {
    this.cleanupExpired();
    if (params.terminalId) {
      this.#requireTerminal(params.terminalId);
    }
    const offset = decodeCursor(params.cursor);
    const all = [...this.#executions.values()]
      .filter((execution) => !params.terminalId || execution.terminalId === params.terminalId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const page = all.slice(offset, offset + params.limit);
    const nextOffset = offset + page.length;
    return {
      instanceId: this.#instanceId,
      executions: page.map((execution) => ({
        executionId: execution.executionId,
        terminalId: execution.terminalId,
        commandLine: execution.commandLine,
        commandConfidence: execution.commandConfidence,
        commandLineTrusted: execution.commandLineTrusted,
        cwd: execution.cwd,
        startedAt: execution.startedAt,
        endedAt: execution.endedAt,
        status: execution.endedAt ? "exited" : "running",
        exitCode: execution.exitCode,
        capturedCharacters: execution.totalCapturedCharacters,
        droppedCharacters: execution.droppedCharacters,
        outputAvailable: !execution.captureFailed && execution.output.length > 0,
        coverage: {
          metadata: "complete",
          commandLine: "captured",
          cwd: execution.cwd ? "captured" : "unavailable",
          output: this.#coverage(execution),
        },
      })),
      returnedCount: page.length,
      nextCursor: nextOffset < all.length ? encodeCursor(nextOffset) : null,
      truncated: nextOffset < all.length,
    };
  }

  readOutput(params: ReadTerminalOutputParams): ReadTerminalOutputResult {
    this.cleanupExpired();
    const execution = this.#requireExecution(params.executionId);
    if (execution.captureFailed || execution.totalCapturedCharacters === 0) {
      throw new BridgeError(
        "TERMINAL_OUTPUT_UNAVAILABLE",
        "No captured output is available for this terminal execution.",
      );
    }
    const availableStart = execution.droppedCharacters;
    const actualCursor = Math.max(params.cursor, availableStart);
    const relativeStart = Math.max(0, actualCursor - availableStart);
    const text = execution.output.slice(relativeStart, relativeStart + params.maxChars);
    const nextCursor = actualCursor + text.length;
    const availableEnd = availableStart + execution.output.length;
    const truncated = nextCursor < availableEnd;
    return {
      instanceId: this.#instanceId,
      executionId: execution.executionId,
      terminalId: execution.terminalId,
      cursor: actualCursor,
      nextCursor: truncated || !execution.streamEnded ? nextCursor : null,
      text,
      returnedCharacters: text.length,
      capturedCharacters: execution.totalCapturedCharacters,
      droppedCharacters: execution.droppedCharacters,
      truncated,
      complete: Boolean(execution.endedAt && execution.streamEnded && !truncated),
      coverage: this.#coverage(execution),
    };
  }

  getStats(): TerminalCaptureStats {
    this.cleanupExpired();
    const executions = [...this.#executions.values()];
    return {
      terminalCount: this.#terminals.size,
      executionCount: executions.length,
      executionsWithOutput: executions.filter((item) => item.output.length > 0).length,
      executionsWithCompleteCoverage: executions.filter((item) => this.#coverage(item) === "complete")
        .length,
      memoryBytes: executions.reduce((total, item) => total + Buffer.byteLength(item.output), 0),
    };
  }

  cleanupExpired(): void {
    const threshold = this.#now() - this.#closedRetentionMs;
    for (const terminal of this.#terminals.values()) {
      if (!terminal.closedAt || Date.parse(terminal.closedAt) > threshold) {
        continue;
      }
      this.#terminals.delete(terminal.terminalId);
      for (const execution of this.#executions.values()) {
        if (execution.terminalId === terminal.terminalId) {
          this.#executions.delete(execution.executionId);
        }
      }
    }
  }

  #requireTerminal(terminalId: string): MutableTerminal {
    const terminal = this.#terminals.get(terminalId);
    if (!terminal) {
      throw new BridgeError("TERMINAL_NOT_FOUND", "The requested terminal is unavailable.");
    }
    return terminal;
  }

  #requireExecution(executionId: string): MutableExecution {
    const execution = this.#executions.get(executionId);
    if (!execution) {
      throw new BridgeError(
        "TERMINAL_EXECUTION_NOT_FOUND",
        "The requested terminal execution is unavailable.",
      );
    }
    return execution;
  }

  #latestExecution(terminalId: string): MutableExecution | undefined {
    return [...this.#executions.values()]
      .filter((execution) => execution.terminalId === terminalId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  }

  #hasRunningExecution(terminalId: string): boolean {
    return [...this.#executions.values()].some(
      (execution) => execution.terminalId === terminalId && !execution.endedAt,
    );
  }

  #coverage(execution: MutableExecution): TerminalOutputCoverage {
    if (execution.captureFailed) {
      return "unavailable";
    }
    if (execution.droppedCharacters > 0) {
      return "partial-dropped";
    }
    if (!execution.streamEnded) {
      return "capturing";
    }
    return "complete";
  }

  #trimExecution(execution: MutableExecution, maximumBytes: number): void {
    const excess = Buffer.byteLength(execution.output) - maximumBytes;
    if (excess <= 0) {
      return;
    }
    const removed = utf8PrefixForBytes(execution.output, excess);
    execution.output = execution.output.slice(removed);
    execution.droppedCharacters += removed;
  }

  #enforceWindowLimit(preferredActive: MutableExecution): void {
    let total = this.getStatsWithoutCleanup();
    if (total <= this.#windowBytes) {
      return;
    }
    const completed = [...this.#executions.values()]
      .filter((item) => item.endedAt && item.output.length > 0)
      .sort((left, right) => left.endedAt!.localeCompare(right.endedAt!));
    for (const execution of completed) {
      const bytes = Buffer.byteLength(execution.output);
      execution.droppedCharacters += execution.output.length;
      execution.output = "";
      execution.captureFailed = true;
      total -= bytes;
      if (total <= this.#windowBytes) {
        return;
      }
    }
    if (total > this.#windowBytes) {
      this.#trimExecution(preferredActive, Math.max(0, Buffer.byteLength(preferredActive.output) - (total - this.#windowBytes)));
    }
  }

  getStatsWithoutCleanup(): number {
    return [...this.#executions.values()].reduce(
      (total, execution) => total + Buffer.byteLength(execution.output),
      0,
    );
  }
}

export class TerminalOutputSanitizer {
  #state: "normal" | "escape" | "csi" | "osc" | "osc-escape" = "normal";
  #pendingCarriageReturn = false;

  push(raw: string): string {
    let output = "";
    for (const character of raw) {
      if (this.#state === "normal") {
        if (this.#pendingCarriageReturn) {
          if (character === "\n") {
            output += "\n";
            this.#pendingCarriageReturn = false;
            continue;
          }
          output += "\n";
          this.#pendingCarriageReturn = false;
        }
        if (character === "\u001b") {
          this.#state = "escape";
        } else if (character === "\r") {
          this.#pendingCarriageReturn = true;
        } else if (character === "\n" || character === "\t") {
          output += character;
        } else {
          const code = character.codePointAt(0)!;
          if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) {
            output += character;
          }
        }
      } else if (this.#state === "escape") {
        if (character === "[") {
          this.#state = "csi";
        } else if (character === "]") {
          this.#state = "osc";
        } else {
          this.#state = "normal";
        }
      } else if (this.#state === "csi") {
        const code = character.codePointAt(0)!;
        if (code >= 0x40 && code <= 0x7e) {
          this.#state = "normal";
        }
      } else if (this.#state === "osc") {
        if (character === "\u0007") {
          this.#state = "normal";
        } else if (character === "\u001b") {
          this.#state = "osc-escape";
        }
      } else if (character === "\\") {
        this.#state = "normal";
      } else {
        this.#state = character === "\u001b" ? "osc-escape" : "osc";
      }
    }
    return output;
  }

  finish(): string {
    const tail = this.#pendingCarriageReturn ? "\n" : "";
    this.#pendingCarriageReturn = false;
    this.#state = "normal";
    return tail;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/u.test(decoded)) {
    throw new BridgeError("INVALID_REQUEST", "Terminal execution cursor is invalid.");
  }
  return Number(decoded);
}

function utf8PrefixForBytes(value: string, minimumBytes: number): number {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) < minimumBytes) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

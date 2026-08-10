import { Buffer } from "node:buffer";

import {
  BridgeError,
  type DebugOutputCategory,
  type ListDebugOutputParams,
  type ListDebugOutputResult,
  type ReadDebugOutputParams,
  type ReadDebugOutputResult,
} from "@vscode-agent-bridge/protocol";

import { TerminalOutputSanitizer } from "./terminal-capture.js";

const DEFAULT_SESSION_BYTES = 1_048_576;
const DEFAULT_WINDOW_BYTES = 8 * 1_048_576;
const DEFAULT_RETENTION_MS = 15 * 60 * 1_000;
const MAX_EVENT_CHARACTERS = 1_024;

interface DebugOutputEvent {
  cursor: number;
  occurredAt: string;
  category: DebugOutputCategory;
  text: string;
  sourcePath: string | null;
  line: number | null;
  character: number | null;
}

interface DebugOutputSession {
  readonly debugSessionId: string;
  name: string;
  rootUri: string | null;
  startedAt: string;
  endedAt: string | null;
  nextCursor: number;
  events: DebugOutputEvent[];
  droppedCharacters: number;
  readonly sanitizer: TerminalOutputSanitizer;
}

export interface DebugOutputCaptureLimits {
  readonly sessionBytes?: number;
  readonly windowBytes?: number;
  readonly retentionMs?: number;
  readonly now?: () => number;
}

export class DebugOutputCaptureStore {
  readonly #instanceId: string;
  readonly #sessionBytes: number;
  readonly #windowBytes: number;
  readonly #retentionMs: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, DebugOutputSession>();

  constructor(instanceId: string, limits: DebugOutputCaptureLimits = {}) {
    this.#instanceId = instanceId;
    this.#sessionBytes = limits.sessionBytes ?? DEFAULT_SESSION_BYTES;
    this.#windowBytes = limits.windowBytes ?? DEFAULT_WINDOW_BYTES;
    this.#retentionMs = limits.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#now = limits.now ?? Date.now;
  }

  start(debugSessionId: string, name: string, rootUri: string | null): void {
    const existing = this.#sessions.get(debugSessionId);
    if (existing) {
      existing.name = name.slice(0, 1_000);
      existing.rootUri = rootUri;
      existing.endedAt = null;
      return;
    }
    this.#sessions.set(debugSessionId, {
      debugSessionId,
      name: name.slice(0, 1_000),
      rootUri,
      startedAt: new Date(this.#now()).toISOString(),
      endedAt: null,
      nextCursor: 1,
      events: [],
      droppedCharacters: 0,
      sanitizer: new TerminalOutputSanitizer(),
    });
  }

  finish(debugSessionId: string): void {
    const session = this.#sessions.get(debugSessionId);
    if (session && !session.endedAt) session.endedAt = new Date(this.#now()).toISOString();
    this.cleanupExpired();
  }

  append(
    debugSessionId: string,
    category: DebugOutputCategory,
    rawText: string,
    sourcePath: string | null,
    line: number | null,
    character: number | null,
  ): void {
    const session = this.#sessions.get(debugSessionId);
    if (!session) return;
    const text = session.sanitizer.push(rawText);
    if (!text) return;
    for (const chunk of textChunks(text, MAX_EVENT_CHARACTERS)) {
      session.events.push({
        cursor: session.nextCursor++,
        occurredAt: new Date(this.#now()).toISOString(),
        category,
        text: chunk,
        sourcePath,
        line,
        character,
      });
    }
    this.#trimSession(session, this.#sessionBytes);
    this.#enforceWindowLimit(session);
  }

  list(params: ListDebugOutputParams): ListDebugOutputResult {
    this.cleanupExpired();
    const all = [...this.#sessions.values()]
      .filter((session) => !params.rootUri || session.rootUri === params.rootUri)
      .filter((session) => params.includeTerminated || !session.endedAt)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const page = all.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      sessions: page.map((session) => ({
        debugSessionId: session.debugSessionId,
        name: session.name,
        status: session.endedAt ? "ended" : "active",
        coverage: "sinceActivation",
        eventCount: session.events.length,
        droppedCharacters: session.droppedCharacters,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      })),
      returnedCount: page.length,
      totalCount: all.length,
      truncated: params.offset + page.length < all.length,
    };
  }

  read(params: ReadDebugOutputParams): ReadDebugOutputResult {
    this.cleanupExpired();
    const session = this.#sessions.get(params.debugSessionId);
    if (!session) {
      throw new BridgeError("DEBUG_OUTPUT_UNAVAILABLE", "The requested Debug Console capture is unavailable.");
    }
    const categories = params.categories ? new Set(params.categories) : null;
    const candidates = session.events.filter(
      (event) => event.cursor > params.cursor && (!categories || categories.has(event.category)),
    );
    const selected: DebugOutputEvent[] = [];
    let characters = 0;
    for (const event of candidates) {
      if (selected.length > 0 && characters + event.text.length > params.maxChars) break;
      selected.push(event);
      characters += event.text.length;
      if (characters >= params.maxChars) break;
    }
    return {
      instanceId: this.#instanceId,
      debugSessionId: params.debugSessionId,
      events: selected,
      nextCursor: selected.at(-1)?.cursor ?? params.cursor,
      returnedCharacters: characters,
      totalEvents: session.events.length,
      truncated: selected.length < candidates.length,
      droppedCharacters: session.droppedCharacters,
      coverage: "sinceActivation",
    };
  }

  get sessionCount(): number {
    this.cleanupExpired();
    return this.#sessions.size;
  }

  cleanupExpired(): void {
    const cutoff = this.#now() - this.#retentionMs;
    for (const session of this.#sessions.values()) {
      if (session.endedAt && Date.parse(session.endedAt) < cutoff) {
        this.#sessions.delete(session.debugSessionId);
      }
    }
  }

  #trimSession(session: DebugOutputSession, limit: number): void {
    while (bytes(session.events) > limit && session.events.length > 0) {
      const first = session.events[0]!;
      const over = bytes(session.events) - limit;
      if (Buffer.byteLength(first.text, "utf8") <= over) {
        session.events.shift();
        session.droppedCharacters += first.text.length;
      } else {
        const removed = utf8PrefixForBytes(first.text, over);
        first.text = first.text.slice(removed);
        session.droppedCharacters += removed;
      }
    }
  }

  #enforceWindowLimit(preferred: DebugOutputSession): void {
    let total = [...this.#sessions.values()].reduce((sum, session) => sum + bytes(session.events), 0);
    if (total <= this.#windowBytes) return;
    const ordered = [...this.#sessions.values()].sort((left, right) => {
      if (Boolean(left.endedAt) !== Boolean(right.endedAt)) return left.endedAt ? -1 : 1;
      return left.startedAt.localeCompare(right.startedAt);
    });
    for (const session of ordered) {
      if (total <= this.#windowBytes) break;
      const current = bytes(session.events);
      const target = Math.max(0, current - (total - this.#windowBytes));
      this.#trimSession(session, target);
      total -= current - bytes(session.events);
    }
    if (total > this.#windowBytes) this.#trimSession(preferred, 0);
  }
}

function bytes(events: readonly DebugOutputEvent[]): number {
  return events.reduce((sum, event) => sum + Buffer.byteLength(event.text, "utf8"), 0);
}

function utf8PrefixForBytes(value: string, targetBytes: number): number {
  let bytesSeen = 0;
  let characters = 0;
  for (const character of value) {
    bytesSeen += Buffer.byteLength(character, "utf8");
    characters += character.length;
    if (bytesSeen >= targetBytes) break;
  }
  return characters;
}

function textChunks(value: string, maxCharacters: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + maxCharacters);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

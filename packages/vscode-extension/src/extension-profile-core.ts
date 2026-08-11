import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { BridgeError, type ExtensionConfigurationTarget } from "@vscode-agent-bridge/protocol";

const JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const JOURNAL_LIMIT = 100;

export interface DeclaredConfigurationSetting {
  readonly key: string;
  readonly types: readonly string[];
  readonly scope: string | null;
  readonly enumValues: readonly unknown[];
}

export interface GlobalProfileChange {
  readonly changeId: string;
  readonly extensionId: string;
  readonly key: string;
  readonly beforeDefined: boolean;
  readonly beforeValue: unknown;
  readonly beforeValueSha256: string;
  readonly afterValueSha256: string;
  readonly state: "pending" | "committed" | "attentionRequired";
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface JournalFile {
  readonly schemaVersion: 2;
  readonly changes: readonly GlobalProfileChange[];
}

export interface GlobalProfileJournalHealth {
  readonly pendingCount: number;
  readonly attentionRequiredCount: number;
  readonly healthy: boolean;
}

export function findDeclaredConfigurationSetting(
  manifestValue: unknown,
  key: string,
): DeclaredConfigurationSetting | null {
  const manifest = record(manifestValue);
  const contributes = record(manifest.contributes);
  const configurations = Array.isArray(contributes.configuration)
    ? contributes.configuration
    : contributes.configuration
      ? [contributes.configuration]
      : [];
  for (const configuration of configurations) {
    const rawSchema = record(record(configuration).properties)[key];
    if (rawSchema === undefined) continue;
    const schema = record(rawSchema);
    const types = Array.isArray(schema.type)
      ? schema.type.filter((value): value is string => typeof value === "string").slice(0, 10)
      : typeof schema.type === "string"
        ? [schema.type]
        : [];
    const enumValues = Array.isArray(schema.enum) ? schema.enum.slice(0, 200) : [];
    return {
      key,
      types: types.map((value) => value.slice(0, 100)),
      scope: typeof schema.scope === "string" ? schema.scope.slice(0, 100) : null,
      enumValues,
    };
  }
  return null;
}

export function assertConfigurationKeyAllowed(key: string): void {
  if (/(?:token|password|secret|credential|api[_-]?key)/iu.test(key)) {
    throw new BridgeError(
      "EXTENSION_CONFIGURATION_DENIED",
      "Sensitive extension configuration must be managed through the extension's native UI or SecretStorage.",
    );
  }
}

export function assertConfigurationTargetAllowed(
  setting: DeclaredConfigurationSetting,
  target: ExtensionConfigurationTarget,
): void {
  const scope = setting.scope ?? "window";
  if (target === "workspace" && (scope === "application" || scope === "machine")) {
    throw new BridgeError("EXTENSION_CONFIGURATION_DENIED", "This setting does not support workspace scope.");
  }
  if (
    target === "workspaceFolder" &&
    scope !== "resource" &&
    scope !== "language-overridable"
  ) {
    throw new BridgeError("EXTENSION_CONFIGURATION_DENIED", "This setting does not support workspace-folder scope.");
  }
}

export function assertConfigurationValueAllowed(
  setting: DeclaredConfigurationSetting,
  value: unknown,
): void {
  if (setting.types.length > 0 && !setting.types.some((type) => matchesType(value, type))) {
    throw new BridgeError("EXTENSION_CONFIGURATION_DENIED", "The new value does not match the declared setting type.");
  }
  if (setting.enumValues.length > 0 && !setting.enumValues.some((item) => canonicalJson(item) === canonicalJson(value))) {
    throw new BridgeError("EXTENSION_CONFIGURATION_DENIED", "The new value is not in the declared setting enum.");
  }
  if (canonicalJson(value).length > 100_000) {
    throw new BridgeError("EXTENSION_CONFIGURATION_DENIED", "The configuration value exceeds the Bridge limit.");
  }
}

export function configurationValueSha256(value: unknown, defined = value !== undefined): string {
  return createHash("sha256")
    .update(canonicalJson({ defined, value: defined ? value : null }))
    .digest("hex");
}

export class GlobalProfileChangeJournal {
  readonly #filePath: string;
  #queue: Promise<unknown> = Promise.resolve();
  #readAttentionRequired = false;

  constructor(storageRoot: string) {
    this.#filePath = path.join(storageRoot, "extension-profile-changes", "v1", "journal.json");
  }

  begin(
    input: Omit<GlobalProfileChange, "changeId" | "state" | "createdAt" | "updatedAt">,
  ): Promise<GlobalProfileChange> {
    return this.#enqueue(async () => {
      const timestamp = new Date().toISOString();
      const change: GlobalProfileChange = {
        ...input,
        changeId: randomUUID(),
        state: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const current = await this.#read();
      await this.#write(this.#prune([...current, change]).slice(-JOURNAL_LIMIT));
      return change;
    });
  }

  async append(
    input: Omit<GlobalProfileChange, "changeId" | "state" | "createdAt" | "updatedAt">,
  ): Promise<GlobalProfileChange> {
    const change = await this.begin(input);
    return (await this.commit(change.changeId)) ?? change;
  }

  commit(changeId: string): Promise<GlobalProfileChange | null> {
    return this.#transition(changeId, "committed");
  }

  markAttentionRequired(changeId: string): Promise<GlobalProfileChange | null> {
    return this.#transition(changeId, "attentionRequired");
  }

  latest(): Promise<GlobalProfileChange | null> {
    return this.#enqueue(async () => {
      const changes = this.#prune(await this.#read()).filter((change) => change.state === "committed");
      return changes.at(-1) ?? null;
    });
  }

  remove(changeId: string): Promise<void> {
    return this.#enqueue(async () => {
      const changes = this.#prune(await this.#read()).filter((change) => change.changeId !== changeId);
      await this.#write(changes);
    });
  }

  recover(
    currentValueSha256: (change: GlobalProfileChange) => Promise<string | null>,
  ): Promise<GlobalProfileJournalHealth> {
    return this.#enqueue(async () => {
      let changes = this.#prune(await this.#read());
      let changed = false;
      for (let index = 0; index < changes.length; index += 1) {
        const entry = changes[index]!;
        if (entry.state !== "pending") continue;
        const current = await currentValueSha256(entry).catch(() => null);
        if (current === entry.afterValueSha256) {
          changes[index] = { ...entry, state: "committed", updatedAt: new Date().toISOString() };
        } else if (current === entry.beforeValueSha256) {
          changes.splice(index, 1);
          index -= 1;
        } else {
          changes[index] = { ...entry, state: "attentionRequired", updatedAt: new Date().toISOString() };
        }
        changed = true;
      }
      if (changed) await this.#write(changes);
      return journalHealth(changes, this.#readAttentionRequired);
    });
  }

  health(): Promise<GlobalProfileJournalHealth> {
    return this.#enqueue(async () => journalHealth(this.#prune(await this.#read()), this.#readAttentionRequired));
  }

  #transition(
    changeId: string,
    state: GlobalProfileChange["state"],
  ): Promise<GlobalProfileChange | null> {
    return this.#enqueue(async () => {
      const changes = this.#prune(await this.#read());
      const index = changes.findIndex((change) => change.changeId === changeId);
      if (index < 0) return null;
      const updated = { ...changes[index]!, state, updatedAt: new Date().toISOString() };
      changes[index] = updated;
      await this.#write(changes);
      return updated;
    });
  }

  async #read(): Promise<GlobalProfileChange[]> {
    this.#readAttentionRequired = false;
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as JournalFile & { schemaVersion?: number };
      if (!Array.isArray(parsed.changes)) {
        this.#readAttentionRequired = true;
        return [];
      }
      if (parsed.schemaVersion === 2) {
        const changes = parsed.changes.filter(validJournalEntry);
        this.#readAttentionRequired = changes.length !== parsed.changes.length;
        return changes.slice(-JOURNAL_LIMIT);
      }
      if (parsed.schemaVersion === 1) {
        const migrated = parsed.changes.map(migrateV1Entry);
        this.#readAttentionRequired = migrated.some((value) => value === null);
        return migrated.filter((value): value is GlobalProfileChange => value !== null).slice(-JOURNAL_LIMIT);
      }
      this.#readAttentionRequired = true;
      return [];
    } catch {
      this.#readAttentionRequired = true;
      return [];
    }
  }

  async #write(changes: readonly GlobalProfileChange[]): Promise<void> {
    if (this.#readAttentionRequired) {
      throw new BridgeError(
        "EXTENSION_CONFIGURATION_ATTENTION_REQUIRED",
        "The Global Profile journal is malformed and requires user attention.",
      );
    }
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 2, changes }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #prune(changes: readonly GlobalProfileChange[]): GlobalProfileChange[] {
    const cutoff = Date.now() - JOURNAL_RETENTION_MS;
    return changes.filter((change) => Date.parse(change.createdAt) >= cutoff).slice(-JOURNAL_LIMIT);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => undefined).then(operation);
    this.#queue = next;
    return next;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? "null";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validJournalEntry(value: unknown): value is GlobalProfileChange {
  const candidate = record(value);
  return (
    typeof candidate.changeId === "string" &&
    typeof candidate.extensionId === "string" &&
    typeof candidate.key === "string" &&
    typeof candidate.beforeDefined === "boolean" &&
    typeof candidate.beforeValueSha256 === "string" &&
    typeof candidate.afterValueSha256 === "string" &&
    (candidate.state === "pending" || candidate.state === "committed" || candidate.state === "attentionRequired") &&
    typeof candidate.createdAt === "string" &&
    Number.isFinite(Date.parse(candidate.createdAt)) &&
    typeof candidate.updatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.updatedAt))
  );
}

function migrateV1Entry(value: unknown): GlobalProfileChange | null {
  const candidate = record(value);
  if (
    typeof candidate.changeId !== "string" ||
    typeof candidate.extensionId !== "string" ||
    typeof candidate.key !== "string" ||
    typeof candidate.beforeDefined !== "boolean" ||
    typeof candidate.afterValueSha256 !== "string" ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) return null;
  return {
    changeId: candidate.changeId,
    extensionId: candidate.extensionId,
    key: candidate.key,
    beforeDefined: candidate.beforeDefined,
    beforeValue: candidate.beforeDefined ? candidate.beforeValue : null,
    beforeValueSha256: configurationValueSha256(candidate.beforeValue, candidate.beforeDefined),
    afterValueSha256: candidate.afterValueSha256,
    state: "committed",
    createdAt: candidate.createdAt,
    updatedAt: candidate.createdAt,
  };
}

function journalHealth(
  changes: readonly GlobalProfileChange[],
  readAttentionRequired = false,
): GlobalProfileJournalHealth {
  const pendingCount = changes.filter((change) => change.state === "pending").length;
  const attentionRequiredCount = changes.filter((change) => change.state === "attentionRequired").length + (readAttentionRequired ? 1 : 0);
  return { pendingCount, attentionRequiredCount, healthy: pendingCount === 0 && attentionRequiredCount === 0 };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

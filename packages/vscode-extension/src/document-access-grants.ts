import { randomUUID } from "node:crypto";

import {
  DOCUMENT_ACCESS_GRANT_TTL_MS,
  MAX_DOCUMENT_ACCESS_GRANTS,
  BridgeError,
} from "@vscode-agent-bridge/protocol";

export interface DocumentAccessGrant {
  readonly accessGrantId: string;
  readonly instanceId: string;
  readonly uri: string;
  readonly sourceWorkspaceUri: string;
  readonly createdAt: number;
  readonly expiresAt: string;
}

export class DocumentAccessGrantStore {
  readonly #instanceId: string;
  readonly #now: () => number;
  readonly #entries = new Map<string, DocumentAccessGrant>();

  constructor(instanceId: string, now: () => number = Date.now) {
    this.#instanceId = instanceId;
    this.#now = now;
  }

  issue(uri: string, sourceWorkspaceUri: string): DocumentAccessGrant {
    this.#prune();
    const createdAt = this.#now();
    const grant: DocumentAccessGrant = {
      accessGrantId: randomUUID(),
      instanceId: this.#instanceId,
      uri,
      sourceWorkspaceUri,
      createdAt,
      expiresAt: new Date(createdAt + DOCUMENT_ACCESS_GRANT_TTL_MS).toISOString(),
    };
    this.#entries.set(grant.accessGrantId, grant);
    this.#prune();
    return grant;
  }

  authorize(accessGrantId: string, uri: string): DocumentAccessGrant {
    const grant = this.#entries.get(accessGrantId);
    if (!grant || grant.instanceId !== this.#instanceId || grant.uri !== uri) {
      throw new BridgeError("DOCUMENT_ACCESS_DENIED", "The document grant does not authorize this exact URI and VS Code instance.");
    }
    if (Date.parse(grant.expiresAt) <= this.#now()) {
      this.#entries.delete(accessGrantId);
      throw new BridgeError("DOCUMENT_ACCESS_GRANT_EXPIRED", "The document access grant expired; request the provider result again.");
    }
    return grant;
  }

  get size(): number {
    this.#prune();
    return this.#entries.size;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, grant] of this.#entries) {
      if (Date.parse(grant.expiresAt) <= now) this.#entries.delete(id);
    }
    const excess = this.#entries.size - MAX_DOCUMENT_ACCESS_GRANTS;
    if (excess <= 0) return;
    const oldest = [...this.#entries.values()].sort((left, right) => left.createdAt - right.createdAt);
    for (const grant of oldest.slice(0, excess)) this.#entries.delete(grant.accessGrantId);
  }
}

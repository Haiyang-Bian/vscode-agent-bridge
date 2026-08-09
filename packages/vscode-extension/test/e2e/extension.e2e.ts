import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";

import * as vscode from "vscode";

import {
  BRIDGE_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  InstanceDescriptorSchema,
  resolveRegistryDirectories,
  type InstanceDescriptor,
} from "@vscode-agent-bridge/protocol";

const UNSAVED_MARKER = "UNSAVED_VSCODE_AGENT_BRIDGE_E2E";

suite("VS Code Agent Bridge Extension Host", function () {
  this.timeout(90_000);

  test("serves unsaved text, diagnostics, symbols, navigation, and hover", async () => {
    const extension = vscode.extensions.all.find(
      (candidate) => candidate.id.toLowerCase() === "haiyang-bian.vscode-agent-bridge",
    );
    assert.ok(extension, "the extension under development should be installed");
    await extension.activate();

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "the TypeScript fixture workspace should be open");
    const documentUri = vscode.Uri.joinPath(workspaceFolder.uri, "bridge.ts");
    const onDiskBeforeEdit = Buffer.from(await vscode.workspace.fs.readFile(documentUri)).toString(
      "utf8",
    );
    assert.ok(!onDiskBeforeEdit.includes(UNSAVED_MARKER));

    const document = await vscode.workspace.openTextDocument(documentUri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const edited = await editor.edit((builder) => {
      builder.insert(document.positionAt(document.getText().length), `\n// ${UNSAVED_MARKER}\n`);
    });
    assert.equal(edited, true);
    assert.equal(document.isDirty, true);

    await waitFor(
      () => vscode.languages.getDiagnostics(documentUri).some((item) => item.severity === 0),
      "TypeScript diagnostics",
    );

    const descriptor = await waitForDescriptor();
    await assertAuthenticationBoundary(descriptor);
    const client = await BridgeRpcClient.connect(descriptor.transport.endpoint);
    try {
      await client.request(BRIDGE_METHODS.initialize, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        authToken: descriptor.authToken,
        client: { name: "extension-host-e2e", version: "0.2.0" },
      });

      const snapshot = await client.request<Record<string, unknown>>(BRIDGE_METHODS.readDocument, {});
      assert.equal(snapshot.isDirty, true);
      assert.match(String(snapshot.text), new RegExp(UNSAVED_MARKER));
      assert.ok(!(await readFile(documentUri.fsPath, "utf8")).includes(UNSAVED_MARKER));

      const diagnostics = await waitFor(
        async () => {
          const result = await client.request<{
            diagnostics: Array<{ severity: string; message: string }>;
          }>(BRIDGE_METHODS.getDiagnostics, {
            scope: "document",
            uri: documentUri.toString(true),
            limit: 20,
          });
          return result.diagnostics.some((item) => item.severity === "error") ? result : undefined;
        },
        "bridged TypeScript diagnostics",
      );
      assert.ok(diagnostics.diagnostics.some((item) => item.message.includes("string")));

      const symbols = await waitFor(
        async () => {
          const result = await client.request<{ symbols: Array<{ name: string }> }>(
            BRIDGE_METHODS.getDocumentSymbols,
            { uri: documentUri.toString(true), limit: 20 },
          );
          return result.symbols.some((item) => item.name === "bridgeGreeting")
            ? result
            : undefined;
        },
        "document symbols",
      );
      assert.ok(symbols.symbols.some((item) => item.name === "bridgeGreeting"));

      const positionedRequest = {
        uri: documentUri.toString(true),
        position: { line: 4, character: 27 },
        limit: 20,
      };
      const definitions = await client.request<{ locations: Array<{ range: unknown }> }>(
        BRIDGE_METHODS.getDefinitions,
        positionedRequest,
      );
      assert.ok(definitions.locations.length >= 1);

      const references = await client.request<{ locations: unknown[] }>(
        BRIDGE_METHODS.getReferences,
        positionedRequest,
      );
      assert.ok(references.locations.length >= 3);

      const hover = await client.request<{ contents: string[] }>(BRIDGE_METHODS.getHover, {
        uri: documentUri.toString(true),
        position: positionedRequest.position,
        maxChars: 4_000,
      });
      assert.ok(hover.contents.join("\n").includes("bridgeGreeting"));
      assert.ok(!hover.contents.join("\n").match(/command:(?!\[redacted\])/iu));

      const plainDocument = await vscode.workspace.openTextDocument({
        language: "plaintext",
        content: "plain text has no definition provider",
      });
      await vscode.window.showTextDocument(plainDocument, { preview: false });
      const noDefinitions = await client.request<{ locations: unknown[] }>(
        BRIDGE_METHODS.getDefinitions,
        {
          uri: plainDocument.uri.toString(true),
          position: { line: 0, character: 0 },
          limit: 20,
        },
      );
      assert.deepEqual(noDefinitions.locations, []);

      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await assert.rejects(
        () => client.request(BRIDGE_METHODS.readDocument, {}),
        (error: unknown) => error instanceof BridgeRpcError && error.bridgeCode === "NO_ACTIVE_EDITOR",
      );
    } finally {
      client.close();
    }
  });
});

async function assertAuthenticationBoundary(descriptor: InstanceDescriptor): Promise<void> {
  const unauthenticated = await BridgeRpcClient.connect(descriptor.transport.endpoint);
  await assert.rejects(
    () => unauthenticated.request(BRIDGE_METHODS.getEditorContext, {}),
    (error: unknown) =>
      error instanceof BridgeRpcError && error.bridgeCode === "AUTHENTICATION_FAILED",
  );
  unauthenticated.close();

  const wrongToken = await BridgeRpcClient.connect(descriptor.transport.endpoint);
  await assert.rejects(
    () =>
      wrongToken.request(BRIDGE_METHODS.initialize, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        authToken: "x".repeat(43),
        client: { name: "extension-host-e2e", version: "0.2.0" },
      }),
    (error: unknown) =>
      error instanceof BridgeRpcError && error.bridgeCode === "AUTHENTICATION_FAILED",
  );
  wrongToken.close();
}

async function waitForDescriptor(): Promise<InstanceDescriptor> {
  const instancesDirectory = resolveRegistryDirectories().instances;
  return waitFor(async () => {
    const names = await readdir(instancesDirectory).catch(() => []);
    const descriptorName = names.find((name) => name.endsWith(".json"));
    if (!descriptorName) {
      return undefined;
    }
    const parsed = InstanceDescriptorSchema.safeParse(
      JSON.parse(await readFile(path.join(instancesDirectory, descriptorName), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  }, "bridge instance descriptor");
}

async function waitFor<T>(
  callback: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value !== undefined && value !== false) {
        return value as T;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}.`, { cause: lastError });
}

class BridgeRpcError extends Error {
  constructor(
    readonly bridgeCode: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRpcError";
  }
}

class BridgeRpcClient {
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  readonly #socket: Socket;
  #buffer = "";
  #nextRequestId = 1;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#acceptData(chunk));
    socket.on("error", (error) => this.#rejectPending(error));
    socket.on("close", () => this.#rejectPending(new Error("Bridge socket closed.")));
  }

  static async connect(endpoint: string): Promise<BridgeRpcClient> {
    const socket = net.createConnection(endpoint);
    await once(socket, "connect");
    return new BridgeRpcClient(socket);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.#nextRequestId++;
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    this.#socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  close(): void {
    this.#socket.destroy();
  }

  #acceptData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const response = JSON.parse(line) as {
        id: number;
        result?: unknown;
        error?: { message: string; data?: { bridgeCode?: string } };
      };
      const pending = this.#pending.get(response.id);
      if (!pending) {
        continue;
      }
      this.#pending.delete(response.id);
      if (response.error) {
        pending.reject(
          new BridgeRpcError(response.error.data?.bridgeCode ?? "UNKNOWN", response.error.message),
        );
      } else {
        pending.resolve(response.result);
      }
    }
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

import assert from "node:assert/strict";

export class HttpE2EClient {
  #session: string | undefined;
  #next = 1;
  readonly url = process.env.VSCODE_AGENT_BRIDGE_E2E_HTTP_URL!;
  readonly #token = process.env.VSCODE_AGENT_BRIDGE_E2E_HTTP_TOKEN!;

  async connect(): Promise<void> {
    assert.ok(this.url && this.#token, "an isolated HTTP daemon must be started by the E2E runner");
    await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "real-vscode-http-e2e", version: "1" } });
    await this.notify("notifications/initialized", {});
  }
  async health(): Promise<{ pid: number }> {
    const response = await fetch(this.url.replace(/\/mcp$/u, "/health"), { headers: { Authorization: `Bearer ${this.#token}` } });
    assert.equal(response.status, 200);
    return await response.json() as { pid: number };
  }
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await this.request("tools/call", { name, arguments: args });
    assert.equal(response.isError, undefined, "HTTP IDE tool must succeed");
    return response.structuredContent as T;
  }
  async request(method: string, params: Record<string, unknown>, id = this.#next++): Promise<Record<string, unknown>> {
    const response = await fetch(this.url, { method: "POST", headers: this.#headers(), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    assert.equal(response.status, 200, "MCP request must be admitted");
    this.#session = response.headers.get("mcp-session-id") ?? this.#session;
    const text = await response.text();
    const messages = text.split(/\r?\n/u).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const result = messages.find(message => message.id === id) ?? JSON.parse(text);
    if (result.error) throw new Error(`MCP error ${String(result.error.code)}`);
    return result.result;
  }
  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.url, { method: "POST", headers: this.#headers(), body: JSON.stringify({ jsonrpc: "2.0", method, params }) });
    assert.equal(response.status, 202);
  }
  async close(): Promise<void> {
    if (!this.#session) return;
    const response = await fetch(this.url, { method: "DELETE", headers: this.#headers() });
    assert.equal(response.status, 200);
    this.#session = undefined;
  }
  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25", ...(this.#session ? { "Mcp-Session-Id": this.#session } : {}) };
  }
}

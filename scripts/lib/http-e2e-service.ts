import path from "node:path";
import { ensurePrivateDirectory, newServiceIdentity, resolveServicePaths, writePrivateJson } from "../../packages/mcp-server/src/service-state.ts";
import { controlRequest, stopVerifiedService, waitForReady } from "../../packages/mcp-server/src/service-control.ts";
import type { E2EEnvironment } from "./e2e-runner.ts";

/** An isolated daemon starts before VS Code; no formal task/config is involved. */
export async function startHttpE2EService(environment: E2EEnvironment, executable?: string) {
  const paths = await resolveServicePaths(path.join(environment.root, "http-service"));
  await ensurePrivateDirectory(paths.directory, paths.userSid);
  const allocator = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const identity = newServiceIdentity(paths, allocator.port!);
  await allocator.stop(true);
  await writePrivateJson(paths.identity, identity, paths.userSid);
  const command = executable ? [executable] : [process.execPath, path.resolve(import.meta.dir, "../../packages/mcp-server/src/index.ts")];
  const child = Bun.spawn([...command, "serve", "--service-dir", paths.directory, "--registry-dir", environment.root], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  // Drain streams without retaining tool output or private input.
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  try {
    const status = await waitForReady(paths, identity);
    return {
      env: { VSCODE_AGENT_BRIDGE_E2E_HTTP_URL: `http://127.0.0.1:${identity.port}/mcp`,
        VSCODE_AGENT_BRIDGE_E2E_HTTP_TOKEN: identity.mcpToken, VSCODE_AGENT_BRIDGE_E2E_HTTP_PID: String(status.pid) },
      async close() {
        try {
          const current = await controlRequest(paths, identity, "status");
          if (current.bootId !== status.bootId) throw new Error("The E2E daemon changed unexpectedly.");
          await stopVerifiedService(paths, identity, current);
          if (await child.exited !== 0) throw new Error("The E2E daemon failed during shutdown.");
          await Promise.all([output, errors]);
        } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
      },
    };
  } catch (error) { child.kill(); await child.exited; throw error; }
}

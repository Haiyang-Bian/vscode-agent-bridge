const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");

exports.activate = function activate() {
  if (process.env.VSCODE_AGENT_BRIDGE_E2E !== "1" || !process.env.VSCODE_AGENT_BRIDGE_HTTP_LIFECYCLE_ROOT) return;
  void run().catch(async error => {
    await publish(path.join(process.env.VSCODE_AGENT_BRIDGE_HTTP_LIFECYCLE_ROOT, "lifecycle-failed.json"), { failed: true, message: String(error.message).slice(0, 240) });
  });
};

async function run() {
  const root = process.env.VSCODE_AGENT_BRIDGE_HTTP_LIFECYCLE_ROOT;
  if (root !== process.env.VSCODE_AGENT_BRIDGE_REGISTRY_DIR || !path.basename(root).startsWith("bridge-http-window-")) throw new Error("Invalid test isolation");
  const workspace = vscode.workspace.workspaceFolders[0];
  const secondary = workspace.uri.fsPath.toLowerCase() === process.env.VSCODE_AGENT_BRIDGE_HTTP_SECONDARY.toLowerCase();
  const bridge = vscode.extensions.getExtension("AliceLin.vscode-agent-bridge");
  if (!bridge) throw new Error("Missing bridge");
  void bridge.activate();
  let initializing = false;
  const descriptor = await wait(async () => {
    let names = []; try { names = await fs.readdir(path.join(root, "instances")); } catch {}
    for (const name of names.filter(name => name.endsWith(".json"))) {
      let value; try { value = JSON.parse(await fs.readFile(path.join(root, "instances", name), "utf8")); } catch { continue; }
      if (value.pid !== process.pid) continue; // Ignore a prior host's descriptor while disposal finishes.
      if (!value.workspaceFolders.some(folder => folder.uri === workspace.uri.toString(true))) continue;
      if (value.lifecycle === "initializing") initializing = true;
      if (value.lifecycle === "ready") return value;
    }
  });
  if (secondary) {
    await publish(path.join(root, "secondary-ready.json"), { instanceId: descriptor.instanceId });
  } else {
    const marker = path.join(root, "reload-requested.json");
    let previous; try { previous = JSON.parse(await fs.readFile(marker, "utf8")); } catch {}
    if (!previous) {
      await publish(marker, { instanceId: descriptor.instanceId, initializing });
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    }
    if (descriptor.instanceId === previous.instanceId) throw new Error("Reload did not replace the extension instance");
    await publish(path.join(root, "window-reloaded.json"), { beforeInstanceId: previous.instanceId, afterInstanceId: descriptor.instanceId, initializing: previous.initializing || initializing });
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(process.env.VSCODE_AGENT_BRIDGE_HTTP_SECONDARY), { forceNewWindow: true });
  }
  await wait(async () => { try { await fs.access(path.join(root, "close-windows")); return true; } catch {} });
  await vscode.commands.executeCommand("workbench.action.closeWindow");
}

async function wait(operation) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("Lifecycle fixture timed out");
}

async function publish(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, target);
}

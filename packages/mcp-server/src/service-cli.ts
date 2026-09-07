import os from "node:os";
import path from "node:path";
import {
  BRIDGE_NAME, BRIDGE_PROTOCOL_VERSION, BRIDGE_RELEASE_VERSION, MCP_TOOL_NAMES, REGISTRY_DIRECTORY_ENV,
  SERVICE_CONTRACT_VERSION, SERVICE_DIRECTORY_ENV, inspectManagedConfigText,
} from "@vscode-agent-bridge/protocol";
import { publicServiceError, ServiceError } from "./service-errors.js";

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  try {
    if (args.length === 1 && args[0] === "--version") { console.log(BRIDGE_RELEASE_VERSION); return; }
    if (args.length === 1 && args[0] === "--self-test") {
      console.log(JSON.stringify({ name: BRIDGE_NAME, version: BRIDGE_RELEASE_VERSION, protocolVersion: BRIDGE_PROTOCOL_VERSION,
        serviceContractVersion: SERVICE_CONTRACT_VERSION, transport: "streamable-http", toolCount: MCP_TOOL_NAMES.length,
        platform: process.platform, architecture: process.arch, runtime: `Bun ${Bun.version}` }));
      return;
    }
    if (args.length === 0 || args[0] === "--help") {
      console.log("VS Code Agent Bridge HTTP service\nserve\nservice install [--source EXE] [--config TOML | --no-config]\nservice start|stop|restart|status|uninstall\nIsolation: --service-dir DIRECTORY [--registry-dir DIRECTORY]");
      return;
    }
    const verb = args.shift();
    const action = verb === "service" ? args.shift() : "serve";
    if ((verb !== "serve" && verb !== "service") || !action || !["serve", "install", "start", "stop", "restart", "status", "uninstall"].includes(action)) throw invalidArguments();
    const options = new Map<string, string>();
    let noConfig = false;
    while (args.length) {
      const option = args.shift()!;
      if (option === "--no-config" && !noConfig) { noConfig = true; continue; }
      const value = args.shift();
      if (!["--source", "--config", "--service-dir", "--registry-dir"].includes(option) || !value || value.startsWith("--") || options.has(option)) throw invalidArguments();
      options.set(option, path.resolve(value));
    }
    if (noConfig && options.has("--config")) throw invalidArguments();
    if (action !== "install" && (options.has("--source") || noConfig)) throw invalidArguments();
    if (options.has("--service-dir")) process.env[SERVICE_DIRECTORY_ENV] = options.get("--service-dir");
    if (options.has("--registry-dir")) {
      if (!process.env[SERVICE_DIRECTORY_ENV]) throw invalidArguments();
      process.env[REGISTRY_DIRECTORY_ENV] = options.get("--registry-dir");
    }
    if (process.platform !== "win32" || process.arch !== "x64") throw new ServiceError("SERVICE_PLATFORM_UNSUPPORTED", "The service requires Windows x64.");
    const { resolveServicePaths, readIdentity, readInstallation, readOptional } = await import("./service-state.js");
    const paths = await resolveServicePaths();
    if (verb === "serve") {
      const { serve } = await import("./service-daemon.js");
      console.log(JSON.stringify(await serve(paths)));
      return;
    }
    const { ServiceInstaller } = await import("./service-installer.js");
    const installer = new ServiceInstaller(paths);
    const { controlRequest, verifyHttpHealth } = await import("./service-control.js");
    let result: unknown;
    switch (action) {
      case "install":
        result = await installer.install({ sourceExecutable: options.get("--source") ?? process.execPath,
          configPath: noConfig ? null : options.get("--config") ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml"),
          ...(options.get("--registry-dir") ? { registryDirectory: options.get("--registry-dir")! } : {}) });
        break;
      case "start": result = await installer.start(); break;
      case "stop": await installer.stop(); result = { stopped: true }; break;
      case "restart": await installer.stop(); result = await installer.start(); break;
      case "uninstall": result = await installer.uninstall(); break;
      case "status": {
        const installation = await readInstallation(paths);
        if (!installation) { result = { installed: false, transport: "streamable-http", service: null, loginTask: "missing", codexConfig: "missing" }; break; }
        const identity = await readIdentity(paths);
        let service = null;
        let serviceError = null;
        try { service = await installer.current(identity); if (service?.state === "ready") await verifyHttpHealth(identity, service); }
        catch (error) { serviceError = publicServiceError(error).code; }
        const task = await installer.scheduler.query();
        const configPath = options.get("--config") ?? installation.codexConfigPath;
        const { httpConnection } = await import("./service-config.js");
        const { isCurrentLoginTask } = await import("./service-scheduler.js");
        result = { installed: true, transport: "streamable-http", installedVersion: installation.version, service, serviceError,
          loginTask: task ? (isCurrentLoginTask(task, paths, installation.executablePath, options.get("--registry-dir")) ? "present" : "invalid") : "missing",
          codexConfig: configPath ? inspectManagedConfigText(await readOptional(configPath) ?? "", httpConnection(identity)) : "missing" };
        break;
      }
      default: throw invalidArguments();
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: publicServiceError(error) }));
    process.exitCode = 1;
  }
}
function invalidArguments(): ServiceError {
  return new ServiceError("SERVICE_CONFIGURATION_INVALID", "Invalid service command. Use --help for supported arguments.");
}

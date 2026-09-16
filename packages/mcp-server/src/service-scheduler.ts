import path from "node:path";
import type { ServicePaths } from "./service-state.js";
import { ServiceError } from "./service-errors.js";

export interface ServiceScheduler {
  query(): Promise<string | null>;
  register(xml: string): Promise<void>;
  remove(): Promise<void>;
  run(): Promise<void>;
}

// Fixed script; values travel over stdin as JSON, never interpolated shell code.
const SCHEDULER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $folder = $scheduler.GetFolder('\')
  $task = $null
  try { $task = $folder.GetTask($request.name) }
  catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
  switch ($request.action) {
    'query' {
      if ($null -eq $task) { [Console]::Out.Write('null') }
      else {
        [xml]$definition = $task.Xml
        foreach ($trigger in $definition.Task.Triggers.LogonTrigger) {
          if ($null -ne $trigger -and $trigger.UserId -and -not $trigger.UserId.StartsWith('S-1-')) {
            $account = New-Object System.Security.Principal.NTAccount($trigger.UserId)
            $trigger.UserId = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
          }
        }
        [Console]::Out.Write((ConvertTo-Json -InputObject $definition.OuterXml -Compress))
      }
    }
    'register' { $null = $folder.RegisterTask($request.name, $request.xml, 6, $null, $null, 3); [Console]::Out.Write('null') }
    'remove' { if ($null -ne $task) { $folder.DeleteTask($request.name, 0) }; [Console]::Out.Write('null') }
    'run' { if ($null -eq $task) { throw 'Missing task' }; $null = $task.Run($null); [Console]::Out.Write('null') }
    default { throw 'Invalid scheduler operation' }
  }
} catch { [Console]::Error.Write('The Windows login task operation failed.'); exit 1 }
`;

export class WindowsServiceScheduler implements ServiceScheduler {
  constructor(readonly paths: ServicePaths) {}
  async #execute(action: string, xml?: string): Promise<unknown> {
    const child = Bun.spawn([path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCHEDULER_SCRIPT, "utf16le").toString("base64")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    child.stdin.write(JSON.stringify({ action, name: this.paths.taskName, ...(xml ? { xml } : {}) }));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error();
      return JSON.parse(output);
    } catch { throw new ServiceError("SERVICE_SCHEDULER_FAILED", "The current-user Windows login task operation failed."); }
    finally { clearTimeout(timer); }
  }
  async query(): Promise<string | null> { const result = await this.#execute("query"); return typeof result === "string" ? result : null; }
  async register(xml: string): Promise<void> { await this.#execute("register", xml); }
  async remove(): Promise<void> { await this.#execute("remove"); }
  async run(): Promise<void> { await this.#execute("run"); }
}

export function createLoginTaskXml(paths: ServicePaths, executablePath: string, registryDirectory?: string): string {
  const args = `serve --service-dir ${quoteWindowsArgument(paths.directory)}${registryDirectory ? ` --registry-dir ${quoteWindowsArgument(registryDirectory)}` : ""}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>VS Code Agent Bridge shared HTTP service</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(paths.userSid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${escapeXml(paths.userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(executablePath)}</Command><Arguments>${escapeXml(args)}</Arguments><WorkingDirectory>${escapeXml(path.dirname(executablePath))}</WorkingDirectory></Exec></Actions>
</Task>`;
}

export function isCurrentLoginTask(xml: string, paths: ServicePaths, executablePath: string, registryDirectory?: string): boolean {
  const expected = createLoginTaskXml(paths, executablePath, registryDirectory);
  // Task Scheduler omits schema defaults when exporting a registered task.
  const defaults: Record<string, string> = { RunLevel: "LeastPrivilege", RunOnlyIfNetworkAvailable: "false", RunOnlyIfIdle: "false", AllowStartOnDemand: "true" };
  for (const tag of ["UserId", "LogonType", "RunLevel", "MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries",
    "AllowHardTerminate", "RunOnlyIfNetworkAvailable", "RunOnlyIfIdle", "AllowStartOnDemand", "ExecutionTimeLimit", "Command", "Arguments", "WorkingDirectory", "Interval", "Count",
    "StopOnIdleEnd", "RestartOnIdle", "StartWhenAvailable", "Hidden"]) {
    const expression = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, "gu");
    const values = (source: string) => {
      const found = [...source.matchAll(expression)].map(match => unescapeXml(match[1] ?? ""));
      return found.length === 0 && defaults[tag] ? [defaults[tag]] : found;
    };
    if (JSON.stringify(values(xml)) !== JSON.stringify(values(expected))) return false;
  }
  return !xml.includes("<Enabled>false</Enabled>") && xml.includes("<LogonTrigger>");
}

function unescapeXml(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"';
}

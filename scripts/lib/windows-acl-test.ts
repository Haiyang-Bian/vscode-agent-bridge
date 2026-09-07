import assert from "node:assert/strict";
import path from "node:path";

export async function assertPrivateWindowsFiles(targets: string[], userSid: string): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$targets = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = @($targets | ForEach-Object {
  $acl = [System.IO.File]::GetAccessControl($_)
  @{ protected = $acl.AreAccessRulesProtected; rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; inherited = $_.IsInherited; rights = [string]$_.FileSystemRights; type = [string]$_.AccessControlType }
  }) }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Depth 6 -Compress))
`;
  const child = Bun.spawn([path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  child.stdin.write(JSON.stringify(targets)); child.stdin.end();
  const [output, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(exit, 0, "ACL inspection must succeed");
  const results = JSON.parse(output) as Array<{ protected: boolean; rules: Array<{ sid: string; inherited: boolean; rights: string; type: string }> }>;
  assert.equal(results.length, targets.length);
  for (const result of results) {
    assert.equal(result.protected, true);
    assert.deepEqual(result.rules.map(rule => rule.sid).sort(), [userSid, "S-1-5-18"].sort());
    for (const rule of result.rules) { assert.equal(rule.inherited, false); assert.equal(rule.rights, "FullControl"); assert.equal(rule.type, "Allow"); }
  }
}

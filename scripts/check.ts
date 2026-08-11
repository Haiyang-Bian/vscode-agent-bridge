const commands = [
  ["bun", "scripts/check-agent-handbook.ts"],
  ["bun", "run", "typecheck"],
  ["bun", "run", "test"],
  ["bun", "run", "build"],
] as const;

for (const command of commands) {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

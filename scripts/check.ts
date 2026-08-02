const tasks = ["typecheck", "test", "build"] as const;

for (const task of tasks) {
  const child = Bun.spawn(["bun", "run", task], {
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

import {
  classifyTestImpact,
  collectChangedPaths,
  parseTestDomains,
  type ImpactPlan,
} from "./lib/test-impact.ts";

const args = Bun.argv.slice(2);
const base = readValue(args, "--base");
const head = readValue(args, "--head");
const requestedDomains = readValues(args, "--domain");
const forceFull = args.includes("--full");

let plan: ImpactPlan;
try {
  plan = classifyTestImpact(await collectChangedPaths({ base, head }), {
    additionalDomains: parseTestDomains(requestedDomains),
    forceFull,
  });
} catch (error) {
  console.error(`Impact classification failed; running the full gate: ${String(error)}`);
  plan = classifyTestImpact(["<impact-classification-failed>"], { forceFull: true });
}

if (plan.commands.length === 0) {
  console.log("No changed files require validation.");
} else {
  console.log(`Validation risk: ${plan.risk}`);
  console.log(`Domains: ${plan.domains.join(", ") || "none"}`);
  for (const command of plan.commands) {
    console.log(`\n> ${command}`);
    const exitCode = await runCommand(command);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      break;
    }
  }
}

async function runCommand(command: string): Promise<number> {
  const [executable, ...commandArgs] = command.split(" ");
  const child = Bun.spawn([executable, ...commandArgs], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

function readValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

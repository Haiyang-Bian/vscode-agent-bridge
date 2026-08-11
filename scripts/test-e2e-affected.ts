import {
  classifyTestImpact,
  collectChangedPaths,
  parseTestDomains,
} from "./lib/test-impact.ts";

const args = Bun.argv.slice(2);
const base = readValue(args, "--base");
const head = readValue(args, "--head");
const domains = parseTestDomains(readValues(args, "--domain"));
const forceFull = args.includes("--full");

let runnerArgs: string[] | undefined;
try {
  const plan = classifyTestImpact(await collectChangedPaths({ base, head }), {
    additionalDomains: domains,
    forceFull,
  });
  if (plan.repeatE2E) {
    runnerArgs = ["--repeat", "2", "full"];
    console.log("E2E selection: full twice because E2E infrastructure changed.");
  } else if (plan.fullE2E) {
    runnerArgs = ["full"];
    console.log("E2E selection: full.");
  } else if (plan.e2eScenarios.length > 0) {
    runnerArgs = plan.e2eScenarios;
    console.log(`E2E selection: ${runnerArgs.join(", ")}.`);
  } else {
    console.log("E2E selection: none; changed paths do not cross a VS Code Extension Host boundary.");
    runnerArgs = undefined;
  }
} catch (error) {
  console.error(`E2E impact classification failed; running full E2E twice: ${String(error)}`);
  runnerArgs = ["--repeat", "2", "full"];
}

if (runnerArgs) {
  const child = Bun.spawn(["bun", "scripts/run-extension-e2e.ts", ...runnerArgs], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

function readValue(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}

function readValues(values: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === flag && values[index + 1]) {
      result.push(values[index + 1]);
      index += 1;
    }
  }
  return result;
}

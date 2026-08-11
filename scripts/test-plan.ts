import {
  classifyTestImpact,
  collectChangedPaths,
  parseTestDomains,
  type ImpactPlan,
} from "./lib/test-impact.ts";

const options = parseArguments(Bun.argv.slice(2));
let plan: ImpactPlan;

try {
  const changedPaths = await collectChangedPaths({ base: options.base, head: options.head });
  plan = classifyTestImpact(changedPaths, {
    additionalDomains: parseTestDomains(options.domains),
    forceFull: options.full,
  });
} catch (error) {
  plan = classifyTestImpact(["<impact-classification-failed>"], { forceFull: true });
  plan.reasons.push(error instanceof Error ? error.message : String(error));
}

if (options.format === "json") {
  console.log(JSON.stringify(plan, null, 2));
} else if (options.format === "github") {
  console.log(`risk=${plan.risk}`);
  console.log(`full_e2e=${plan.fullE2E}`);
  console.log(`e2e_scenarios=${plan.e2eScenarios.join(",")}`);
  console.log(`repeat_e2e=${plan.repeatE2E}`);
  console.log(`artifact=${plan.artifact}`);
} else {
  printTextPlan(plan);
}

function parseArguments(args: string[]): {
  base?: string;
  head?: string;
  domains: string[];
  full: boolean;
  format: "text" | "json" | "github";
} {
  const result: {
    base?: string;
    head?: string;
    domains: string[];
    full: boolean;
    format: "text" | "json" | "github";
  } = { domains: [], full: false, format: "text" };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base" || argument === "--head" || argument === "--domain" || argument === "--format") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === "--base") result.base = value;
      if (argument === "--head") result.head = value;
      if (argument === "--domain") result.domains.push(value);
      if (argument === "--format") {
        if (!["text", "json", "github"].includes(value)) {
          throw new Error(`Unsupported format: ${value}`);
        }
        result.format = value as "text" | "json" | "github";
      }
      continue;
    }
    if (argument === "--full") {
      result.full = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function printTextPlan(plan: ImpactPlan): void {
  console.log(`Risk: ${plan.risk}`);
  console.log(`Changed paths: ${plan.changedPaths.length}`);
  console.log(`Domains: ${plan.domains.join(", ") || "none"}`);
  console.log(`Workspaces: ${plan.workspaces.join(", ") || "none"}`);
  console.log(`E2E: ${plan.fullE2E ? "full" : plan.e2eScenarios.join(", ") || "none"}`);
  console.log(`Repeat E2E: ${plan.repeatE2E ? "yes" : "no"}`);
  console.log(`Artifact gate: ${plan.artifact ? "yes" : "no"}`);
  if (plan.reasons.length > 0) {
    console.log("Reasons:");
    for (const reason of plan.reasons) console.log(`- ${reason}`);
  }
  if (plan.commands.length > 0) {
    console.log("Commands:");
    for (const command of plan.commands) console.log(`- ${command}`);
  } else {
    console.log("Commands: none");
  }
}

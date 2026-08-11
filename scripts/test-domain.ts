import { getDomainTestFiles, parseTestDomains } from "./lib/test-impact.ts";

const domains = parseTestDomains(Bun.argv.slice(2));
if (domains.length === 0) {
  console.error("Usage: bun run test:domain -- <domain...>");
  process.exitCode = 2;
} else {
  const files = getDomainTestFiles(domains);
  console.log(`Testing domains: ${domains.join(", ")}`);
  const child = Bun.spawn(["bun", "test", ...files], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

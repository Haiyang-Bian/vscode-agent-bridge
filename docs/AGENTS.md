# Documentation guidance

These instructions apply under `docs/`.

- Use `agent-handbook/` to describe and route the current system. Do not use it to introduce an architectural decision that has not been accepted elsewhere.
- Put durable architecture and security decisions in a new numbered file under `adr/`. Do not rewrite history to make a later design appear original.
- Keep release intent under `releases/`, executable clean-machine procedures under `acceptance/`, and dated observations under `audits/`.
- Never replace or amend an old audit to report a new run. Create a new dated report and add it to `audits/README.md`.
- When changing package ownership, workflow commands, test domains or decision boundaries, update the corresponding handbook route and `agent-handbook/maintenance.md` checklist.
- Prefer links to authoritative source files over duplicated constants, command lists or version claims.
- Documentation-only work begins with `bun run test:plan`; Agent-handbook changes run `bun scripts/check-agent-handbook.ts`. Do not widen beyond the resulting documentation gate unless another changed path requires it.

# Third-Party Notices

VS Code Agent Bridge bundles or compiles the following principal runtime components. Their licenses are retained in their upstream distributions and repositories.

| Component | Version | License | Project |
| --- | --- | --- | --- |
| Bun runtime | 1.3.11 | MIT and bundled third-party notices | https://github.com/oven-sh/bun |
| Model Context Protocol TypeScript SDK | 1.30.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| smol-toml | 1.6.1 | MIT | https://github.com/squirrelchat/smol-toml |
| Zod | 4.4.3 | MIT | https://github.com/colinhacks/zod |

Development-only tooling such as TypeScript, VS Code Test CLI, VS Code Test Electron and `vsce` is not shipped as extension runtime code. The exact dependency graph is locked in `bun.lock` in the source repository.

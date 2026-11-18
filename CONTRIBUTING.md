# Contributing to Kiln

Thanks for helping. Small, focused pull requests are the easiest to review.

## Set up

```bash
npm install
npm run dev            # web app at http://localhost:5173
npm run desktop:dev    # desktop app (needs Rust: https://rustup.rs)
```

Before you open a pull request:

```bash
npm run lint
npm run build
```

## Where things live

- `src/editor/style.ts` turns a layer into CSS. The canvas and every exporter use it, so a fix there fixes both.
- `src/codegen/` has the exporters (HTML, React, Tailwind, Vue, tokens).
- `src/agent/` has the agent tools and providers. `src-tauri/src/mcp.rs` serves them over MCP.
- `src-tauri/` is the Rust side: files, export, the MCP server and the agent CLI runner.

## Pull requests

- One change per pull request, with a sentence on what it fixes and how you checked it.
- For anything you can see, add a before and after screenshot.
- New exporter output should match what the canvas draws.

## Bugs and ideas

Open an issue with the template. For a bug, include your OS, whether it's the web or desktop app, and the steps to reproduce.

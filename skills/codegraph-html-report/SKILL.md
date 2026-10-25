---
name: codegraph-html-report
description: Analyze a local source project with CodeGraph and generate a complete, readable offline HTML architecture report with call graphs, dependencies, symbols, source snippets, and analysis limits.
---

# CodeGraph HTML Report

Use this skill when the user asks for a complete project/codebase analysis document, architecture overview, function call graph, dependency map, or a readable HTML report generated from source code.

## Outcome

Produce one self-contained HTML file. The report must be useful without a running server or network connection and must contain:

- project and indexing summary;
- directory/module structure;
- a function or method call graph;
- key symbols with file paths and line numbers;
- source snippets for the most important symbols;
- impact/dependency information where the graph provides it;
- an explicit limitations and unresolved-reference section.

The default output is `.codewiki/reports/codegraph-report-<timestamp>.html` in the analyzed project. Use a user-specified output path when provided. Do not start an HTTP server, expose a port, upload source code, execute project code, or edit project source files.

## Workflow

1. Resolve the project path. If the user did not provide one, use the current working directory. Confirm that it is a readable directory.
2. Check that Node.js is 22.5 or newer. The CodeGraph library needs this runtime. If the local skill dependencies are absent, run `npm install --prefix <this-skill-directory>` to install its pinned dependencies; do not install project dependencies or run project scripts.
3. Inspect the project's README, package manifests, build/config files, and obvious entrypoints. Write a short temporary Markdown supplement with the human-readable architecture narrative (technology stack, module responsibilities, execution flow, extension points, tests/build/deploy entrypoints, and observed risks). Pass it with `--supplement` so the generated report combines graph evidence with source-level explanation. Do not guess details that are not supported by the files.
4. Run `scripts/generate_report.mjs` with the project path, output path, optional `--symbol`, `--depth`, `--scope`, and `--supplement` arguments. The script opens or creates the project's `.codegraph` index, extracts a bounded report snapshot, writes the Markdown draft, and renders the final HTML with the locally installed `answer-me-with-html` CLI.
5. Keep CodeGraph's progress visible, but keep the final response short: report the absolute HTML path, project statistics, and any material warnings.
6. Verify that the output exists, is non-empty, contains the project title, and has no external resource loads. Remove the temporary Markdown draft and supplement after successful rendering.

Read [references/codegraph-api.md](references/codegraph-api.md) when changing the extraction script or adding a new graph section. Read [references/report-format.md](references/report-format.md) when changing the Markdown panels or diagram syntax.

## Analysis rules

- Prefer CodeGraph's public API over direct SQLite access.
- Use `CodeGraph.open()` for an existing index and `CodeGraph.init()` for a project without one. Close the graph in a `finally` block.
- Treat `calls`, `imports`, and impact results as static-analysis evidence. Do not describe a static edge as a runtime guarantee.
- Keep graph output bounded. The script's defaults are 120 call-graph nodes, 300 edges, 40 key symbols, and 36 source lines per snippet. Preserve a visible truncation warning when a limit is reached.
- Show unresolved references and incomplete/partial index state in the report. Never invent a callee or silently drop an analysis warning.
- Keep paths project-relative in the HTML, and include one-based line numbers for every embedded source snippet.
- Embed all report data, CSS, SVG, and JavaScript in the output. The rendered document must work when opened with `file://` after the command exits.

## Report writing

Use Answer me with HTML's panel-oriented Markdown format: a short introduction followed by `##` panels, tables for statistics, `flow` diagrams for small call graphs, and fenced source blocks for snippets. Prefer clear headings and concise explanations. Every graph panel must state its scope, depth, and whether it was truncated. The final panel must explain unresolved references, excluded files, and other limits.

## Failure handling

- A missing or invalid project path is an actionable error; do not generate an empty report.
- A local parse failure for some files should produce a report with a warning when CodeGraph can finish indexing.
- A failed index, missing renderer, or failed HTML write should return a non-zero exit status and identify the corrective action.
- Never fall back to an invented graph when CodeGraph is unavailable.

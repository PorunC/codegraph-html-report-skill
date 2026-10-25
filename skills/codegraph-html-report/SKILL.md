---
name: codegraph-html-report
description: Analyze a local source project with CodeGraph and generate a focused, diagram-first offline HTML architecture report with project areas, module relationships, module flows, and analysis limits.
---

# CodeGraph HTML Report

Use this skill when the user asks for a readable project/codebase analysis document, architecture overview, module flow or dependency map, or HTML report generated from source code.

## Outcome

Produce one self-contained HTML file. Optimize for a reader who needs the project's main structure quickly. The report must be useful without a running server or network connection and must contain:

- a short project and indexing summary;
- a compact project-area diagram and module architecture diagram based on high-confidence graph relationships;
- one to three focused downstream module-flow diagrams;
- a compact module-flow view derived from the selected call paths;
- a static impact or unresolved-boundary diagram when the graph provides it;
- an explicit limitations and unresolved-reference section.

The default output is `.codewiki/reports/codegraph-report-<timestamp>.html` in the analyzed project. Use a user-specified output path when provided. Do not start an HTTP server, expose a port, upload source code, execute project code, or edit project source files.

## Workflow

1. Resolve the project path. If the user did not provide one, use the current working directory. Confirm that it is a readable directory.
2. Check that Node.js is 22.5 or newer. The CodeGraph library needs this runtime. If the local skill dependencies are absent, run `npm install --prefix <this-skill-directory>` to install its pinned dependencies; do not install project dependencies or run project scripts.
3. Inspect the project's README, package manifests, build/config files, and obvious entrypoints. Write a short temporary Markdown supplement with a human-readable, module-level architecture narrative (technology stack, module responsibilities, execution flow, extension points, tests/build/deploy entrypoints, and observed risks). Do not name individual functions or list files/line locations. Pass it with `--supplement`; do not guess details that are not supported by the files.
4. Run `scripts/generate_report.mjs` with the project path, output path, optional `--symbol`, `--depth`, `--scope`, and `--supplement` arguments. The script opens or creates the project's `.codegraph` index, extracts a bounded report snapshot, writes the Markdown draft, and renders the final HTML with the locally installed `answer-me-with-html` CLI.
5. Keep CodeGraph's progress visible, but keep the final response short: report the absolute HTML path, project statistics, and any material warnings.
6. Verify that the output exists, is non-empty, contains the project title, and has no external resource loads. Remove the temporary Markdown draft and supplement after successful rendering.

Read [references/codegraph-api.md](references/codegraph-api.md) when changing the extraction script or adding a new graph section. Read [references/report-format.md](references/report-format.md) when changing the Markdown panels or diagram syntax.

## Analysis rules

- Prefer CodeGraph's public API over direct SQLite access.
- Use `CodeGraph.open()` for an existing index and `CodeGraph.init()` for a project without one. Close the graph in a `finally` block.
- Treat `calls`, `imports`, and impact results as static-analysis evidence. Do not describe a static edge as a runtime guarantee.
- Prefer CodeGraph's module aggregation for architecture. Use file-pair fallback only when aggregation is unavailable, and state that fallback in the report.
- Select entry candidates from executable file roots, routes/components, exported symbols, and conventional entry names. Use fan-in/fan-out only as ranking signals. Do not merge unrelated symbols just because they share a name.
- Build each focused path separately and follow downstream `calls` edges, then collapse each path to module-level flows for the report.
- Keep CodeGraph IDs, hashes, synthetic names, individual function names, and source locations out of the default project report. Use module-level nodes and plain relationship labels such as `calls`, `depends on`, and `may affect`.
- Translate graph relationship kinds into plain reader-facing labels and group selected paths at module level. Avoid function/location inventory tables and source dumps.
- Keep graph output bounded for reading: at most 8 architecture modules, 14 architecture links, 3 entry paths, 10 internal nodes and 14 edges per path, 8 impact modules, 14 impact links, and 12 unresolved references. Preserve a visible warning when secondary relationships are folded out.
- Show unresolved references and incomplete/partial index state in the report. Never invent a callee or silently drop an analysis warning.
- Keep the report at project/module level outside the diagrams; do not expand individual file paths or line numbers into lists.
- Embed all report data, CSS, SVG, and JavaScript in the output. The rendered document must work when opened with `file://` after the command exits.

## Report writing

Use Answer me with HTML's panel-oriented Markdown format: a short conclusion followed by diagrams for project areas, entry areas, module architecture, selected module flows, optional impact, and optional unresolved boundaries. Keep the homepage concise. Do not name individual functions or add file/location inventory tables or source dumps. Explain each diagram's scope and aggregation; show when lower-ranked relationships were folded out. Hide panels that have no useful content, especially in overview scope. The final panel must explain unresolved references, excluded files, and other limits.

## Failure handling

- A missing or invalid project path is an actionable error; do not generate an empty report.
- A local parse failure for some files should produce a report with a warning when CodeGraph can finish indexing.
- A failed index, missing renderer, or failed HTML write should return a non-zero exit status and identify the corrective action.
- Never fall back to an invented graph when CodeGraph is unavailable.

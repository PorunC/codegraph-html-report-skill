---
name: codegraph-html-report
description: Analyze a local source project with CodeGraph and generate a readable, multi-page offline HTML report with architecture diagrams, key function call flows, and analysis limits.
---

# CodeGraph HTML Report

Use this skill when the user asks for a readable project/codebase analysis document, architecture overview, module flow or dependency map, or HTML report generated from source code.

## Outcome

Produce a self-contained offline report directory. The report must be useful without a running server or network connection and must contain:

- `index.html`: project summary, project areas, architecture preview, and links to the child pages;
- `architecture.html`: project-area tree, module architecture, entry areas, and cross-module flow overview;
- `call-flows.html`: one to three focused function call flow diagrams using source function names, with plain-language reading guidance;
- `details.html`: static impact, unresolved-reference boundary, and analysis limits.

The default output is `.codewiki/reports/codegraph-report-<timestamp>/index.html` in the analyzed project. A directory passed to `--output` receives these four pages; a `.html` path remains supported as the overview page and places sibling pages beside it. Do not start an HTTP server, expose a port, upload source code, execute project code, or edit project source files.

## Workflow

1. Resolve the project path. If the user did not provide one, use the current working directory. Confirm that it is a readable directory.
2. Check that Node.js is 22.5 or newer. The CodeGraph library needs this runtime. If the local skill dependencies are absent, run `npm install --prefix <this-skill-directory>` to install its pinned dependencies; do not install project dependencies or run project scripts.
3. Inspect the project's README, package manifests, build/config files, and obvious entrypoints. Write a short temporary Markdown supplement with a human-readable, module-level architecture narrative (technology stack, module responsibilities, execution flow, extension points, tests/build/deploy entrypoints, and observed risks). Do not name individual functions or list files/line locations. Pass it with `--supplement`; do not guess details that are not supported by the files.
4. Run `scripts/generate_report.mjs` with the project path, output path, optional `--symbol`, `--depth`, `--scope`, and `--supplement` arguments. The script opens or creates the project's `.codegraph` index, extracts a bounded report snapshot, writes four Markdown drafts, and renders four linked HTML pages with the locally installed `answer-me-with-html` CLI.
5. Keep CodeGraph's progress visible, but keep the final response short: report the absolute `index.html` path, report directory, project statistics, and material warnings.
6. Verify that all four pages exist, are non-empty, contain their page titles, use local relative links, and have no external resource loads. Remove temporary Markdown drafts and supplements after successful rendering.

Read [references/codegraph-api.md](references/codegraph-api.md) when changing the extraction script or adding a new graph section. Read [references/report-format.md](references/report-format.md) when changing the Markdown panels or diagram syntax.

## Analysis rules

- Prefer CodeGraph's public API over direct SQLite access.
- Use `CodeGraph.open()` for an existing index and `CodeGraph.init()` for a project without one. Close the graph in a `finally` block.
- Treat `calls`, `imports`, and impact results as static-analysis evidence. Do not describe a static edge as a runtime guarantee.
- Prefer CodeGraph's module aggregation for architecture. Use file-pair fallback only when aggregation is unavailable, and state that fallback in the report.
- Select entry candidates from executable file roots, routes/components, exported symbols, and conventional entry names. Use fan-in/fan-out only as ranking signals. Do not merge unrelated symbols just because they share a name.
- Build each focused path separately and follow downstream `calls` edges. Keep both a module-level aggregation for architecture pages and a bounded function-level representation for `call-flows.html`.
- Keep CodeGraph IDs, hashes, synthetic names, source locations, and function/location inventory tables out of the overview, architecture, and details pages. The key call-flow diagrams may show source function names, prefixed by their module; keep names on diagram nodes instead of repeating them in explanatory prose or a function inventory.
- Translate graph relationship kinds into plain Chinese reader-facing labels and explain what arrows and branches mean. Avoid source dumps and file/location lists.
- Keep graph output bounded for reading: at most 8 architecture modules, 14 architecture links, 3 entry paths, 2 downstream targets per call node, 10 nodes and 14 edges per path, 8 impact modules, 14 impact links, and 12 unresolved-reference names. Preserve a visible warning when secondary relationships are folded out.
- Show unresolved references and incomplete/partial index state in the report. Never invent a callee or silently drop an analysis warning.
- Keep the report at project/module level outside the function-flow diagrams; do not expand individual file paths or line numbers into lists.
- Embed all page data, CSS, SVG, and JavaScript in each output file. Page navigation must use relative links and work when `index.html` is opened with `file://` after the command exits.

## Report writing

Write each page for a reader who has not seen the source index. Lead with the page's conclusion or purpose, then organize material in the order the reader needs it.

- Keep the overview short. State the analysis scope and main conclusion first, show a compact architecture preview, and link to the page that answers each next question.
- Organize architecture as project areas, module relationships, candidate entry areas or cross-module paths, then a short reading guide. Explain arrows beside the diagram.
- Introduce each call-flow diagram as a structurally selected candidate path. Static entry selection does not establish the user's trigger or business purpose. Split long diagrams into static call-depth layers using only the original nodes and edges; a real node may appear in adjacent diagrams as a boundary. Layer numbers do not imply runtime phases. Never add a synthetic continuation node or relation.
- Explain that multiple outgoing edges identify multiple static targets, not proven conditional branches or execution order. State when normal outputs, return values, exception paths, or recovery behavior cannot be confirmed. A leaf in a bounded graph is not a confirmed business endpoint.
- Place impact, unresolved-reference, index-state, exclusion, and folding explanations next to the relevant diagram or in the details page. Distinguish analysis/index warnings from visual folding notices.
- Select `sheet` for compact parallel summaries and `doc` for content that needs sequential reading. Keep the choice deterministic and omit `cols` from `doc` frontmatter.
- Use diagrams for project areas, module relationships, candidate entry areas, cross-module paths, key function calls, impact, and unresolved boundaries. Keep function names only on key call-flow diagram nodes, prefixed with their module. Do not repeat them in prose or add function, file, or location inventories.
- Hide empty diagrams and state why they are absent. Keep folded relationship notices visible; never shrink or overfill a diagram to imply completeness.

Do not infer a business result, exception path, or runtime ordering from a static graph. When the available snapshot cannot support a statement, say “无法确认” or “未识别到” and explain the scope that was checked. Read [references/report-format.md](references/report-format.md) when editing page structure, layout rules, or diagrams.

## Failure handling

- A missing or invalid project path is an actionable error; do not generate an empty report.
- A local parse failure for some files should produce a report with a warning when CodeGraph can finish indexing.
- A failed index, missing renderer, or failed HTML write should return a non-zero exit status and identify the corrective action.
- Never fall back to an invented graph when CodeGraph is unavailable.

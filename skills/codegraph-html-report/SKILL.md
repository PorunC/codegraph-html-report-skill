---
name: codegraph-html-report
description: Read a local project and create an evidence-backed, multi-page offline HTML architecture and workflow report.
---

# Project Source Analysis HTML Report

Use this skill when the user wants a readable project analysis report with architecture or workflow diagrams. The Skill agent reads project sources and documentation, writes structured findings, then runs a local renderer. The generator validates JSON and produces Markdown and HTML; it does not call a model API or analyze source code itself.

## Output

Create four self-contained pages under `.codewiki/reports/source-analysis-report-<timestamp>/`:

- `index.html`: project scope, main conclusions, and links to the report sections;
- `architecture.html`: major areas, responsibilities, and only evidence-backed area relationships;
- `call-flows.html`: selected workflows with source-backed steps and relations;
- `details.html`: analysis scope, entry clues, extension points, risks, evidence limits, and unknowns.

The pages use relative navigation and must work from `index.html` opened with `file://`. A `.html` `--output` path remains supported as the overview page, with sibling pages beside it.

## Workflow

1. Resolve the project root from the request or current working directory. Do not inspect outside it unless the user explicitly includes an external document.
2. Read the project README and package/build configuration. Then inspect relevant entry setup, major source areas, and tests or deployment configuration when they clarify behavior. Scale the reading to project size. Do not claim an exhaustive audit unless the full scope was actually reviewed.
3. Draft findings from source and project documentation. Record the reviewed scope, exclusions, evidence files, and unresolved questions. Distinguish statements directly supported by code from interpretive judgments.
4. Build a temporary JSON file that follows [references/source-analysis.schema.json](references/source-analysis.schema.json). Use project-relative evidence paths that exist. Keep source notes concise. Do not create function, file, or line-location inventories. Keep the number of items within the schema bounds and prioritize high-value content instead of truncating it later.
5. Draw an architecture or flow edge only when the JSON includes a concrete source citation for that relationship, including at least one `direct` evidence item. Do not infer behavior from names, directory layout, framework conventions, or neighboring nodes. Put uncertain behavior in `unknowns` or prose, not in a confirmed edge. Use concise, human-readable action labels for flow nodes; do not expose source function names or create function/location inventories.
6. Invoke the local generator with `--analysis <json>` and `--project <root>`. The generator validates the contract and cited files, writes four Markdown drafts, and renders four offline HTML pages with the locally installed `answer-me-with-html` CLI. It never scans or indexes the source project.
7. Check that all pages exist and are non-empty, titles and relative links work, and no external resources remain. Remove only temporary JSON and draft files created for this run after successful generation.
8. Report the absolute `index.html` path, a short description of the reviewed scope, and any material unknowns or analysis limits.

Do not install project dependencies, execute project scripts, start a server, upload source, or modify project source files. Do not install, run, or require CodeGraph. Do not create, update, or delete a `.codegraph/` directory; leave any pre-existing index untouched.

## Writing and diagram rules

- Lead the overview with the project's supported purpose and the scope actually reviewed.
- Explain area responsibilities in plain language. Use architecture arrows only for relationships present in the analysis JSON with source evidence.
- Explain every diagram's arrows and limits nearby. `source-analysis.json` is an agent-produced interpretation of the reviewed files, not runtime tracing.
- Do not present a sequence unless its order is supported by code. A node without a drawn outgoing edge is not necessarily a business endpoint.
- Keep evidence attached to the claim or edge it supports. Cite a concise project-relative source path; do not turn evidence into a function, file, or line-location inventory.
- Mark interpretations distinctly from direct source facts. Interpretive-only relationships must not appear as definite graph edges.
- State unknowns clearly. Do not invent a business result, failure path, return value, or framework behavior.
- Select `sheet` for compact parallel content and `doc` when readers need a longer sequence. Keep layout selection deterministic; only `sheet` frontmatter has `cols`.
- Keep diagrams bounded and readable. If relationships are omitted, state that they were omitted and why.

Read [references/report-format.md](references/report-format.md) when changing page structure or diagram syntax. Read the schema when preparing the JSON handoff or changing data validation.

## Failure handling

- `--analysis` is required. Missing, malformed, structurally invalid, or unsupported evidence paths must produce a non-zero exit and an actionable message without rendering an empty report.
- A missing local renderer must produce a non-zero exit and name the Skill dependency install command.
- A failed render or offline-link check must return a non-zero exit. Preserve user-provided analysis JSON and explicit draft directories.
- Do not fall back to inferred graph data when a citation or relationship is missing.

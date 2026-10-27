# Report format

The Skill agent prepares a structured `source-analysis.json`; the local generator validates it and renders four Markdown drafts with the bundled `answer-me-with-html` CLI. The JSON contract is defined in [source-analysis.schema.json](source-analysis.schema.json). Keep page links relative so the report opens from `index.html` with `file://` and no server.

The generator command is:

```bash
node scripts/generate_report.mjs --project /path/to/project --analysis /path/to/source-analysis.json --output /path/to/report
```

Use four pages: project overview, architecture, key workflows, and evidence/limits. Each page keeps navigation links to the other three pages.

## Page layout

- Use `sheet` for a compact overview, a few parallel summaries, or a short architecture page. Add `cols` only for this template.
- Use `doc` for architecture pages with several diagram sections, multiple or long workflows, or details that need a clear reading order. Do not add `cols` to `doc` frontmatter.
- The deterministic selector uses the validated analysis data and generated Markdown. It does not inspect or rescan project source.
- Both templates keep the same title, subtitle, language, theme, and relative navigation.

```markdown
---
template: sheet
theme: auto
lang: zh-CN
title: Project report
subtitle: Source review
cols: 2
---
**报告导航：** **总览**　·　[架构图](architecture.html)　·　[关键流程](call-flows.html)　·　[证据与边界](details.html)

# Page title

## Diagram panel {span=2}

```flow LR
API -> Storage: 直接依赖 · 依据 1
```
```

## Evidence and diagrams

Every relationship in a diagram must have a concrete citation in the input JSON and at least one `direct` evidence item. Interpretive-only relationships belong in prose, not diagrams. A relationship without direct evidence is invalid and must not be drawn.

Use `tree` for area hierarchy and responsibility, `flow` for evidence-backed relationships, and `sequence` only when interaction order is supported by source code. Diagram nodes represent the supplied labels; do not infer missing edges from naming or common framework patterns.

Keep a concise project-relative source path near each claim or diagram edge it supports. Evidence notes should explain what the source supports in plain language, not reproduce source code. Use short action labels for flow nodes; do not expose exact source function names or list code locations in the report. The analysis JSON may retain a location internally to help validate the agent's evidence, but the renderer omits that field from reader-facing pages.

For workflows, list the source-backed steps and draw only explicit edges from the JSON. If the steps have evidence but no supported transition, show them as notes without a connected flow diagram. State unknown behavior beside the relevant flow. Do not infer a normal result, failure result, exception path, or runtime ordering from a component name or directory structure.

Keep the overview concise. Put project scope, main conclusions, and the reading route first. Explain responsibilities on the architecture page and explain analysis coverage, exclusions, risks, and unknowns on the details page.

Do not add remote resources, external stylesheets, scripts, fonts, or images. The final HTML must work offline with relative links between the four pages.

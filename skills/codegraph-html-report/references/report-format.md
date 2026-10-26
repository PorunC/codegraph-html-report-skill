# Report format

The generator writes four Markdown drafts and renders them with the local `answer-me-with-html` CLI. Keep links between pages relative so the report opens from `index.html` with `file://` and no server. If `--output` is a `.html` path, use it as the overview and place the other pages beside it with `-architecture`, `-call-flows`, and `-details` suffixes.

```bash
node node_modules/answer-me-with-html/bin/am.js render draft.md -o page.html --no-open
```

Use this page structure and keep the navigation on all four pages:

````markdown
---
template: sheet
theme: auto
lang: zh-CN
title: Project architecture report
subtitle: Static analysis snapshot
cols: 2
---
**报告导航：** **总览**　·　[架构图](architecture.html)　·　[函数调用流程](call-flows.html)　·　[影响与边界](details.html)

# Page title

## Diagram panel {span=2}

```flow LR
src/api -> src/core: 依赖
```
````

Choose a layout from the content shape rather than fixing every page to the same grid:

- `sheet` is for a compact overview, a few parallel summaries, or a short architecture page. Set `cols` only for this template.
- `doc` is for architecture pages with several diagram sections, multiple or long call paths, or details that need a clear reading order. Do not add `cols` to a `doc` frontmatter block.
- Keep the choice deterministic and base it on the existing snapshot and generated Markdown. Do not rescan the project to select a template.
- Both templates retain the same title, subtitle, theme, language, and relative page navigation.

````markdown
---
template: doc
theme: auto
lang: zh-CN
title: Project architecture report
subtitle: Static analysis snapshot
---
**报告导航：** **总览**　·　[架构图](architecture.html)　·　[函数调用流程](call-flows.html)　·　[影响与边界](details.html)

# Page title

## A reading section

Read sections in order. Use headings to make a long page easy to scan.
````

Use separate pages for the project overview, architecture, key function call flows, and impact/analysis limits. Keep the overview short and direct readers to the child page that answers each next question. Organize architecture as project areas, module relationships, candidate entry areas or cross-module paths, then a short reading guide.

For each key call path, explain that the entry is a static structural candidate whose user-facing trigger and business purpose may be unknown. Split a long path into static call-depth layers using only nodes and edges already present in the snapshot. A real node may appear in adjacent diagrams as a boundary; layer numbers do not imply runtime phases. Do not add a synthetic continuation node or relation. Explain that multiple outgoing edges are multiple static targets, not proof of a runtime condition or execution order. A terminal node in a bounded graph does not prove a business endpoint. State when normal output, return values, exception behavior, or recovery paths cannot be confirmed.

Explain each diagram beside it: what arrows represent, what a visible fan-out means, and what the graph cannot confirm. Distinguish analysis/index warnings from display limits. Keep index state, unresolved-reference scope, excluded areas, and folded relationships visible. Hide diagrams with no useful relationships and explain why they are absent. Do not put remote URLs in HTML blocks or Markdown image references.

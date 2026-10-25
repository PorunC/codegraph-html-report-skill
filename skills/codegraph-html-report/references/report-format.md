# Report format

The generator writes four Markdown drafts and renders each one with the local `answer-me-with-html` CLI. Keep links between pages relative so the report opens from `index.html` with `file://` and no server. If `--output` is a `.html` path, use it as the overview and place the other three pages beside it with `-architecture`, `-call-flows`, and `-details` suffixes.

```bash
node node_modules/answer-me-with-html/bin/am.js render draft.md -o page.html --no-open
```

Use this structure for each page:

```markdown
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
src/api -> src/core: 调用
```
```

Use separate pages for the project overview, architecture, key function call flows, and impact/analysis limits. Keep the overview and architecture at project/module level. The call-flow diagrams may show a small set of source function names, prefixed by their module; keep those names on diagram nodes instead of repeating them in prose or a function inventory. Explain arrows, branches, scope, and static-analysis limits in plain Chinese. Do not add source snippets or file/line inventory lists.

Hide diagrams with no useful relationships and explain why they are absent. Show when low-priority relationships were folded out. Do not put remote URLs in HTML blocks or Markdown image references.

# Report format

The Markdown draft is rendered by the locally installed `answer-me-with-html` CLI:

```bash
node node_modules/answer-me-with-html/bin/am.js render draft.md -o report.html --no-open
```

Use this shape:

```markdown
---
template: sheet
theme: auto
title: Project architecture report
subtitle: Static analysis snapshot
cols: 3
---
Short statement of what the report covers.

## Overview
A short statistics table and a concise interpretation.

## Module flow
```flow LR
src/api -> src/core: calls
```

## Diagram panels
Prefer project/module diagrams over function or location inventory tables. The default report keeps individual function names, file paths, and line numbers out of the report body.

## Limitations
Explain unresolved edges, excluded files, and truncation.
```

Do not put remote URLs in HTML blocks or Markdown image references. Avoid source snippets and location lists; escape table cells containing `|` or newlines.

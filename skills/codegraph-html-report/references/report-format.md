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
Tables and a concise interpretation.

## Call graph
```flow LR
A -> B: calls
```

## Key symbols
Use source-relative paths and one-based line numbers.

## Limitations
Explain unresolved edges, excluded files, and truncation.
```

Do not put remote URLs in HTML blocks or Markdown image references. Keep code snippets short and escape table cells containing `|` or newlines.

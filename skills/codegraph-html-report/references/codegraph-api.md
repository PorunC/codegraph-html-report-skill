# CodeGraph API used by this skill

The report generator uses the public `CodeGraph` facade. It does not depend on internal SQLite tables.

```ts
import CodeGraphModule from '@colbymchenry/codegraph';

const CodeGraph = CodeGraphModule.default ?? CodeGraphModule.CodeGraph;
const graph = CodeGraph.isInitialized(root)
  ? await CodeGraph.open(root, { sync: true })
  : await CodeGraph.init(root, { index: true, onProgress });

const stats = graph.getStats();
const results = graph.searchNodes(query, { limit: 50 });
const callers = graph.getCallers(nodeId, depth);
const callees = graph.getCallees(nodeId, depth);
const impact = graph.getImpactRadius(nodeId, depth);
graph.close();
```

Useful node fields are `id`, `kind`, `name`, `qualifiedName`, `filePath`, `language`, `startLine`, `endLine`, `signature`, and `docstring`. Useful edge fields are `source`, `target`, `kind`, `line`, and `provenance`.

`getStats()` returns `fileCount`, `nodeCount`, `edgeCount`, `nodesByKind`, `edgesByKind`, `filesByLanguage`, and index timestamps. `getCallers()` and `getCallees()` return `{ node, edge }` pairs. `getImpactRadius()` returns a `Subgraph` with `nodes`, `edges`, and `roots`.

The generator should cap all traversal results before writing Markdown. A cap is a presentation limit, not evidence that the graph contains no further relationships.

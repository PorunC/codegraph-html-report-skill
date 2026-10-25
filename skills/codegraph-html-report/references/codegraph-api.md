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
const assignments = fileNodes.map(({ filePath }) => ({
  filePath,
  module: moduleFor(filePath),
}));
const architecture = graph.getModuleAggregation(assignments, {
  kinds: ['calls', 'imports', 'exports'],
  minConfidence: 0.75,
  topPairsPerLink: 2,
  pairKinds: ['calls', 'imports'],
});
graph.close();
```

Useful node fields are `id`, `kind`, `name`, `qualifiedName`, `filePath`, `language`, `startLine`, `endLine`, `signature`, and `docstring`. Useful edge fields are `source`, `target`, `kind`, `line`, and `provenance`.

`getStats()` returns `fileCount`, `nodeCount`, `edgeCount`, `nodesByKind`, `edgesByKind`, `filesByLanguage`, and index timestamps. `getCallers()` and `getCallees()` return `{ node, edge }` pairs. `getImpactRadius()` returns a `Subgraph` with `nodes`, `edges`, and `roots`.

For a readable architecture diagram, assign each indexed file to a project-relative module name and use `getModuleAggregation()`. Its `links` roll up graph relationships to module pairs; `declared` counts relationships supported by explicit source syntax, while `uncertain` identifies lower-confidence resolution. Use `pairs` to retain a small amount of symbol-level evidence behind a module link. Do not treat a static link as proof of runtime execution.

The generator should cap all traversal results before writing Markdown. A cap is a presentation limit, not evidence that the graph contains no further relationships.

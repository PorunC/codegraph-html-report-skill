#!/usr/bin/env node

/**
 * Build a bounded Markdown architecture report with CodeGraph and render it
 * to a standalone HTML file with the local answer-me-with-html CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DEFAULT_DEPTH = 2;
const LIMITS = {
  callNodes: 120,
  callEdges: 300,
  symbols: 40,
  snippetLines: 36,
};

function usage() {
  console.log(`Usage: generate_report.mjs [options]

Options:
  --project <path>   Project directory (default: current directory)
  --output <path>    HTML output path (default: .codewiki/reports/...html)
  --symbol <name>    Symbol to use as the call-graph focal point
  --depth <number>   Call-graph traversal depth (default: ${DEFAULT_DEPTH})
  --scope <mode>     overview | full | symbol (default: full)
  --supplement <md>  Add architecture notes written from project source review
  --draft <path>     Keep the generated Markdown draft at this path
  --help             Show this help
`);
}

function parseArgs(argv) {
  const args = { project: process.cwd(), depth: DEFAULT_DEPTH, scope: 'full' };
  let hasProject = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--project' || arg === '-p') { args.project = argv[++i]; hasProject = true; }
    else if (arg === '--output' || arg === '-o') args.output = argv[++i];
    else if (arg === '--symbol' || arg === '-s') args.symbol = argv[++i];
    else if (arg === '--depth' || arg === '-d') args.depth = Number(argv[++i]);
    else if (arg === '--scope') args.scope = argv[++i];
    else if (arg === '--supplement') args.supplement = argv[++i];
    else if (arg === '--draft') args.draft = argv[++i];
    else if (!arg.startsWith('-') && !hasProject) { args.project = arg; hasProject = true; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.depth) || args.depth < 1 || args.depth > 6) {
    throw new Error('--depth must be an integer from 1 to 6');
  }
  if (!['overview', 'full', 'symbol'].includes(args.scope)) {
    throw new Error('--scope must be overview, full, or symbol');
  }
  if (args.scope === 'symbol' && !args.symbol) {
    throw new Error('--scope symbol requires --symbol <name>');
  }
  return args;
}

function ensureProject(projectArg) {
  const root = path.resolve(projectArg || process.cwd());
  const stat = fs.statSync(root, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new Error(`Project directory does not exist: ${root}`);
  fs.accessSync(root, fs.constants.R_OK);
  return root;
}

function quoteYaml(value) {
  return JSON.stringify(String(value ?? ''));
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function escapeInline(value) {
  return String(value ?? '').replaceAll('`', '\\`');
}

function inlineCode(value) {
  return `\`${escapeInline(value)}\``;
}

function safeCode(source) {
  return String(source ?? '').replaceAll('```', "``\u200b`");
}

function redactSource(source) {
  const assignment = /([A-Z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|private[_-]?key)[A-Z0-9_.-]*\s*[:=]\s*['"]?)[^\s,'";]+/i;
  return String(source ?? '').split('\n').map((line) => line.replace(assignment, '$1[REDACTED]')).join('\n');
}

function isSensitivePath(filePath) {
  return /(^|\/)(\.env(?:\.|$)|secrets?)(\/|$)|(^|\/)(id_rsa|id_ed25519)(\.|$)|\.(pem|key|p12|pfx)$/i.test(String(filePath));
}

function relativePath(root, filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const relative = path.relative(root, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function lineRange(node) {
  return `${node.startLine ?? '?'}-${node.endLine ?? node.startLine ?? '?'}`;
}

function languageFor(filePath, fallback = 'text') {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', go: 'go', rs: 'rust', java: 'java', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', vue: 'vue', svelte: 'svelte' };
  return map[ext] || fallback;
}

function progressPrinter(progress) {
  const phase = progress?.phase || 'indexing';
  const current = progress?.current ?? 0;
  const total = progress?.total ?? 0;
  const suffix = total ? ` ${current}/${total}` : '';
  process.stderr.write(`[CodeGraph] ${phase}${suffix}\n`);
}

async function loadCodeGraph() {
  try {
    const module = await import('@colbymchenry/codegraph');
    const exports = module.default ?? module;
    return exports.CodeGraph ?? exports.default ?? module.CodeGraph ?? exports;
  } catch (error) {
    throw new Error('CodeGraph is not installed. Run npm install in the codegraph-html-report skill directory before invoking it.', { cause: error });
  }
}

function nodeLabel(node) {
  return node?.qualifiedName || node?.name || node?.id || 'unknown';
}

function addNode(nodes, node) {
  if (!node || !node.id) return false;
  if (nodes.has(node.id)) return false;
  nodes.set(node.id, node);
  return true;
}

function addEdge(edges, edge) {
  if (!edge?.source || !edge?.target) return false;
  const key = `${edge.source}|${edge.target}|${edge.kind}|${edge.line ?? ''}`;
  if (edges.some((item) => item._key === key)) return false;
  edges.push({ ...edge, _key: key });
  return true;
}

function chooseSeeds(graph, requestedSymbol) {
  const seeds = [];
  const addResults = (results) => {
    for (const result of results || []) {
      const node = result.node ?? result;
      if (node && !seeds.some((item) => item.id === node.id)) seeds.push(node);
      if (seeds.length >= 5) return;
    }
  };

  if (requestedSymbol) {
    addResults(graph.searchNodes(requestedSymbol, { limit: 10 }));
    return seeds.slice(0, 1);
  }
  if (!seeds.length) {
    for (const name of ['main', 'run', 'start', 'app', 'index']) {
      addResults(graph.searchNodes(name, { limit: 10, kinds: ['function', 'method', 'class'] }));
      if (seeds.length >= 5) break;
    }
  }
  if (!seeds.length) {
    for (const item of graph.getTopCallingFiles?.(10) || []) {
      const nodes = graph.getNodesInFile?.(item.filePath) || [];
      addResults(nodes.filter((node) => ['function', 'method', 'class'].includes(node.kind)));
      if (seeds.length >= 5) break;
    }
  }
  if (!seeds.length) addResults(graph.getNodesByKind?.('function')?.slice(0, 5) || []);
  return seeds.slice(0, 5);
}

function buildCallGraph(graph, seeds, depth) {
  const nodes = new Map();
  const edges = [];
  let truncated = false;
  const queue = seeds.map((node) => ({ node, level: 0 }));
  const visited = new Map(seeds.map((node) => [node.id, 0]));
  for (const seed of seeds) addNode(nodes, seed);

  while (queue.length) {
    const { node, level } = queue.shift();
    if (level >= depth) continue;
    let relationships = [];
    try {
      relationships = [
        ...(graph.getCallees?.(node.id, 1) || []),
        ...(graph.getCallers?.(node.id, 1) || []),
      ];
    } catch {
      truncated = true;
      continue;
    }
    for (const relationship of relationships) {
      if (edges.length >= LIMITS.callEdges) {
        truncated = true;
        break;
      }
      const target = relationship.node;
      const edge = relationship.edge;
      if (!target || !edge) continue;
      if (!nodes.has(target.id) && nodes.size >= LIMITS.callNodes) {
        truncated = true;
        continue;
      }
      addNode(nodes, target);
      addEdge(edges, edge);
      const nextLevel = level + 1;
      if (nextLevel < depth && (!visited.has(target.id) || visited.get(target.id) > nextLevel)) {
        visited.set(target.id, nextLevel);
        queue.push({ node: target, level: level + 1 });
      }
    }
  }
  return { nodes: [...nodes.values()], edges, truncated };
}

function collectFiles(graph, root) {
  const fileNodes = graph.getNodesByKind?.('file') || [];
  const paths = fileNodes.map((node) => relativePath(root, node.filePath || node.name)).filter(Boolean);
  const directories = new Map();
  for (const filePath of paths) {
    const top = filePath.split(path.sep)[0] || '.';
    directories.set(top, (directories.get(top) || 0) + 1);
  }
  return { fileNodes, paths, directories };
}

function moduleName(filePath) {
  const parts = String(filePath).split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[0] : '(root)';
}

function collectModuleDependencies(graph, root) {
  const counts = new Map();
  try {
    for (const pair of graph.getFileDependencyPairs?.() || []) {
      const fromFile = relativePath(root, pair.source);
      const toFile = relativePath(root, pair.target);
      const from = moduleName(fromFile);
      const to = moduleName(toFile);
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      const current = counts.get(key) || { from, to, files: new Set() };
      current.files.add(`${fromFile} → ${toFile}`);
      counts.set(key, current);
    }
  } catch {
    // Keep directory counts when this CodeGraph version has no dependency-pair query.
  }
  return [...counts.values()]
    .map(({ from, to, files }) => ({ from, to, count: files.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
}

async function buildSnapshot(graph, root, options) {
  const stats = graph.getStats();
  const seeds = chooseSeeds(graph, options.symbol);
  const callGraph = options.scope === 'overview'
    ? { nodes: [], edges: [], truncated: false }
    : buildCallGraph(graph, seeds, options.depth);
  const allCandidateNodes = [...new Map([...seeds, ...callGraph.nodes].map((node) => [node.id, node])).values()];
  let topDepended = [];
  try {
    topDepended = graph.getTopDependedOn?.(LIMITS.symbols) || [];
    const ids = topDepended.map((item) => item.nodeId).filter((id) => !allCandidateNodes.some((node) => node.id === id));
    const extra = graph.getNodesByIds?.(ids) || new Map();
    allCandidateNodes.push(...extra.values());
  } catch {
    // Key symbols from the call graph are still useful when this optional query is unavailable.
  }
  const uniqueCandidates = [...new Map(allCandidateNodes.map((node) => [node.id, node])).values()].slice(0, LIMITS.symbols);
  const ids = uniqueCandidates.map((node) => node.id);
  let fanIn = new Map();
  let fanOut = new Map();
  try {
    fanIn = graph.getFanIn?.(ids) || new Map();
    fanOut = graph.getFanOut?.(ids) || new Map();
  } catch {
    // Fan-in/out is enrichment; do not fail the report if an older API lacks it.
  }
  const symbols = await Promise.all(uniqueCandidates.map(async (node) => {
    let source = null;
    try {
      if (!isSensitivePath(node.filePath)) source = await graph.getCode?.(node.id);
    } catch {
      source = null;
    }
    const sourceLines = source ? redactSource(source).split('\n').slice(0, LIMITS.snippetLines).join('\n') : null;
    return {
      ...node,
      filePath: relativePath(root, node.filePath),
      fanIn: fanIn.get(node.id) || 0,
      fanOut: fanOut.get(node.id) || 0,
      source: sourceLines,
    };
  }));
  const files = collectFiles(graph, root);
  const moduleDependencies = collectModuleDependencies(graph, root);
  const warnings = [];
  const focalNode = seeds[0] || null;
  let impact = { node: null, nodes: [], edges: [] };
  if (focalNode && options.scope !== 'overview') {
    try {
      const subgraph = graph.getImpactRadius(focalNode.id, options.depth);
      impact = {
        node: focalNode,
        nodes: [...(subgraph.nodes?.values?.() || [])].filter((node) => node.id !== focalNode.id).slice(0, 100),
        edges: (subgraph.edges || []).slice(0, 200),
      };
    } catch {
      warnings.push('Impact radius could not be queried for the selected symbol.');
    }
  }
  const unresolved = [];
  for (const node of uniqueCandidates.slice(0, 40)) {
    try {
      for (const ref of graph.getUnresolvedReferencesFrom?.(node.id) || []) {
        unresolved.push({ ...ref, filePath: relativePath(root, ref.filePath || node.filePath), owner: nodeLabel(node) });
        if (unresolved.length >= 80) break;
      }
    } catch {
      // An older index may not expose unresolved-reference rows.
    }
    if (unresolved.length >= 80) break;
  }
  try {
    const state = graph.getIndexState?.();
    if (state && state !== 'complete') warnings.push(`CodeGraph index state: ${state}`);
    if (graph.isIndexStale?.()) warnings.push('The CodeGraph index was built by an older extraction version.');
    const pending = graph.getPendingReferenceCount?.() || 0;
    if (pending) warnings.push(`${pending} references were still pending when the report was generated.`);
  } catch {
    warnings.push('Index completeness could not be queried from this CodeGraph version.');
  }
  if (callGraph.truncated) warnings.push(`The call graph is capped at ${LIMITS.callNodes} nodes and ${LIMITS.callEdges} edges.`);
  if (!seeds.length) warnings.push('No obvious entry symbol was found; the call graph section is limited.');
  const frameworks = graph.getDetectedFrameworks?.() || [];
  return {
    schemaVersion: 1,
    project: {
      name: path.basename(root),
      root,
      analyzedAt: new Date().toISOString(),
      codegraphVersion: '1.6.2',
      indexState: graph.getIndexState?.() || null,
      frameworks,
    },
    stats,
    directories: [...files.directories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    moduleDependencies,
    fileCount: files.paths.length || stats.fileCount,
    seeds: seeds.map((node) => node.id),
    symbols,
    impact: {
      focal: impact.node ? { ...impact.node, filePath: relativePath(root, impact.node.filePath) } : null,
      nodes: impact.nodes.map((node) => ({ ...node, filePath: relativePath(root, node.filePath) })),
      edges: impact.edges,
    },
    unresolved,
    callGraph: {
      nodes: callGraph.nodes.map((node) => ({ ...node, filePath: relativePath(root, node.filePath) })),
      edges: callGraph.edges.map(({ _key, ...edge }) => edge),
      truncated: callGraph.truncated,
    },
    warnings,
  };
}

function flowMarkdown(snapshot) {
  const nodes = snapshot.callGraph.nodes;
  const edges = snapshot.callGraph.edges.filter((edge) => edge.kind === 'calls' || !edge.kind);
  if (!nodes.length || !edges.length) return '_No bounded call edges were found for the selected scope._';
  const used = new Set();
  const ids = new Map(nodes.map((node, index) => {
    const stem = String(node.name || node.kind || 'node').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24) || 'node';
    let label = stem;
    if (used.has(label)) label = `${stem}_${index}`;
    used.add(label);
    return [node.id, label];
  }));
  const lines = ['```flow LR'];
  for (const edge of edges.slice(0, LIMITS.callEdges)) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (source && target) lines.push(`${source} -> ${target}: ${edge.line ? `line ${edge.line}` : 'calls'}`);
  }
  lines.push('```', '', '| Node | Symbol | File |', '| --- | --- | --- |');
  for (const node of nodes) {
    const id = ids.get(node.id);
    if (id) lines.push(`| ${escapeCell(id)} | ${escapeCell(nodeLabel(node))} | ${escapeCell(node.filePath)}:${node.startLine ?? '?'} |`);
  }
  return lines.join('\n');
}

function sourceBlocks(snapshot) {
  const blocks = [];
  const inline = '`';
  const fence = '```';
  for (const symbol of snapshot.symbols.slice(0, LIMITS.symbols)) {
    if (!symbol.source) continue;
    const language = languageFor(symbol.filePath);
    blocks.push(
      `### ${escapeInline(symbol.name)}\n\n${inline}${symbol.kind}${inline} · ${inline}${escapeInline(symbol.filePath)}:${lineRange(symbol)}${inline}\n\n${fence}${language} title="${escapeInline(symbol.filePath)}:${lineRange(symbol)}"\n${safeCode(symbol.source)}\n${fence}`,
    );
  }
  return blocks.join('\n\n') || '_Source snippets were not available for the selected symbols._';
}

function reportMarkdown(snapshot, options) {
  const languages = Object.entries(snapshot.stats.filesByLanguage || {}).filter(([, count]) => count).sort((a, b) => b[1] - a[1]);
  const nodeRows = snapshot.symbols.slice(0, LIMITS.symbols).map((symbol) => `| ${escapeCell(symbol.name)} | ${escapeCell(symbol.kind)} | ${escapeCell(symbol.filePath)}:${symbol.startLine ?? '?'} | ${symbol.fanIn} | ${symbol.fanOut} |`);
  const warningRows = snapshot.warnings.length ? snapshot.warnings.map((warning) => `- ${warning}`).join('\n') : '- No material indexing warnings were reported.';
  const directoryRows = snapshot.directories.length ? snapshot.directories.map(([dir, count]) => `| ${escapeCell(dir)} | ${count} |`).join('\n') : '| _(no file nodes returned)_ | 0 |';
  const moduleRows = snapshot.moduleDependencies.length
    ? snapshot.moduleDependencies.map((edge) => `| ${escapeCell(edge.from)} | ${escapeCell(edge.to)} | ${edge.count} |`).join('\n')
    : '| _(no cross-module dependency edges returned)_ | | 0 |';
  const impactRows = snapshot.impact.nodes.length
    ? snapshot.impact.nodes.slice(0, 40).map((node) => `| ${escapeCell(node.name)} | ${escapeCell(node.kind)} | ${escapeCell(node.filePath)}:${node.startLine ?? '?'} |`).join('\n')
    : '| _(no impact nodes returned)_ | | |';
  const unresolvedRows = snapshot.unresolved.length
    ? snapshot.unresolved.slice(0, 50).map((ref) => `| ${escapeCell(ref.referenceName)} | ${escapeCell(ref.referenceKind)} | ${escapeCell(ref.filePath)}:${ref.line ?? '?'} | ${escapeCell(ref.owner)} |`).join('\n')
    : '| _(no unresolved references found in selected symbols)_ | | | |';
  const subtitle = `Static CodeGraph snapshot · ${snapshot.project.analyzedAt}`;
  return `---
template: sheet
theme: auto
title: ${quoteYaml(`${snapshot.project.name} · CodeGraph architecture report`)}
subtitle: ${quoteYaml(subtitle)}
cols: 3
---
This report describes the indexed structure of **${escapeInline(snapshot.project.name)}**. It is a static analysis snapshot; a call edge is evidence from the source graph and is not a runtime execution trace.

## Overview {span=2}

| Metric | Value |
| --- | ---: |
| Files | ${snapshot.stats.fileCount ?? snapshot.fileCount} |
| Graph nodes | ${snapshot.stats.nodeCount ?? 0} |
| Graph edges | ${snapshot.stats.edgeCount ?? 0} |
| Call edges | ${snapshot.stats.edgesByKind?.calls ?? 0} |
| Import edges | ${snapshot.stats.edgesByKind?.imports ?? 0} |
| Index state | ${escapeCell(snapshot.project.indexState || 'unknown')} |
| Detected frameworks | ${escapeCell(snapshot.project.frameworks.join(', ') || 'none reported')} |

### Languages

| Language | Files |
| --- | ---: |
${languages.map(([language, count]) => `| ${escapeCell(language)} | ${count} |`).join('\n') || '| _(not reported)_ | 0 |'}

## Project structure

Top-level directories are summarized from the indexed file nodes.

| Directory | Indexed files |
| --- | ---: |
${directoryRows}

### Cross-module dependencies

Counts represent distinct file-to-file dependency pairs between top-level directories.

| From module | To module | File pairs |
| --- | --- | ---: |
${moduleRows}

## Function call graph {span=2}

Scope: ${inlineCode(options.scope)}, traversal depth: ${inlineCode(options.depth)}, focal symbol: ${inlineCode(options.symbol || 'auto-selected')}.

${flowMarkdown(snapshot)}

## Key symbols

Symbols are ranked from the selected call graph and high-dependency nodes. Fan-in is the number of distinct incoming references; fan-out is the number of distinct outgoing references when available.

| Symbol | Kind | Location | Fan-in | Fan-out |
| --- | --- | --- | ---: | ---: |
${nodeRows.join('\n') || '| _(no symbols selected)_ | | | 0 | 0 |'}

## Source excerpts {span=2}

${sourceBlocks(snapshot)}

## Impact and dependency analysis

${snapshot.impact.focal ? `Impact radius for ${inlineCode(snapshot.impact.focal.name)} (${inlineCode(snapshot.impact.focal.filePath)}:${snapshot.impact.focal.startLine ?? '?'}) at depth ${options.depth}: ${snapshot.impact.nodes.length} related symbols.` : 'No focal symbol was available for an impact-radius query.'}

| Symbol | Kind | Location |
| --- | --- | --- |
${impactRows}

These are static graph relationships; they do not prove that every affected path executes at runtime.

## Unresolved references

The following list is sampled from the key symbols above and capped at 50 rows.

| Reference | Kind | Location | Referencing symbol |
| --- | --- | --- | --- |
${unresolvedRows}

${options.supplement ? fs.readFileSync(path.resolve(options.supplement), 'utf8') : ''}

## Analysis limits

${warningRows}

- Files and directories excluded by CodeGraph configuration are not represented.
- Dynamic dispatch, reflection, generated code, and external package internals may remain unresolved.
- Source snippets are capped at ${LIMITS.snippetLines} lines per symbol; graph traversal is bounded for readability.
`;
}

function findAmBinary() {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const local = path.join(skillRoot, 'node_modules', 'answer-me-with-html', 'bin', 'am.js');
  if (fs.existsSync(local)) return { command: process.execPath, argsPrefix: [local] };
  const env = process.env.CODEGRAPH_HTML_AM;
  if (env && fs.existsSync(env)) return { command: process.execPath, argsPrefix: [env] };
  return null;
}

function renderMarkdown(draftPath, outputPath) {
  const renderer = findAmBinary();
  if (!renderer) throw new Error('answer-me-with-html is not installed. Run npm install in the codegraph-html-report skill directory.');
  const result = spawnSync(renderer.command, [...renderer.argsPrefix, 'render', draftPath, '-o', outputPath, '--no-open'], { encoding: 'utf8' });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`answer-me-with-html failed with exit code ${result.status}`);
}

function sanitizeOfflineHtml(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  // answer-me-with-html includes optional GitHub links in its colophon. Keep
  // the text but remove remote resource/link attributes from the artifact.
  html = html.replace(/\s+(?:href|src)=["']https?:\/\/[^"']*["']/gi, '');
  fs.writeFileSync(filePath, html, 'utf8');
  if (/(?:src|href)=["']https?:\/\//i.test(html)) {
    throw new Error('Generated HTML still contains an external resource reference.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = ensureProject(args.project);
  const output = path.resolve(args.output || path.join(root, '.codewiki', 'reports', `codegraph-report-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.html`));
  const draft = path.resolve(args.draft || path.join(root, '.codewiki', 'tmp', `codegraph-report-${process.pid}.md`));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  const CodeGraph = await loadCodeGraph();
  let graph;
  let rendered;
  try {
    graph = CodeGraph.isInitialized(root)
      ? await CodeGraph.open(root, { sync: true })
      : await CodeGraph.init(root, { index: true, onProgress: progressPrinter });
    const snapshot = await buildSnapshot(graph, root, args);
    fs.writeFileSync(draft, reportMarkdown(snapshot, args), 'utf8');
    rendered = `${output}.tmp-${process.pid}`;
    fs.rmSync(rendered, { force: true });
    renderMarkdown(draft, rendered);
    if (!fs.existsSync(rendered) || fs.statSync(rendered).size === 0) throw new Error('Renderer produced an empty HTML file.');
    sanitizeOfflineHtml(rendered);
    const html = fs.readFileSync(rendered, 'utf8');
    if (!/<title>[^<]+<\/title>/i.test(html) || !html.includes('CodeGraph architecture report')) {
      throw new Error('Generated HTML is missing the expected report title.');
    }
    fs.renameSync(rendered, output);
    console.log(JSON.stringify({ output, project: snapshot.project.name, stats: snapshot.stats, warnings: snapshot.warnings }, null, 2));
  } finally {
    try { graph?.close(); } catch { /* best effort */ }
    if (!args.draft) fs.rmSync(draft, { force: true });
    if (rendered) fs.rmSync(rendered, { force: true });
  }
}

main().catch((error) => {
  console.error(`codegraph-html-report: ${error.message}`);
  process.exitCode = 1;
});

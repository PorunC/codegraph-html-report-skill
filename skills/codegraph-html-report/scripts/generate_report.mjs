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
  architectureModules: 8,
  architectureEdges: 14,
  entryCandidates: 18,
  paths: 3,
  pathNodes: 10,
  pathEdges: 14,
  evidenceSymbols: 12,
  snippetLines: 20,
  unresolved: 12,
};

const CODE_KINDS = new Set(['function', 'method', 'class', 'route', 'component']);
const ARCHITECTURE_EDGE_KINDS = ['calls', 'imports', 'exports', 'extends', 'implements', 'instantiates', 'navigates'];
const PATH_EDGE_KINDS = new Set(['calls']);
const NOISE_SEGMENTS = new Set([
  'node_modules', 'vendor', 'third_party', 'dist', 'build', 'coverage', 'fixtures', 'fixture',
  'generated', 'gen', 'mocks', 'mock', '__mocks__', 'docs', 'examples', 'example', 'test', 'tests',
  '__tests__', 'spec', 'specs', '.git', '.codegraph', '.codewiki',
]);
const NOISE_REFERENCES = new Set(['Array', 'Boolean', 'Date', 'Error', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'RegExp', 'Set', 'String', 'console']);

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
  if (isCodeNode(node)) return sourceFunctionName(node);
  return node?.name || node?.qualifiedName || 'unknown';
}

function normalizeFilePath(filePath) {
  return String(filePath ?? '').replaceAll('\\', '/');
}

function pathParts(filePath) {
  return normalizeFilePath(filePath).split('/').filter(Boolean);
}

function isNoisePath(filePath) {
  return pathParts(filePath).some((part) => NOISE_SEGMENTS.has(part.toLowerCase()) || /\.(?:generated|gen)\./i.test(part));
}

function isCodeNode(node) {
  return Boolean(node?.id && CODE_KINDS.has(node.kind));
}

function sourceFunctionName(node) {
  const sourceName = String(node?.name || '').trim();
  if (sourceName && !/^(?:function|method):/i.test(sourceName)) return sourceName;
  const signatureName = String(node?.signature || '').match(/(?:function\s+|fn\s+)?([A-Za-z_$][\w$]*)\s*\(/)?.[1];
  if (signatureName) return signatureName;
  const qualifiedTail = String(node?.qualifiedName || '').split(/::|\.|#/).pop().trim();
  if (qualifiedTail && !/^(?:function|method):/i.test(qualifiedTail) && !/^[a-f0-9]{16,}$/i.test(qualifiedTail)) return qualifiedTail;
  return node?.kind === 'method' ? 'unnamed method' : 'unnamed function';
}

function entryReasonLabel(reason) {
  const labels = {
    'explicit symbol': 'requested symbol',
    'explicit symbol search': 'requested symbol search',
    'executable file root': 'top-level executable file',
    'exported symbol': 'exported entry',
    'indexed route': 'route entry',
    'indexed component': 'component entry',
    'conventional entry name': 'conventional entry name',
    'fallback symbol search': 'name-search fallback',
    'no incoming call edge': 'no indexed callers',
    'has downstream calls': 'calls indexed functions',
  };
  return labels[reason] || reason;
}

function relationLabel(kinds) {
  const labels = {
    calls: 'calls',
    imports: 'depends on',
    exports: 'exports',
    extends: 'extends',
    implements: 'implements',
    instantiates: 'creates',
    navigates: 'routes to',
  };
  const values = [...new Set((kinds || []).filter(Boolean).map((kind) => labels[kind] || kind))];
  return values.join(' + ') || 'related modules';
}

function nodeLocation(root, node) {
  return `${relativePath(root, node?.filePath)}:${node?.startLine ?? '?'}`;
}

function nodeModule(root, node) {
  return moduleName(relativePath(root, node?.filePath));
}

function addCandidate(candidates, node, reason, score = 0) {
  if (!isCodeNode(node) || isNoisePath(node.filePath)) return;
  const current = candidates.get(node.id);
  if (!current) candidates.set(node.id, { node, reasons: [reason], baseScore: score });
  else {
    if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
    current.baseScore = Math.max(current.baseScore, score);
  }
}

function resolveRequestedCandidates(graph, requestedSymbol) {
  const candidates = new Map();
  const exact = [
    ...(graph.getNodesByQualifiedName?.(requestedSymbol) || []),
    ...(graph.getNodesByName?.(requestedSymbol) || []),
  ];
  for (const node of exact) addCandidate(candidates, node, 'explicit symbol', 1000);
  if (!candidates.size) {
    for (const result of graph.searchNodes(requestedSymbol, { limit: LIMITS.entryCandidates }) || []) {
      addCandidate(candidates, result.node ?? result, 'explicit symbol search', 900);
    }
  }
  return [...candidates.values()];
}

function discoverEntryCandidates(graph) {
  const candidates = new Map();
  for (const item of graph.getTopCallingFiles?.(12) || []) {
    const fileScore = 30 + (item.score || 0) + (item.reaches || 0) * 2 + (item.calls || 0);
    for (const node of graph.getNodesInFile?.(item.filePath) || []) {
      if (!isCodeNode(node)) continue;
      let score = fileScore;
      if (node.kind === 'route' || node.kind === 'component') score += 12;
      if (node.isExported) score += 5;
      if (/^(main|run|start|serve|cli|execute|handle|process|bootstrap|init)$/i.test(sourceFunctionName(node))) score += 4;
      addCandidate(candidates, node, 'executable file root', score);
    }
  }
  for (const kind of ['route', 'component']) {
    for (const node of graph.getNodesByKind?.(kind) || []) addCandidate(candidates, node, `indexed ${kind}`, 20);
  }
  for (const node of graph.getNodesByKind?.('function') || []) {
    if (node.isExported || /^(main|run|start|serve|cli|execute|handle|process|bootstrap|init)$/i.test(sourceFunctionName(node))) {
      addCandidate(candidates, node, node.isExported ? 'exported symbol' : 'conventional entry name', node.isExported ? 14 : 10);
    }
  }
  if (!candidates.size) {
    for (const name of ['main', 'run', 'start', 'app', 'index']) {
      for (const result of graph.searchNodes(name, { limit: 8, kinds: ['function', 'method', 'class'] }) || []) {
        addCandidate(candidates, result.node ?? result, 'fallback symbol search', 5);
      }
    }
  }
  return [...candidates.values()];
}

function rankEntryCandidates(graph, root, candidates) {
  const ids = candidates.map((item) => item.node.id);
  let fanIn = new Map();
  let fanOut = new Map();
  const callIn = new Map(ids.map((id) => [id, 0]));
  const callOut = new Map(ids.map((id) => [id, 0]));
  try {
    fanIn = graph.getFanIn?.(ids) || new Map();
    fanOut = graph.getFanOut?.(ids) || new Map();
  } catch {
    // Fan-in/out is an optional ranking signal.
  }
  try {
    for (const edge of graph.getIncomingEdgesTo?.(ids, ['calls']) || []) {
      callIn.set(edge.target, (callIn.get(edge.target) || 0) + 1);
    }
    for (const edge of graph.getOutgoingEdgesFrom?.(ids, ['calls']) || []) {
      callOut.set(edge.source, (callOut.get(edge.source) || 0) + 1);
    }
  } catch {
    // Call direction is an optional ranking signal.
  }
  return candidates.map((item) => {
    const node = item.node;
    const callers = callIn.get(node.id) || 0;
    const callees = callOut.get(node.id) || 0;
    const score = item.baseScore
      + Math.min(callees, 8) * 1.5
      + (callers === 0 ? 6 : 0)
      - Math.min(callers, 8) * 1.5
      + (node.isExported ? 2 : 0);
    return {
      ...item,
      score,
      fanIn: fanIn.get(node.id) || 0,
      fanOut: fanOut.get(node.id) || 0,
      callers,
      callees,
      reasons: [
        ...item.reasons,
        ...(callers === 0 ? ['no incoming call edge'] : []),
        ...(callees > 0 ? ['has downstream calls'] : []),
      ],
      module: nodeModule(root, node),
    };
  }).sort((a, b) => b.score - a.score);
}

function selectEntryCandidates(graph, root, requestedSymbol) {
  const explicit = requestedSymbol ? resolveRequestedCandidates(graph, requestedSymbol) : [];
  let ranked = rankEntryCandidates(graph, root, explicit.length ? explicit : discoverEntryCandidates(graph));
  if (!explicit.length) {
    const hasDownstream = ranked.some((item) => item.callees > 0 || item.node.kind === 'route' || item.node.kind === 'component');
    if (hasDownstream) ranked = ranked.filter((item) => item.callees > 0 || item.node.kind === 'route' || item.node.kind === 'component');
  }
  const selected = [];
  const seenFiles = new Set();
  const topScore = ranked[0]?.score ?? 0;
  for (const item of ranked) {
    const file = normalizeFilePath(item.node.filePath);
    if (selected.length && !explicit.length && seenFiles.has(file)) continue;
    if (selected.length && !explicit.length && topScore > 0 && item.score < topScore * 0.45) break;
    selected.push(item);
    seenFiles.add(file);
    if (selected.length >= LIMITS.paths) break;
  }
  if (!explicit.length && selected.length > 1) {
    const independent = [];
    for (const item of selected) {
      const nested = independent.some((parent) => {
        try {
          const path = graph.findPath?.(parent.node.id, item.node.id, ['calls']);
          return Array.isArray(path) && path.length > 1;
        } catch {
          return false;
        }
      });
      if (!nested) independent.push(item);
    }
    return { selected: independent, ambiguous: false };
  }
  return { selected, ambiguous: explicit.length > 1 };
}

function relationshipScore(relationship, source, target, root, fanOut) {
  const edge = relationship.edge || {};
  if (!PATH_EDGE_KINDS.has(edge.kind)) return -1000;
  if (!isCodeNode(target) || isNoisePath(target.filePath)) return -1000;
  let score = 10;
  if (edge.provenance === 'tree-sitter' || edge.provenance === 'scip') score += 3;
  if (target.isExported) score += 2;
  if (target.kind === 'route' || target.kind === 'component') score += 3;
  if (nodeModule(root, source) !== nodeModule(root, target)) score += 4;
  score += Math.min(fanOut.get(target.id) || 0, 8) * 0.35;
  if (/^(get|set|is|has|to|from|format|parse|log|debug|validate|normalize)$/i.test(sourceFunctionName(target))) score -= 2;
  return score;
}

function buildKeyPath(graph, root, entry, depth) {
  const nodes = new Map([[entry.node.id, entry.node]]);
  const edges = [];
  const queue = [{ node: entry.node, level: 0 }];
  const visited = new Set([entry.node.id]);
  let truncated = false;
  const fanOutCache = new Map();
  while (queue.length) {
    const { node, level } = queue.shift();
    if (level >= depth) continue;
    let relationships = [];
    try { relationships = graph.getCallees?.(node.id, 1) || []; } catch { truncated = true; continue; }
    const targetIds = relationships.map((relationship) => relationship?.node?.id).filter(Boolean);
    let fanOut = new Map();
    try { fanOut = graph.getFanOut?.(targetIds) || new Map(); } catch { /* optional */ }
    for (const [id, value] of fanOut) fanOutCache.set(id, value);
    const ranked = relationships
      .filter((relationship) => relationship?.node && relationship?.edge)
      .map((relationship) => ({ ...relationship, score: relationshipScore(relationship, node, relationship.node, root, fanOutCache) }))
      .filter((relationship) => relationship.score > -100)
      .sort((a, b) => b.score - a.score);
    if (ranked.length > 2) truncated = true;
    for (const relationship of ranked.slice(0, 2)) {
      if (edges.length >= 14 || nodes.size >= 10) { truncated = true; break; }
      const target = relationship.node;
      if (visited.has(target.id)) continue;
      visited.add(target.id);
      nodes.set(target.id, target);
      edges.push(relationship.edge);
      if (level + 1 < depth) queue.push({ node: target, level: level + 1 });
    }
  }
  return { entry: entry.node, nodes: [...nodes.values()], edges, truncated };
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
  if (parts.length <= 1) return '(root)';
  const first = parts[0].toLowerCase();
  if (['src', 'app', 'lib', 'libs', 'packages', 'apps', 'services', 'modules'].includes(first) && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (['src', 'app', 'lib', 'libs', 'packages', 'apps', 'services', 'modules'].includes(first)) return parts[0];
  return parts[0];
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

function moduleAssignments(graph, root) {
  return (graph.getNodesByKind?.('file') || [])
    .map((node) => ({ filePath: node.filePath, module: moduleName(relativePath(root, node.filePath)) }))
    .filter((assignment) => assignment.filePath && assignment.module);
}

function collectArchitecture(graph, root) {
  const assignments = moduleAssignments(graph, root);
  const modules = new Map(assignments.map((item) => [item.module, { name: item.module, files: 0 }]));
  for (const assignment of assignments) modules.get(assignment.module).files += 1;
  let links = [];
  let pairs = [];
  let fallback = false;
  let aggregationAvailable = false;
  try {
    const aggregation = graph.getModuleAggregation?.(assignments, {
      kinds: ARCHITECTURE_EDGE_KINDS,
      minConfidence: 0.75,
      topPairsPerLink: 2,
      pairKinds: ['calls', 'imports'],
    });
    aggregationAvailable = Boolean(aggregation);
    links = aggregation?.links || [];
    pairs = aggregation?.pairs || [];
  } catch {
    // Older CodeGraph versions can still use the file-pair fallback below.
  }
  if (!aggregationAvailable) {
    fallback = true;
    links = collectModuleDependencies(graph, root).map((edge) => ({
      source: edge.from,
      target: edge.to,
      kind: 'imports',
      count: edge.count,
      declared: edge.count,
      uncertain: 0,
    }));
  }
  const mergedLinks = new Map();
  for (const link of links) {
    if (!link.source || !link.target || link.source === link.target) continue;
    const key = `${link.source}\u0000${link.target}`;
    const current = mergedLinks.get(key);
    if (!current) mergedLinks.set(key, { ...link, kinds: [link.kind] });
    else {
      if (link.kind && !current.kinds.includes(link.kind)) current.kinds.push(link.kind);
      current.count = Math.max(current.count || 0, link.count || 0);
      current.declared = Math.max(current.declared || 0, link.declared || 0);
      current.uncertain = Math.max(current.uncertain || 0, link.uncertain || 0);
    }
  }
  const rankedLinks = [...mergedLinks.values()]
    .filter((link) => link.source && link.target && link.source !== link.target)
    .sort((a, b) => (b.declared - a.declared) || (b.count - a.count))
    .slice(0, LIMITS.architectureEdges);
  const activeModules = new Set(rankedLinks.flatMap((link) => [link.source, link.target]));
  const rankedModules = [...modules.values()]
    .filter((module) => activeModules.has(module.name))
    .sort((a, b) => b.files - a.files)
    .slice(0, LIMITS.architectureModules);
  const visibleModules = new Set(rankedModules.map((module) => module.name));
  const pairKey = (pair) => `${pair.from}|${pair.to}`;
  const pairMap = new Map(pairs.map((pair) => [pairKey(pair), pair]));
  return {
    modules: rankedModules,
    links: rankedLinks.filter((link) => visibleModules.has(link.source) && visibleModules.has(link.target)),
    pairs: rankedLinks.flatMap((link) => {
      const pair = pairMap.get(`${link.source}|${link.target}`);
      return pair && visibleModules.has(link.source) && visibleModules.has(link.target) ? [pair] : [];
    }).slice(0, LIMITS.architectureEdges),
    fallback,
  };
}

function serializeNode(root, node) {
  return {
    ...node,
    filePath: relativePath(root, node.filePath),
    shortName: sourceFunctionName(node),
    location: nodeLocation(root, node),
    module: nodeModule(root, node),
  };
}

function serializePath(root, pathGraph) {
  return {
    entry: serializeNode(root, pathGraph.entry),
    nodes: pathGraph.nodes.map((node) => serializeNode(root, node)),
    edges: pathGraph.edges,
    truncated: pathGraph.truncated,
  };
}

async function loadSymbolEvidence(graph, root, nodes) {
  const unique = [...new Map(nodes.filter(isCodeNode).map((node) => [node.id, node])).values()]
    .slice(0, LIMITS.evidenceSymbols);
  const ids = unique.map((node) => node.id);
  let fanIn = new Map();
  let fanOut = new Map();
  try {
    fanIn = graph.getFanIn?.(ids) || new Map();
    fanOut = graph.getFanOut?.(ids) || new Map();
  } catch {
    // Fan-in/out is optional evidence.
  }
  return Promise.all(unique.map(async (node) => {
    let source = null;
    try {
      if (!isSensitivePath(node.filePath)) source = await graph.getCode?.(node.id);
    } catch {
      source = null;
    }
    return {
      ...serializeNode(root, node),
      fanIn: fanIn.get(node.id) || 0,
      fanOut: fanOut.get(node.id) || 0,
      source: source ? redactSource(source).split('\n').slice(0, LIMITS.snippetLines).join('\n') : null,
    };
  }));
}

async function buildSnapshot(graph, root, options) {
  const stats = graph.getStats();
  const files = collectFiles(graph, root);
  const architecture = collectArchitecture(graph, root);
  const entrySelection = selectEntryCandidates(graph, root, options.symbol);
  const pathGraphs = options.scope === 'overview'
    ? []
    : entrySelection.selected.map((entry) => buildKeyPath(graph, root, entry, options.depth));
  const pathNodes = pathGraphs.flatMap((pathGraph) => pathGraph.nodes);
  const symbols = await loadSymbolEvidence(graph, root, pathNodes);
  const warnings = [];
  const state = graph.getIndexState?.();
  if (state && state !== 'complete') warnings.push(`CodeGraph index state: ${state}`);
  if (graph.isIndexStale?.()) warnings.push('The CodeGraph index was built by an older extraction version.');
  const pending = graph.getPendingReferenceCount?.() || 0;
  if (pending) warnings.push(`${pending} references were still pending when the report was generated.`);
  if (entrySelection.ambiguous) warnings.push('The requested symbol matched multiple definitions; each selected definition has its own path.');
  if (!entrySelection.selected.length && options.scope !== 'overview') warnings.push('No high-confidence entry symbol was found; the report has no key call path.');
  if (pathGraphs.some((pathGraph) => pathGraph.truncated)) warnings.push('Some secondary callees were folded out of the key paths to keep the diagrams readable.');
  if (architecture.fallback) warnings.push('Module architecture uses a file-dependency fallback because this CodeGraph version has no module aggregation result.');

  const unresolved = [];
  const unresolvedKeys = new Set();
  for (const node of pathNodes) {
    try {
      for (const ref of graph.getUnresolvedReferencesFrom?.(node.id) || []) {
        if (NOISE_REFERENCES.has(String(ref.referenceName || ''))) continue;
        const filePath = relativePath(root, ref.filePath || node.filePath);
        const item = { ...ref, filePath, owner: nodeLabel(node) };
        const key = `${item.referenceName}|${item.referenceKind}|${filePath}|${item.line ?? ''}|${item.owner}`;
        if (!unresolvedKeys.has(key)) {
          unresolvedKeys.add(key);
          unresolved.push(item);
        }
        if (unresolved.length >= LIMITS.unresolved) break;
      }
    } catch {
      // An older index may not expose unresolved-reference rows.
    }
    if (unresolved.length >= LIMITS.unresolved) break;
  }

  let impact = { focal: null, nodes: [] };
  const focal = entrySelection.selected[0]?.node;
  if (focal && options.scope !== 'overview') {
    try {
      const subgraph = graph.getImpactRadius(focal.id, options.depth);
      impact = {
        focal: serializeNode(root, focal),
        nodes: [...(subgraph.nodes?.values?.() || [])]
          .filter((node) => node.id !== focal.id && isCodeNode(node) && !isNoisePath(node.filePath))
          .slice(0, 8)
          .map((node) => serializeNode(root, node)),
      };
    } catch {
      warnings.push('Impact radius could not be queried for the primary entry symbol.');
    }
  }

  return {
    schemaVersion: 2,
    project: {
      name: path.basename(root),
      root,
      analyzedAt: new Date().toISOString(),
      codegraphVersion: '1.6.2',
      indexState: state || null,
      frameworks: graph.getDetectedFrameworks?.() || [],
    },
    stats,
    directories: [...files.directories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    fileCount: stats.fileCount ?? files.paths.length,
    architecture,
    entries: entrySelection.selected.map((entry) => ({
      ...serializeNode(root, entry.node),
      score: Math.round(entry.score * 10) / 10,
      reasons: entry.reasons,
      fanIn: entry.fanIn,
      fanOut: entry.fanOut,
    })),
    paths: pathGraphs.map((pathGraph) => serializePath(root, pathGraph)),
    symbols,
    impact,
    unresolved,
    warnings,
  };
}

function displayLabels(nodes) {
  const counts = new Map();
  for (const node of nodes) counts.set(node.shortName, (counts.get(node.shortName) || 0) + 1);
  const used = new Set();
  const occurrences = new Map();
  const labels = new Map();
  for (const node of nodes) {
    const base = node.shortName || 'unknown';
    const location = `${node.filePath}:${node.startLine ?? '?'}`;
    const occurrence = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, occurrence);
    let label = counts.get(base) > 1 ? `${base} · ${location}` : base;
    if (used.has(label)) label = `${base} · ${location} (${occurrence})`;
    used.add(label);
    labels.set(node.id, label);
  }
  return labels;
}

function flowToken(label) {
  const value = String(label ?? '').trim() || 'unknown';
  if (/^[A-Za-z0-9_.$/-]+$/.test(value)) return value;
  if (!value.includes(']')) return `[${value}]`;
  if (!value.includes(')')) return `(${value})`;
  if (!value.includes('}')) return `{${value}}`;
  return `[${value.replaceAll(']', '］')}]`;
}

function architectureMarkdown(snapshot) {
  const { modules, links } = snapshot.architecture;
  if (!modules.length || !links.length) return '_No high-confidence cross-module relationships were found._';
  const lines = ['```flow LR'];
  for (const link of links) {
    if (link.source && link.target) {
      const evidence = link.declared ? ` · ${link.declared} direct links` : '';
      lines.push(`${flowToken(link.source)} -> ${flowToken(link.target)}: ${relationLabel(link.kinds || [link.kind])}${evidence}`);
    }
  }
  lines.push('```', '', '| Module | Indexed files |', '| --- | ---: |');
  for (const module of modules) lines.push(`| ${escapeCell(module.name)} | ${module.files} |`);
  lines.push('', snapshot.architecture.fallback
    ? 'Edges use the file-dependency fallback. The module aggregation API did not return a usable result.'
    : 'This diagram keeps direct module relationships supported by the index and leaves weaker matches out.');
  return lines.join('\n');
}

function pathMarkdown(pathGraph, index) {
  const nodes = pathGraph.nodes;
  const edges = pathGraph.edges.filter((edge) => edge.kind === 'calls');
  const title = `${pathGraph.entry.shortName} · ${pathGraph.entry.location}`;
  if (!edges.length) return `### Main path ${index + 1}: ${inlineCode(title)}\n\n_No resolved downstream calls were found for this entry._`;
  const labels = displayLabels(nodes);
  const lines = [`### Main path ${index + 1}: ${inlineCode(title)}`, '', '```flow LR'];
  for (const edge of edges) {
    const source = labels.get(edge.source);
    const target = labels.get(edge.target);
    if (source && target) lines.push(`${flowToken(source)} -> ${flowToken(target)}: calls${edge.line ? ` · line ${edge.line}` : ''}`);
  }
  lines.push('```', '', '| Function | Module | Location |', '| --- | --- | --- |');
  for (const node of nodes) {
    const label = labels.get(node.id);
    if (label) lines.push(`| ${escapeCell(label)} | ${escapeCell(node.module)} | ${escapeCell(node.location)} |`);
  }
  if (pathGraph.truncated) lines.push('', '_Secondary callees were folded out to keep this path readable._');
  return lines.join('\n');
}

function sourceBlocks(snapshot) {
  const blocks = [];
  const seen = new Set();
  const labels = displayLabels(snapshot.symbols);
  for (const symbol of snapshot.symbols) {
    if (!symbol.source || seen.has(symbol.id)) continue;
    seen.add(symbol.id);
    const language = languageFor(symbol.filePath);
    blocks.push(
      `### ${escapeInline(symbol.module)} · ${escapeInline(labels.get(symbol.id) || symbol.shortName)}\n\n\`${symbol.kind}\` · \`${escapeInline(symbol.location)}\`\n\n\`\`\`${language} title="${escapeInline(symbol.location)}"\n${safeCode(symbol.source)}\n\`\`\``,
    );
  }
  return blocks.join('\n\n') || '_No source excerpt was needed for the selected paths._';
}

function reportMarkdown(snapshot, options) {
  const languages = Object.entries(snapshot.stats.filesByLanguage || {}).filter(([, count]) => count).sort((a, b) => b[1] - a[1]);
  const entryRows = snapshot.entries.map((entry) => `| ${escapeCell(entry.module)} · ${escapeCell(entry.shortName)} | ${escapeCell(entry.location)} | ${escapeCell([...new Set(entry.reasons.map(entryReasonLabel))].join(', '))} |`).join('\n');
  const impactRows = snapshot.impact.nodes.length
    ? snapshot.impact.nodes.map((node) => `| ${escapeCell(node.module)} · ${escapeCell(node.shortName)} | ${escapeCell(node.location)} |`).join('\n')
    : '| _(no additional static impact nodes returned)_ | |';
  const unresolvedRows = snapshot.unresolved.length
    ? snapshot.unresolved.map((ref) => `| ${escapeCell(ref.referenceName)} | ${escapeCell(ref.filePath)}:${ref.line ?? '?'} | ${escapeCell(ref.owner)} |`).join('\n')
    : '| _(none sampled from the selected paths)_ | | |';
  const warningRows = snapshot.warnings.length ? snapshot.warnings.map((warning) => `- ${warning}`).join('\n') : '- The index is complete. No material warnings were reported.';
  const languagesText = languages.map(([language, count]) => `${language} (${count})`).join(', ') || 'not reported';
  const supplement = options.supplement ? fs.readFileSync(path.resolve(options.supplement), 'utf8') : '';
  const entrySummary = snapshot.entries.length === 1 ? '1 entry candidate' : `${snapshot.entries.length} entry candidates`;
  const pathSummary = snapshot.paths.length === 1 ? '1 focused path' : `${snapshot.paths.length} focused paths`;
  const scopeSummary = options.scope === 'overview'
    ? 'Overview scope keeps the report to project structure; call paths and source excerpts are intentionally omitted.'
    : snapshot.entries.length
      ? `The analysis selected **${entrySummary}** and **${pathSummary}**. The diagrams show static call evidence, not a runtime trace.`
      : 'No high-confidence entry was found automatically. Pass `--symbol <name>` to focus the report.';
  const unresolvedSummary = options.scope === 'overview'
    ? '- Unresolved references are not sampled in overview scope.'
    : snapshot.unresolved.length
      ? `- ${snapshot.unresolved.length} unresolved reference(s) were found in the selected paths; see the final panel.`
      : '- No unresolved references were found in the selected paths.';
  const pathSection = options.scope === 'overview' ? '' : `
## Key call paths {span=2}

Focus: ${inlineCode(options.scope)} · downstream depth: ${inlineCode(options.depth)} · each path keeps at most ${LIMITS.pathNodes} functions and ${LIMITS.pathEdges} calls.

${snapshot.paths.map((pathGraph, index) => pathMarkdown(pathGraph, index)).join('\n\n') || '_No downstream call path was resolved._'}
`;
  const sourceSection = snapshot.symbols.some((symbol) => symbol.source) ? `
## Focused source evidence

Only symbols used by the selected paths are shown. Each excerpt is limited to ${LIMITS.snippetLines} lines.

${sourceBlocks(snapshot)}
` : '';
  const impactSection = snapshot.impact.focal && snapshot.impact.nodes.length ? `
## Change impact

Changing ${inlineCode(snapshot.impact.focal.shortName)} at ${inlineCode(snapshot.impact.focal.location)} may affect these indexed symbols at depth ${options.depth}.

| Related symbol | Location |
| --- | --- |
${impactRows}
` : '';
  const unresolvedSection = snapshot.unresolved.length ? `
## Unresolved references

Only unresolved references attached to selected path symbols are shown, capped at ${LIMITS.unresolved} rows.

| Reference | Location | Referencing symbol |
| --- | --- | --- |
${unresolvedRows}
` : '';
  const entrySection = snapshot.entries.length ? `
## Entry points

| Candidate | Location | Why selected |
| --- | --- | --- |
${entryRows}
` : '';
  return `---
template: sheet
theme: auto
title: ${quoteYaml(`${snapshot.project.name} · CodeGraph architecture report`)}
subtitle: ${quoteYaml(`Focused static analysis · ${snapshot.project.analyzedAt}`)}
cols: 2
---
This report explains the most important structure found in **${escapeInline(snapshot.project.name)}**. CodeGraph supplies static relationship evidence; the report keeps only high-confidence modules, entries, and downstream paths.

## Project at a glance {span=2}

| Files | Languages | Frameworks | Index |
| ---: | --- | --- | --- |
| ${snapshot.fileCount} | ${escapeCell(languagesText)} | ${escapeCell(snapshot.project.frameworks.join(', ') || 'none reported')} | ${escapeCell(snapshot.project.indexState || 'unknown')} |

${scopeSummary}

${entrySection}

## Module architecture {span=2}

${architectureMarkdown(snapshot)}

${pathSection}

${sourceSection}

${supplement}

${impactSection}

## Reliability and limits

${warningRows}

- Dynamic dispatch, reflection, generated code, and external package internals may remain unresolved.
- Test, vendor, generated, and build paths are excluded from entry selection and path diagrams by default.
- Obvious language-runtime references such as Boolean or Promise are omitted from the unresolved-reference table.
- Module edges are aggregated evidence. A static edge does not prove that a path executes at runtime.
${unresolvedSummary}

${unresolvedSection}
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

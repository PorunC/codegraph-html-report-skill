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
  unresolved: 12,
  impactModules: 8,
  impactEdges: 14,
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
  --symbol <name>    Entry symbol used to focus analysis; report labels stay at module level
  --depth <number>   Internal call traversal depth (default: ${DEFAULT_DEPTH})
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

function relativePath(root, filePath) {
  const value = String(filePath ?? '');
  if (!value) return '';
  const absolute = path.isAbsolute(value) ? value : path.join(root, value);
  const relative = path.relative(root, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : value;
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
  for (const filePath of paths.filter((item) => !isNoisePath(item))) {
    const parts = normalizeFilePath(filePath).split('/').filter(Boolean).slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join('/');
      directories.set(directory, (directories.get(directory) || 0) + 1);
    }
  }
  const rankedDirectories = [...directories.entries()].sort((a, b) =>
    (b[1] - a[1]) || (a[0].split('/').length - b[0].split('/').length) || a[0].localeCompare(b[0]));
  const selectedDirectories = new Set();
  for (const [directory] of rankedDirectories) {
    const parts = directory.split('/');
    const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    const missing = ancestors.filter((item) => !selectedDirectories.has(item));
    if (selectedDirectories.size + missing.length > 24) continue;
    for (const ancestor of ancestors) selectedDirectories.add(ancestor);
  }
  const visibleDirectories = [...selectedDirectories]
    .map((directory) => [directory, directories.get(directory)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return {
    fileNodes,
    paths,
    directories: visibleDirectories,
    directoriesTruncated: selectedDirectories.size < directories.size,
  };
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
      if (isNoisePath(fromFile) || isNoisePath(toFile)) continue;
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
    .filter((assignment) => assignment.filePath && assignment.module && !isNoisePath(assignment.filePath));
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
  const allRankedLinks = [...mergedLinks.values()]
    .filter((link) => link.source && link.target && link.source !== link.target)
    .sort((a, b) => (b.declared - a.declared) || (b.count - a.count));
  const rankedLinks = allRankedLinks.slice(0, LIMITS.architectureEdges);
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
    truncated: allRankedLinks.length > LIMITS.architectureEdges || activeModules.size > rankedModules.length,
  };
}

function serializePath(root, pathGraph) {
  return {
    nodes: pathGraph.nodes.map((node) => ({ id: node.id, module: nodeModule(root, node) })),
    edges: pathGraph.edges,
    truncated: pathGraph.truncated,
  };
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
  const moduleFlows = pathGraphs.flatMap((pathGraph) => {
    const nodes = new Map(pathGraph.nodes.map((node) => [node.id, { id: node.id, module: nodeModule(root, node) }]));
    const links = new Map();
    for (const edge of pathGraph.edges.filter((item) => item.kind === 'calls')) {
      const source = nodes.get(edge.source)?.module;
      const target = nodes.get(edge.target)?.module;
      if (!source || !target || source === target) continue;
      const key = `${source}\u0000${target}`;
      const item = links.get(key) || { source, target, count: 0 };
      item.count += 1;
      links.set(key, item);
    }
    return links.size ? [{ links: [...links.values()], truncated: pathGraph.truncated }] : [];
  });
  const warnings = [];
  const state = graph.getIndexState?.();
  if (state && state !== 'complete') warnings.push(`CodeGraph index state: ${state}`);
  if (graph.isIndexStale?.()) warnings.push('The CodeGraph index was built by an older extraction version.');
  const pending = graph.getPendingReferenceCount?.() || 0;
  if (pending) warnings.push(`${pending} references were still pending when the report was generated.`);
  if (entrySelection.ambiguous) warnings.push('The requested symbol matched multiple definitions; each selected definition has its own path.');
  if (!entrySelection.selected.length && options.scope !== 'overview') warnings.push('No high-confidence entry symbol was found; the report has no key call path.');
  if (pathGraphs.some((pathGraph) => pathGraph.truncated)) warnings.push('Some secondary call relationships were folded out of the module flows to keep them readable.');
  if (architecture.truncated) warnings.push('Some lower-ranked modules or relationships were folded out of the architecture diagram.');
  if (architecture.fallback) warnings.push('Module architecture uses a file-dependency fallback because this CodeGraph version has no module aggregation result.');

  const unresolved = [];
  let unresolvedCapped = false;
  const unresolvedKeys = new Set();
  for (const node of pathNodes) {
    try {
      for (const ref of graph.getUnresolvedReferencesFrom?.(node.id) || []) {
        if (NOISE_REFERENCES.has(String(ref.referenceName || ''))) continue;
        const item = {
          module: nodeModule(root, node),
          referenceName: String(ref.referenceName || 'unknown reference'),
        };
        const key = `${item.module}|${item.referenceName}`;
        if (!unresolvedKeys.has(key) && unresolvedKeys.size >= LIMITS.unresolved) {
          unresolvedCapped = true;
          break;
        }
        if (!unresolvedKeys.has(key)) {
          unresolvedKeys.add(key);
          const current = unresolved.find((entry) => entry.module === item.module);
          if (current) current.count += 1;
          else unresolved.push({ module: item.module, count: 1 });
        }
      }
    } catch {
      // An older index may not expose unresolved-reference rows.
    }
    if (unresolvedCapped) break;
  }

  let impact = { focalModule: null, modules: [], edges: [], truncated: false };
  const focal = entrySelection.selected[0]?.node;
  if (focal && options.scope !== 'overview') {
    try {
      const subgraph = graph.getImpactRadius(focal.id, options.depth);
      const impactedNodes = [...(subgraph.nodes?.values?.() || [])]
        .filter((node) => node.id !== focal.id && isCodeNode(node) && !isNoisePath(node.filePath));
      const countsByModule = new Map();
      for (const node of impactedNodes) {
        const module = nodeModule(root, node);
        if (module !== nodeModule(root, focal)) countsByModule.set(module, (countsByModule.get(module) || 0) + 1);
      }
      const selectedModules = new Set([...countsByModule]
        .sort((a, b) => b[1] - a[1])
        .slice(0, LIMITS.impactModules)
        .map(([module]) => module));
      const moduleById = new Map([[focal.id, nodeModule(root, focal)]]);
      for (const node of impactedNodes) moduleById.set(node.id, nodeModule(root, node));
      const impactLinks = new Map();
      for (const edge of subgraph.edges || []) {
        if (!['calls', 'imports'].includes(edge.kind)) continue;
        const source = moduleById.get(edge.source);
        const target = moduleById.get(edge.target);
        if (!source || !target || source === target || (source !== nodeModule(root, focal) && !selectedModules.has(source)) || (target !== nodeModule(root, focal) && !selectedModules.has(target))) continue;
        const kind = edge.kind === 'imports' ? 'depends on' : 'calls';
        const key = `${source}\u0000${target}\u0000${kind}`;
        const current = impactLinks.get(key) || { source, target, kind, count: 0 };
        current.count += 1;
        impactLinks.set(key, current);
      }
      if (!impactLinks.size) {
        for (const module of selectedModules) {
          impactLinks.set(`${nodeModule(root, focal)}\u0000${module}`, {
            source: nodeModule(root, focal), target: module, kind: 'may affect', count: 1,
          });
        }
      }
      impact = {
        focalModule: nodeModule(root, focal),
        modules: [...selectedModules],
        depth: options.depth,
        edges: [...impactLinks.values()].slice(0, LIMITS.impactEdges),
        truncated: countsByModule.size > LIMITS.impactModules || impactLinks.size > LIMITS.impactEdges,
      };
    } catch {
      warnings.push('Impact radius could not be queried for the primary entry symbol.');
    }
  }
  if (impact.truncated) warnings.push('Some lower-ranked modules or relationships were folded out of the impact diagram.');

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
    directories: files.directories,
    directoriesTruncated: files.directoriesTruncated,
    fileCount: stats.fileCount ?? files.paths.length,
    architecture,
    entries: entrySelection.selected.map((entry) => ({ module: nodeModule(root, entry.node) })),
    paths: pathGraphs.map((pathGraph) => serializePath(root, pathGraph)),
    moduleFlows,
    impact,
    unresolved,
    unresolvedCapped,
    warnings,
  };
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
  lines.push('```', '', `The diagram keeps ${modules.length} high-confidence modules and ${links.length} relationships.`);
  lines.push(snapshot.architecture.fallback
    ? 'Edges use the file-dependency fallback. The module aggregation API did not return a usable result.'
    : 'This diagram keeps direct module relationships supported by the index and leaves weaker matches out.');
  if (snapshot.architecture.truncated) lines.push('Some lower-ranked modules or links are omitted.');
  return lines.join('\n');
}

function projectAreasMarkdown(snapshot) {
  if (!snapshot.directories.length) return '';
  const lines = ['## Project areas {span=2}', '', '```tree list', `${snapshot.project.name} | indexed source areas`];
  for (const [directory, count] of snapshot.directories) {
    const depth = directory.split('/').length;
    const name = directory.split('/').at(-1);
    lines.push(`${'  '.repeat(depth)}${name}/ | ${count} indexed file${count === 1 ? '' : 's'}`);
  }
  lines.push('```', '', 'This hierarchy groups files by directory; it does not enumerate individual files.');
  if (snapshot.directoriesTruncated) lines.push('Some lower-ranked folders are omitted from this view.');
  return lines.join('\n');
}

function entrySurfacesMarkdown(snapshot) {
  if (!snapshot.entries.length) return '';
  const modules = new Map();
  for (const entry of snapshot.entries) modules.set(entry.module, (modules.get(entry.module) || 0) + 1);
  const lines = [
    '## Entry areas {span=2}',
    '',
    'Selected starting points are grouped by module; no individual symbols are listed.',
    '',
    '```flow LR',
  ];
  for (const [module, count] of modules) {
    lines.push(`${flowToken('selected starts')} -> ${flowToken(module)}: ${count} selected start${count === 1 ? '' : 's'}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function moduleFlowMarkdown(snapshot, options) {
  const paths = snapshot.moduleFlows;
  if (!paths.length) return '';
  const lines = [
    '## Selected module flows {span=2}',
    '',
    `Scope: ${options.scope} · downstream depth: ${options.depth} · each flow keeps at most ${LIMITS.pathNodes} internal nodes and ${LIMITS.pathEdges} calls before grouping by module. Only calls crossing module boundaries are drawn.`,
  ];
  paths.forEach(({ links, truncated }, index) => {
    lines.push('', `### Module flow ${index + 1}`, '', '```flow LR');
    for (const link of links) lines.push(`${flowToken(link.source)} -> ${flowToken(link.target)}: calls${link.count > 1 ? ` · ${link.count} links` : ''}`);
    lines.push('```');
    if (truncated) lines.push('', '_Some secondary call relationships were folded out._');
  });
  return lines.join('\n');
}

function impactMarkdown(snapshot) {
  const { focalModule, modules, edges, depth, truncated } = snapshot.impact;
  if (!focalModule || !modules.length || !edges.length) return '';
  const lines = [
    '## Static impact by module {span=2}',
    '',
    `The selected area has indexed relationships to up to ${modules.length} other project area${modules.length === 1 ? '' : 's'} within depth ${depth}.`,
    '',
    '```flow LR',
  ];
  for (const edge of edges) {
    const source = edge.source === focalModule ? `selected · ${focalModule}` : edge.source;
    if (source && edge.target) lines.push(`${flowToken(source)} -> ${flowToken(edge.target)}: ${edge.kind}${edge.count > 1 ? ` · ${edge.count} links` : ''}`);
  }
  lines.push('```');
  if (truncated) lines.push('', '_Some lower-ranked modules or relationships were folded out._');
  return lines.join('\n');
}

function unresolvedMarkdown(snapshot) {
  if (!snapshot.unresolved.length) return '';
  const lines = [
    '## Unresolved boundaries {span=2}',
    '',
    `The selected paths have ${snapshot.unresolved.reduce((sum, item) => sum + item.count, 0)} unresolved references across ${snapshot.unresolved.length} project area${snapshot.unresolved.length === 1 ? '' : 's'}. Individual names and source locations are omitted.`,
    '',
    '```flow LR',
  ];
  for (const ref of snapshot.unresolved) {
    lines.push(`${flowToken(ref.module)} -> ${flowToken('unresolved references')}: ${ref.count} unresolved reference${ref.count === 1 ? '' : 's'}`);
  }
  lines.push('```');
  if (snapshot.unresolvedCapped) lines.push('', `_Only the first ${LIMITS.unresolved} unresolved references are shown._`);
  return lines.join('\n');
}

function reportMarkdown(snapshot, options) {
  const languages = Object.entries(snapshot.stats.filesByLanguage || {}).filter(([, count]) => count).sort((a, b) => b[1] - a[1]);
  const warningRows = snapshot.warnings.length ? snapshot.warnings.map((warning) => `- ${warning}`).join('\n') : '- The index is complete. No material warnings were reported.';
  const languagesText = languages.map(([language, count]) => `${language} (${count})`).join(', ') || 'not reported';
  const supplement = options.supplement ? fs.readFileSync(path.resolve(options.supplement), 'utf8') : '';
  const scopeSummary = options.scope === 'overview'
    ? 'Overview scope keeps the report to project structure; call paths and boundary diagrams are intentionally omitted.'
    : snapshot.entries.length
      ? `Selected **${snapshot.entries.length} starting area${snapshot.entries.length === 1 ? '' : 's'}** and found **${snapshot.moduleFlows.length} cross-module flow${snapshot.moduleFlows.length === 1 ? '' : 's'}**. Read the diagrams from left to right; they show static relationships, not a runtime trace.`
      : 'No clear starting area was found automatically. Pass `--symbol <name>` to focus the report.';
  const unresolvedSummary = options.scope === 'overview'
    ? '- Unresolved references are not sampled in overview scope.'
    : snapshot.unresolved.length
      ? `- ${snapshot.unresolved.reduce((sum, item) => sum + item.count, 0)} unresolved reference(s) are grouped in the unresolved-boundary diagram.`
      : '- No unresolved references were found in the selected paths.';
  const areasSection = projectAreasMarkdown(snapshot);
  const entrySection = entrySurfacesMarkdown(snapshot);
  const moduleFlowSection = options.scope === 'overview' ? '' : moduleFlowMarkdown(snapshot, options);
  const impactSection = options.scope === 'overview' ? '' : impactMarkdown(snapshot);
  const unresolvedSection = options.scope === 'overview' ? '' : unresolvedMarkdown(snapshot);
  return `---
template: sheet
theme: auto
title: ${quoteYaml(`${snapshot.project.name} · CodeGraph architecture report`)}
subtitle: ${quoteYaml(`Diagram-first static analysis · ${snapshot.project.analyzedAt}`)}
cols: 2
---
This report is a diagram-first view of **${escapeInline(snapshot.project.name)}**. CodeGraph supplies static relationship evidence; the report keeps project areas, module links, cross-module flows, impact, and unresolved boundaries at architecture level.

## Project at a glance {span=2}

| Files | Languages | Frameworks | Index |
| ---: | --- | --- | --- |
| ${snapshot.fileCount} | ${escapeCell(languagesText)} | ${escapeCell(snapshot.project.frameworks.join(', ') || 'none reported')} | ${escapeCell(snapshot.project.indexState || 'unknown')} |

${scopeSummary}

${areasSection}

${entrySection}

## Module architecture {span=2}

${architectureMarkdown(snapshot)}

${moduleFlowSection}

${supplement}

${impactSection}

${unresolvedSection}

## Reliability and limits

${warningRows}

- Dynamic dispatch, reflection, generated code, and external package internals may remain unresolved.
- Test, fixture, documentation, vendor, generated, mock, and build paths are excluded from entry selection and project-area diagrams by default.
- Obvious language-runtime references such as Boolean or Promise are omitted from the unresolved-boundary diagram.
- Module edges are aggregated evidence. A static edge does not prove that a path executes at runtime.
${unresolvedSummary}
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

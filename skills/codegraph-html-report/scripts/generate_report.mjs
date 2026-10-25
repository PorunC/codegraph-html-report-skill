#!/usr/bin/env node

/**
 * Build a bounded multi-page Markdown architecture report with CodeGraph and
 * render it to offline HTML pages with the local answer-me-with-html CLI.
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
  --output <path>    Report directory or overview HTML path (default: .codewiki/reports/.../)
  --symbol <name>    Entry symbol used to focus key call-flow analysis
  --depth <number>   Internal call traversal depth (default: ${DEFAULT_DEPTH})
  --scope <mode>     overview | full | symbol (default: full)
  --supplement <md>  Add architecture notes written from project source review
  --draft <path>     Keep page drafts in this directory (or beside this .md path)
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
  return node?.kind === 'method' ? '未命名方法' : '未命名函数';
}

function relationLabel(kinds) {
  const labels = {
    calls: '调用',
    imports: '依赖',
    exports: '导出',
    extends: '继承',
    implements: '实现',
    instantiates: '创建',
    navigates: '路由到',
  };
  const values = [...new Set((kinds || []).filter(Boolean).map((kind) => labels[kind] || kind))];
  return values.join(' + ') || '相关模块';
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

function serializeCodeNode(root, node) {
  return {
    id: node.id,
    module: nodeModule(root, node),
    name: sourceFunctionName(node),
  };
}

function serializePath(root, pathGraph) {
  return {
    entry: serializeCodeNode(root, pathGraph.entry),
    nodes: pathGraph.nodes.map((node) => serializeCodeNode(root, node)),
    edges: pathGraph.edges.map(({ source, target, kind }) => ({ source, target, kind })),
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
  if (state && state !== 'complete') warnings.push(`CodeGraph 索引状态：${state}`);
  if (graph.isIndexStale?.()) warnings.push('当前索引由较旧的提取版本生成。');
  const pending = graph.getPendingReferenceCount?.() || 0;
  if (pending) warnings.push(`生成报告时仍有 ${pending} 条引用待解析。`);
  if (entrySelection.ambiguous) warnings.push('入口筛选匹配到多个定义，已分别分析各自的调用流程。');
  if (!entrySelection.selected.length && options.scope !== 'overview') warnings.push('未识别到可信入口，因此没有生成关键调用流程图。');
  if (pathGraphs.some((pathGraph) => pathGraph.truncated)) warnings.push('部分次要调用分支已折叠，以控制流程图大小。');
  if (architecture.truncated) warnings.push('架构图折叠了部分低优先级模块或关系。');
  if (architecture.fallback) warnings.push('当前 CodeGraph 没有可用的模块聚合结果，架构图改用文件依赖关系汇总。');

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
      warnings.push('无法查询所选入口的静态影响范围。');
    }
  }
  if (impact.truncated) warnings.push('影响图折叠了部分低优先级模块或关系。');

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

function architectureMarkdown(snapshot, maxLinks = LIMITS.architectureEdges) {
  const { modules } = snapshot.architecture;
  const links = snapshot.architecture.links.slice(0, maxLinks);
  if (!modules.length || !links.length) return '当前索引没有足够可信的跨模块关系可供连线展示，因此不绘制推测关系。';
  const lines = ['```flow LR'];
  for (const link of links) {
    if (link.source && link.target) {
      const evidence = link.declared ? ` · ${link.declared} 条关系` : '';
      lines.push(`${flowToken(link.source)} -> ${flowToken(link.target)}: ${relationLabel(link.kinds || [link.kind])}${evidence}`);
    }
  }
  lines.push('```', '', `图中保留了 ${modules.length} 个高置信度模块和 ${links.length} 条关系。箭头表示静态关系方向，不代表运行时一定按此执行。`);
  lines.push(snapshot.architecture.fallback
    ? '当前 CodeGraph 版本没有可用的模块聚合结果，因此使用文件依赖关系作为回退依据。'
    : '连线来自索引中的模块级静态关系；低置信度关系不会绘制。');
  if (snapshot.architecture.truncated || links.length < snapshot.architecture.links.length) lines.push('部分低优先级模块或关系已折叠。');
  return lines.join('\n');
}

function projectAreasMarkdown(snapshot) {
  if (!snapshot.directories.length) return '';
  const lines = ['## 项目主要区域 {span=2}', '', '```tree list', `${snapshot.project.name} | 已索引源码区域`];
  for (const [directory, count] of snapshot.directories) {
    const depth = directory.split('/').length;
    const name = directory.split('/').at(-1);
    lines.push(`${'  '.repeat(depth)}${name}/ | ${count} 个源码文件`);
  }
  lines.push('```', '', '这张目录树只显示项目区域和文件数量，不列出单个文件或代码位置。');
  if (snapshot.directoriesTruncated) lines.push('部分低优先级目录已折叠。');
  return lines.join('\n');
}

function entrySurfacesMarkdown(snapshot) {
  if (!snapshot.entries.length) return '当前索引未识别到可信的入口区域。';
  const modules = new Map();
  for (const entry of snapshot.entries) modules.set(entry.module, (modules.get(entry.module) || 0) + 1);
  const lines = [
    '## 入口区域 {span=2}',
    '',
    '入口由源码结构和调用关系推断，并按所属模块聚合。',
    '',
    '```flow LR',
  ];
  for (const [module, count] of modules) {
    lines.push(`${flowToken('推断入口')} -> ${flowToken(module)}: ${count} 个入口线索`);
  }
  lines.push('```');
  return lines.join('\n');
}

function moduleFlowMarkdown(snapshot, options) {
  const paths = snapshot.moduleFlows;
  if (!paths.length) return '当前入口没有形成跨模块调用关系，因此此处不生成空图。';
  const lines = [
    '## 跨模块流程概览 {span=2}',
    '',
    `分析范围：${({ overview: '概览', full: '完整', symbol: '指定入口' })[options.scope] || options.scope} · 向下追踪深度：${options.depth}。每条流程最多分析 ${LIMITS.pathNodes} 个调用节点和 ${LIMITS.pathEdges} 条关系；这里只画跨模块调用。`,
  ];
  paths.forEach(({ links, truncated }, index) => {
    lines.push('', `### 模块流程 ${index + 1}`, '', '```flow LR');
    for (const link of links) lines.push(`${flowToken(link.source)} -> ${flowToken(link.target)}: 调用${link.count > 1 ? ` · ${link.count} 条关系` : ''}`);
    lines.push('```');
    if (truncated) lines.push('', '部分次要调用分支已折叠。');
  });
  return lines.join('\n');
}

function functionLabels(nodes) {
  const counts = new Map();
  for (const node of nodes) {
    const key = `${node.module}\u0000${node.name}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const occurrences = new Map();
  const labels = new Map();
  for (const node of nodes) {
    const key = `${node.module}\u0000${node.name}`;
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    const duplicate = counts.get(key) > 1 ? `（同名 ${occurrence}）` : '';
    labels.set(node.id, `${node.module} · ${node.name}${duplicate}`);
  }
  return labels;
}

function flowReadingNotes(pathGraph, calls) {
  const outgoingCounts = new Map();
  for (const link of calls.values()) {
    outgoingCounts.set(link.source, (outgoingCounts.get(link.source) || 0) + 1);
  }
  const entryCalls = outgoingCounts.get(pathGraph.entry.id) || 0;
  const branchCount = [...outgoingCounts.values()].filter((count) => count > 1).length;
  const clauses = [
    entryCalls
      ? `入口连出 ${entryCalls} 条已识别的直接调用关系。`
      : '入口没有解析到直接下游调用。',
    branchCount
      ? `图中有 ${branchCount} 个节点连接到多个下游方向，表示存在静态分支线索。`
      : '图中没有识别到连接多个下游方向的节点。',
    '箭头只表示静态调用关系；调用条件和运行时顺序需要结合源码逻辑理解。',
  ];
  if (pathGraph.truncated) clauses.push('部分次要分支因图表上限未显示。');
  return `**流程解读：** ${clauses.join(' ')}`;
}

function functionCallFlowsMarkdown(snapshot, options) {
  if (options.scope === 'overview') {
    return '当前选择的是概览模式，没有展开函数调用分析。若要生成关键函数流程图，请使用完整模式或指定入口模式。';
  }
  if (!snapshot.paths.length) return '没有识别到可信的调用入口，因此无法生成关键函数流程图。';
  const lines = [
    '## 如何阅读 {span=2}',
    '',
    `每张图从选中的入口开始，最多向下追踪 ${options.depth} 层；每条流程最多保留 ${LIMITS.pathNodes} 个节点和 ${LIMITS.pathEdges} 条调用关系。节点前缀是模块名，节点末尾保留源码中的函数名。`,
    '箭头表示 CodeGraph 从源码中识别出的直接调用关系。一个节点连向多个节点表示存在多个静态分支，不代表每次运行都会执行全部分支或固定按图中顺序执行。',
  ];
  let diagramCount = 0;
  for (const [index, pathGraph] of snapshot.paths.entries()) {
    const labels = functionLabels(pathGraph.nodes);
    const calls = new Map();
    for (const edge of pathGraph.edges.filter((item) => item.kind === 'calls')) {
      if (!labels.has(edge.source) || !labels.has(edge.target)) continue;
      const key = `${edge.source}\u0000${edge.target}`;
      const link = calls.get(key) || { source: edge.source, target: edge.target, count: 0 };
      link.count += 1;
      calls.set(key, link);
    }
    lines.push('', `## 关键流程 ${index + 1} {span=2}`, '');
    if (!calls.size) {
      lines.push('这个入口没有解析到可确认的下游调用关系，所以不绘制空图。');
      continue;
    }
    lines.push('```flow LR');
    for (const link of calls.values()) {
      const count = link.count > 1 ? ` · ${link.count} 处调用` : '';
      lines.push(`${flowToken(labels.get(link.source))} -> ${flowToken(labels.get(link.target))}: 调用${count}`);
    }
    lines.push('```');
    lines.push('', flowReadingNotes(pathGraph, calls));
    lines.push('', `图中保留了 ${pathGraph.nodes.length} 个关键节点和 ${calls.size} 组调用关系。`);
    diagramCount += 1;
  }
  if (!diagramCount) lines.push('', '所有已识别入口都没有可确认的下游调用关系。');
  return lines.join('\n');
}

function impactMarkdown(snapshot) {
  const { focalModule, modules, edges, depth, truncated } = snapshot.impact;
  if (!focalModule || !modules.length || !edges.length) return '没有发现足够的静态影响关系可画；这不表示运行时一定没有影响。';
  const lines = [
    '## 静态影响范围 {span=2}',
    '',
    `CodeGraph 在深度 ${depth} 内识别到所选模块与另外 ${modules.length} 个区域之间的静态关系。`,
    '',
    '```flow LR',
  ];
  for (const edge of edges) {
    const source = edge.source === focalModule ? `所选区域 · ${focalModule}` : edge.source;
    const label = edge.kind === 'depends on' ? '依赖' : edge.kind === 'calls' ? '调用' : '可能影响';
    if (source && edge.target) lines.push(`${flowToken(source)} -> ${flowToken(edge.target)}: ${label}${edge.count > 1 ? ` · ${edge.count} 条关系` : ''}`);
  }
  lines.push('```');
  if (truncated) lines.push('', '部分低优先级模块或关系已折叠。');
  return lines.join('\n');
}

function unresolvedMarkdown(snapshot) {
  if (!snapshot.unresolved.length) return '在本次选取的调用流程中，没有发现需要单独标出的未解析引用。';
  const lines = [
    '## 未解析引用边界 {span=2}',
    '',
    `所选流程中有 ${snapshot.unresolved.reduce((sum, item) => sum + item.count, 0)} 条未解析引用，分布在 ${snapshot.unresolved.length} 个模块。这里按模块汇总，不列出具体名称或源码位置。`,
    '',
    '```flow LR',
  ];
  for (const ref of snapshot.unresolved) {
    lines.push(`${flowToken(ref.module)} -> ${flowToken('未解析引用')}: ${ref.count} 条`);
  }
  lines.push('```');
  if (snapshot.unresolvedCapped) lines.push('', `为控制图表大小，只显示前 ${LIMITS.unresolved} 条引用。`);
  return lines.join('\n');
}

const REPORT_PAGES = [
  { key: 'overview', label: '总览', filename: 'index.html' },
  { key: 'architecture', label: '架构图', filename: 'architecture.html' },
  { key: 'flows', label: '函数调用流程', filename: 'call-flows.html' },
  { key: 'details', label: '影响与边界', filename: 'details.html' },
];

function navigationMarkdown(currentKey, pages) {
  const links = REPORT_PAGES.map(({ key, label }) => {
    if (key === currentKey) return `**${label}**`;
    return `[${label}](${encodeURI(path.basename(pages[key]))})`;
  });
  return `**报告导航：** ${links.join('　·　')}`;
}

function pageDocument(snapshot, pages, key, heading, subtitle, body) {
  return `---
template: sheet
theme: auto
lang: zh-CN
title: ${quoteYaml(`${snapshot.project.name} · ${heading}`)}
subtitle: ${quoteYaml(`${subtitle} · ${snapshot.project.analyzedAt}`)}
cols: 2
---
${navigationMarkdown(key, pages)}

${body}
`;
}

function statsMarkdown(snapshot) {
  const languages = Object.entries(snapshot.stats.filesByLanguage || {})
    .filter(([, count]) => count)
    .sort((a, b) => b[1] - a[1]);
  const languagesText = languages.map(([language, count]) => `${language}（${count}）`).join('、') || '未报告';
  const indexStateLabels = { complete: '已完成', partial: '部分完成', indexing: '正在索引', stale: '已过期' };
  const rawIndexState = snapshot.project.indexState || '';
  const indexState = indexStateLabels[rawIndexState] || rawIndexState || '未知';
  return `| 文件 | 语言 | 框架 | 索引状态 |\n| ---: | --- | --- | --- |\n| ${snapshot.fileCount} | ${escapeCell(languagesText)} | ${escapeCell(snapshot.project.frameworks.join('、') || '未检测到')} | ${escapeCell(indexState)} |`;
}

function overviewMarkdown(snapshot, options, pages) {
  const supplement = options.supplement ? fs.readFileSync(path.resolve(options.supplement), 'utf8') : '';
  const summary = supplement || `CodeGraph 已索引 ${snapshot.fileCount} 个文件，识别出 ${snapshot.architecture.modules.length} 个高置信度关系模块。下方图表概括目录区域和主要模块关系；具体职责需要结合项目说明与源码阅读。`;
  const pageRows = REPORT_PAGES.slice(1).map(({ key, label }) => {
    const descriptions = {
      architecture: '查看模块组成、依赖方向和跨模块概览。',
      flows: '查看带源码函数名的关键调用流程，以及分支含义。',
      details: '查看静态影响范围、未解析引用和分析限制。',
    };
    return `| [${label}](${encodeURI(path.basename(pages[key]))}) | ${descriptions[key]} |`;
  }).join('\n');
  const body = `# 项目总览

## 项目说明 {span=2}

${summary}

## 项目规模 {span=2}

${statsMarkdown(snapshot)}

本报告将函数级关系用于筛选和追踪关键路径；总览与架构图按模块归纳，函数调用图节点保留源码函数名，页面中不列文件和行号清单。

${projectAreasMarkdown(snapshot)}

${entrySurfacesMarkdown(snapshot)}

## 架构速览 {span=2}

${architectureMarkdown(snapshot, 7)}

## 子页面 {span=2}

| 页面 | 阅读内容 |
| --- | --- |
${pageRows}

## 阅读提示

所有连线均来自静态源码分析。它们说明源码中识别到的结构关系，不等同于某次运行中的固定执行轨迹。`;
  return pageDocument(snapshot, pages, 'overview', '项目总览', '项目结构、重点模块和阅读导航', body);
}

function architecturePageMarkdown(snapshot, options, pages) {
  const areas = projectAreasMarkdown(snapshot).replace(/^## 项目主要区域 \{span=2\}\n\n/, '') || '索引中没有可展示的目录区域。';
  const body = `# 项目架构图

## 目录与代码区域 {span=2}

${areas}

## 模块关系图 {span=2}

${architectureMarkdown(snapshot)}

图中的“依赖、调用、导出”等文字说明模块关系类型。一个模块可能包含多个文件和多项职责；页面只显示聚合后的高置信度关系，不展开单个文件。

${entrySurfacesMarkdown(snapshot)}

${moduleFlowMarkdown(snapshot, options)}

## 如何使用这张图

先从入口区域定位主要起点，再沿箭头查看模块之间的依赖和调用方向。跨模块流程是从函数级调用关系聚合得到的概览；需要查看具体函数名时，打开“函数调用流程”页。`;
  return pageDocument(snapshot, pages, 'architecture', '项目架构图', '模块组成、关系方向和架构阅读说明', body);
}

function functionCallFlowsPageMarkdown(snapshot, options, pages) {
  const body = `# 关键函数调用流程

${functionCallFlowsMarkdown(snapshot, options)}

## 分析边界

CodeGraph 根据静态源码信息识别调用边。动态分派、反射、运行时注入或生成代码可能造成遗漏；流程图用于理解主要路径，不保证覆盖全部运行情况。节点采用源码函数名称，并以模块名帮助区分；页面不附带文件路径或行号清单。`;
  return pageDocument(snapshot, pages, 'flows', '关键函数调用流程', '保留源码函数名的关键静态调用关系图', body);
}

function detailsPageMarkdown(snapshot, options, pages) {
  const warningRows = snapshot.warnings.length
    ? snapshot.warnings.map((warning) => `- ${warning}`).join('\n')
    : '- 索引已完成，本次没有其他重要警告。';
  const body = `# 影响范围与分析边界

${options.scope === 'overview' ? '概览模式不展开影响范围与未解析引用分析。' : impactMarkdown(snapshot)}

${options.scope === 'overview' ? '' : unresolvedMarkdown(snapshot)}

## 本次分析提示 {span=2}

${warningRows}

- 测试、样例、文档、第三方依赖、生成代码、mock 和构建目录会从主要结构图中排除。
- 明显的语言运行时引用会从未解析引用图中省略，以减少噪声。
- 静态调用边表示源码分析发现了关系，不代表每次运行都会经过该路径。
- 图表有节点和关系数量上限；发生折叠时会在对应页面注明。

## 如何理解未解析引用

未解析引用表示 CodeGraph 无法把某个静态引用可靠地连到已索引定义。它可能来自外部依赖、动态调用或索引范围之外的代码；图中按模块计数，不猜测具体目标。`;
  return pageDocument(snapshot, pages, 'details', '影响与分析边界', '静态影响、未解析引用和索引限制', body);
}

function buildPageDrafts(snapshot, options, pages) {
  return {
    overview: overviewMarkdown(snapshot, options, pages),
    architecture: architecturePageMarkdown(snapshot, options, pages),
    flows: functionCallFlowsPageMarkdown(snapshot, options, pages),
    details: detailsPageMarkdown(snapshot, options, pages),
  };
}

function resolveOutputPaths(root, outputArg) {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const requested = path.resolve(outputArg || path.join(root, '.codewiki', 'reports', `codegraph-report-${timestamp}`));
  const extension = path.extname(requested);
  if (extension.toLowerCase() === '.html') {
    const basename = path.basename(requested);
    const stem = basename.slice(0, -extension.length);
    const directory = path.dirname(requested);
    return {
      directory,
      pages: {
        overview: requested,
        architecture: path.join(directory, `${stem}-architecture.html`),
        flows: path.join(directory, `${stem}-call-flows.html`),
        details: path.join(directory, `${stem}-details.html`),
      },
    };
  }
  return {
    directory: requested,
    pages: Object.fromEntries(REPORT_PAGES.map(({ key, filename }) => [key, path.join(requested, filename)])),
  };
}

function resolveDraftPaths(root, draftArg, pid) {
  if (!draftArg) {
    const directory = path.join(root, '.codewiki', 'tmp', `codegraph-report-${pid}`);
    return { directory, cleanup: true, pages: Object.fromEntries(REPORT_PAGES.map(({ key, filename }) => [key, path.join(directory, filename.replace(/\.html$/, '.md'))])) };
  }
  const requested = path.resolve(draftArg);
  const extension = path.extname(requested);
  if (extension.toLowerCase() === '.md') {
    const basename = path.basename(requested);
    const stem = basename.slice(0, -extension.length);
    const directory = path.dirname(requested);
    return {
      directory,
      cleanup: false,
      pages: {
        overview: requested,
        architecture: path.join(directory, `${stem}-architecture.md`),
        flows: path.join(directory, `${stem}-call-flows.md`),
        details: path.join(directory, `${stem}-details.md`),
      },
    };
  }
  return {
    directory: requested,
    cleanup: false,
    pages: Object.fromEntries(REPORT_PAGES.map(({ key, filename }) => [key, path.join(requested, filename.replace(/\.html$/, '.md'))])),
  };
}

function renderPageSet(drafts, output, expectedTitles) {
  const stagingDirectory = path.join(output.directory, `.codegraph-html-report-${process.pid}-staging`);
  fs.rmSync(stagingDirectory, { recursive: true, force: true });
  fs.mkdirSync(stagingDirectory, { recursive: true });
  try {
    for (const { key } of REPORT_PAGES) {
      const stagedHtml = path.join(stagingDirectory, path.basename(output.pages[key]));
      renderMarkdown(drafts[key], stagedHtml);
      if (!fs.existsSync(stagedHtml) || fs.statSync(stagedHtml).size === 0) throw new Error(`渲染器没有生成有效页面：${key}`);
      sanitizeOfflineHtml(stagedHtml);
      const html = fs.readFileSync(stagedHtml, 'utf8');
      if (!/<title>[^<]+<\/title>/i.test(html) || !html.includes(expectedTitles[key])) {
        throw new Error(`页面标题缺失或不完整：${key}`);
      }
    }
    validateLocalPageLinks(stagingDirectory, output.pages);
    for (const { key } of REPORT_PAGES) {
      fs.renameSync(path.join(stagingDirectory, path.basename(output.pages[key])), output.pages[key]);
    }
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function validateLocalPageLinks(directory, pages) {
  const pageNames = new Set(Object.values(pages).map((page) => path.basename(page)));
  for (const pageName of pageNames) {
    const html = fs.readFileSync(path.join(directory, pageName), 'utf8');
    const links = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)];
    for (const [, href] of links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
      const target = decodeURIComponent(href.split(/[?#]/, 1)[0]);
      if (!target) continue;
      if (!pageNames.has(path.basename(target)) || !fs.existsSync(path.resolve(directory, target))) {
        throw new Error(`页面包含无法访问的本地链接：${pageName} → ${href}`);
      }
    }
  }
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
  const output = resolveOutputPaths(root, args.output);
  const drafts = resolveDraftPaths(root, args.draft, process.pid);
  fs.mkdirSync(output.directory, { recursive: true });
  fs.mkdirSync(drafts.directory, { recursive: true });
  const CodeGraph = await loadCodeGraph();
  let graph;
  try {
    graph = CodeGraph.isInitialized(root)
      ? await CodeGraph.open(root, { sync: true })
      : await CodeGraph.init(root, { index: true, onProgress: progressPrinter });
    const snapshot = await buildSnapshot(graph, root, args);
    const pageDrafts = buildPageDrafts(snapshot, args, output.pages);
    for (const { key } of REPORT_PAGES) {
      fs.writeFileSync(drafts.pages[key], pageDrafts[key], 'utf8');
    }
    const expectedTitles = Object.fromEntries(REPORT_PAGES.map(({ key }) => [key, pageDrafts[key].match(/^title: "([^"]+)/m)?.[1] || snapshot.project.name]));
    renderPageSet(drafts.pages, output, expectedTitles);
    console.log(JSON.stringify({
      output: output.pages.overview,
      reportDirectory: output.directory,
      pages: output.pages,
      project: snapshot.project.name,
      stats: snapshot.stats,
      warnings: snapshot.warnings,
    }, null, 2));
  } finally {
    try { graph?.close(); } catch { /* best effort */ }
    if (drafts.cleanup) fs.rmSync(drafts.directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`codegraph-html-report: ${error.message}`);
  process.exitCode = 1;
});

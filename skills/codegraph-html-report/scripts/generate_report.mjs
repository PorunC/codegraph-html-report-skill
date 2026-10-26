#!/usr/bin/env node

/**
 * Build a bounded multi-page Markdown architecture report with CodeGraph and
 * render it to offline HTML pages with the local answer-me-with-html CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { layoutFrontmatter, selectPageLayout, splitCallPathIntoStages } from './report-layout.mjs';

const DEFAULT_DEPTH = 2;
const LIMITS = {
  architectureModules: 8,
  architectureEdges: 14,
  entryCandidates: 18,
  paths: 3,
  pathNodes: 10,
  pathEdges: 14,
  callsPerNode: 2,
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
  const levels = new Map([[entry.node.id, 0]]);
  const edges = [];
  const queue = [{ node: entry.node, level: 0 }];
  const visited = new Set([entry.node.id]);
  let folded = false;
  let queryFailed = false;
  const fanOutCache = new Map();
  while (queue.length) {
    const { node, level } = queue.shift();
    if (level >= depth) continue;
    let relationships = [];
    try { relationships = graph.getCallees?.(node.id, 1) || []; } catch { queryFailed = true; continue; }
    const targetIds = relationships.map((relationship) => relationship?.node?.id).filter(Boolean);
    let fanOut = new Map();
    try { fanOut = graph.getFanOut?.(targetIds) || new Map(); } catch { /* optional */ }
    for (const [id, value] of fanOut) fanOutCache.set(id, value);
    const ranked = relationships
      .filter((relationship) => relationship?.node && relationship?.edge)
      .map((relationship) => ({ ...relationship, score: relationshipScore(relationship, node, relationship.node, root, fanOutCache) }))
      .filter((relationship) => relationship.score > -100)
      .sort((a, b) => b.score - a.score);
    if (ranked.length > LIMITS.callsPerNode) folded = true;
    for (const relationship of ranked.slice(0, LIMITS.callsPerNode)) {
      const target = relationship.node;
      if (visited.has(target.id)) {
        if (edges.length >= LIMITS.pathEdges) { folded = true; break; }
        edges.push(relationship.edge);
        continue;
      }
      if (edges.length >= LIMITS.pathEdges || nodes.size >= LIMITS.pathNodes) { folded = true; break; }
      visited.add(target.id);
      nodes.set(target.id, target);
      levels.set(target.id, level + 1);
      edges.push(relationship.edge);
      if (level + 1 < depth) queue.push({ node: target, level: level + 1 });
    }
  }
  return { entry: entry.node, nodes: [...nodes.values()], edges, levels, folded, queryFailed, truncated: folded || queryFailed };
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
    nodes: pathGraph.nodes.map((node) => ({
      ...serializeCodeNode(root, node),
      level: pathGraph.levels?.get(node.id) ?? 0,
    })),
    edges: pathGraph.edges.map(({ source, target, kind }) => ({ source, target, kind })),
    truncated: pathGraph.truncated,
    folded: pathGraph.folded,
    queryFailed: pathGraph.queryFailed,
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
    return links.size ? [{
      links: [...links.values()],
      folded: pathGraph.folded,
      queryFailed: pathGraph.queryFailed,
    }] : [];
  });
  const warnings = [];
  const analysisWarnings = [];
  const presentationWarnings = [];
  const addWarning = (message, category = 'analysis') => {
    warnings.push(message);
    (category === 'presentation' ? presentationWarnings : analysisWarnings).push(message);
  };
  const state = graph.getIndexState?.();
  if (state && state !== 'complete') addWarning(`CodeGraph 索引状态：${state}`);
  if (graph.isIndexStale?.()) addWarning('当前索引由较旧的提取版本生成。');
  const pending = graph.getPendingReferenceCount?.() || 0;
  if (pending) addWarning(`生成报告时仍有 ${pending} 条引用待解析。`);
  if (entrySelection.ambiguous) addWarning('入口筛选匹配到多个定义，已分别分析各自的调用流程。');
  if (!entrySelection.selected.length && options.scope !== 'overview') addWarning('未识别到可信入口，因此没有生成关键调用流程图。');
  if (pathGraphs.some((pathGraph) => pathGraph.folded)) addWarning('部分低优先级调用关系因图表上限已折叠。', 'presentation');
  if (pathGraphs.some((pathGraph) => pathGraph.queryFailed)) addWarning('部分入口的下游调用查询失败，相关流程图不完整。');
  if (architecture.truncated) addWarning('架构图折叠了部分低优先级模块或关系。', 'presentation');
  if (files.directoriesTruncated) addWarning('项目区域树折叠了部分低优先级目录。', 'presentation');
  if (architecture.fallback) addWarning('当前 CodeGraph 没有可用的模块聚合结果，架构图改用文件依赖关系汇总。');

  const unresolved = [];
  let unresolvedCapped = false;
  let unresolvedStatus = options.scope === 'overview' ? 'not-requested' : pathNodes.length ? 'unsupported' : 'no-path';
  const unresolvedKeys = new Set();
  if (pathNodes.length && typeof graph.getUnresolvedReferencesFrom === 'function') {
    unresolvedStatus = 'complete';
    for (const node of pathNodes) {
      try {
        for (const ref of graph.getUnresolvedReferencesFrom(node.id) || []) {
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
        unresolvedStatus = 'partial';
      }
      if (unresolvedCapped) break;
    }
  }
  if (unresolvedStatus === 'unsupported') addWarning('当前 CodeGraph 接口未提供未解析引用查询，本报告无法确认这部分边界。');
  if (unresolvedStatus === 'partial') addWarning('部分未解析引用查询失败，图表只包含成功查询到的结果。');

  let impact = { focalModule: null, modules: [], edges: [], truncated: false };
  let impactStatus = options.scope === 'overview' ? 'not-requested' : 'no-entry';
  const focal = entrySelection.selected[0]?.node;
  if (focal && options.scope !== 'overview') {
    impactStatus = 'query-failed';
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
      impact = {
        focalModule: nodeModule(root, focal),
        modules: [...selectedModules],
        depth: options.depth,
        edges: [...impactLinks.values()].slice(0, LIMITS.impactEdges),
        truncated: countsByModule.size > LIMITS.impactModules || impactLinks.size > LIMITS.impactEdges,
      };
      impactStatus = impact.edges.length ? 'available' : 'no-relations';
    } catch {
      addWarning('无法查询所选入口的静态影响范围。');
    }
  }
  if (impact.truncated) addWarning('影响图折叠了部分低优先级模块或关系。', 'presentation');

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
    impactStatus,
    unresolved,
    unresolvedCapped,
    unresolvedStatus,
    warnings,
    analysisWarnings,
    presentationWarnings,
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
  if (!modules.length || !links.length) {
    return '当前索引没有足够可信的跨模块关系可供连线展示，因此不绘制推测关系。“未识别到”不代表运行时一定不存在模块关系。';
  }
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
  lines.push('边上的标签表示关系类型；同一模块可能包含多个文件和职责。');
  return lines.join('\n');
}

function projectAreasMarkdown(snapshot, maxDirectories = Number.POSITIVE_INFINITY) {
  if (!snapshot.directories.length) return '';
  const lines = ['```tree list', `${snapshot.project.name} | 已索引源码区域`];
  const directories = snapshot.directories.slice(0, maxDirectories);
  for (const [directory, count] of directories) {
    const depth = directory.split('/').length;
    const name = directory.split('/').at(-1);
    lines.push(`${'  '.repeat(depth)}${name}/ | ${count} 个源码文件`);
  }
  lines.push('```', '', '这张目录树只显示项目区域和文件数量，不列出单个文件或代码位置。');
  if (snapshot.directoriesTruncated || directories.length < snapshot.directories.length) lines.push('部分低优先级目录已折叠。');
  return lines.join('\n');
}

function entrySurfacesMarkdown(snapshot) {
  if (!snapshot.entries.length) return '## 入口区域 {span=2}\n\n当前索引未识别到可信的候选入口，因此不绘制空图；真实运行入口无法确认。';
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
  lines.push('```', '', '入口区域按静态筛选出的候选起点归属聚合；这不能确认真实触发者、请求类型或业务职责。');
  return lines.join('\n');
}

function moduleFlowMarkdown(snapshot, options) {
  const paths = snapshot.moduleFlows;
  if (!paths.length) return '## 跨模块流程概览 {span=2}\n\n当前所选入口没有形成可绘制的跨模块调用关系，因此不生成空图；这不能证明运行时没有跨模块交互。';
  const lines = [
    '## 跨模块流程概览 {span=2}',
    '',
    `分析范围：${({ overview: '概览', full: '完整', symbol: '指定入口' })[options.scope] || options.scope} · 向下追踪深度：${options.depth}。每条流程最多分析 ${LIMITS.pathNodes} 个调用节点和 ${LIMITS.pathEdges} 条关系；这里只画跨模块静态调用。`,
  ];
  paths.forEach(({ links, folded, queryFailed }, index) => {
    lines.push('', `### 模块流程 ${index + 1}`, '', '```flow LR');
    for (const link of links) lines.push(`${flowToken(link.source)} -> ${flowToken(link.target)}: 调用${link.count > 1 ? ` · ${link.count} 条关系` : ''}`);
    lines.push('```', '', '箭头表示聚合后的跨模块调用方向，不说明模块运行先后、条件分支或最终输出；这些行为无法仅凭此图确认。');
    if (folded) lines.push('', '部分低优先级静态关系已折叠。');
    if (queryFailed) lines.push('', '此路径有下游关系查询失败，跨模块流程可能不完整。');
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

function flowReadingNotes(stage) {
  const outgoingTargets = new Map();
  for (const link of stage.edges) {
    const targets = outgoingTargets.get(link.source) || new Set();
    targets.add(link.target);
    outgoingTargets.set(link.source, targets);
  }
  const multiTargetSources = [...outgoingTargets.values()].filter((targets) => targets.size > 1).length;
  const depthLabel = stage.depth + 1;
  const clauses = [`本图展示静态追踪第 ${depthLabel} 层中的 ${stage.edges.length} 条直接调用关系。`];
  clauses.push(multiTargetSources
    ? `${multiTargetSources} 个函数节点连接了多个目标；静态图无法区分这些目标是独立调用还是条件分支，也无法确认执行条件和顺序。`
    : '本图没有显示连接多个目标的调用点。');
  if (stage.parts > 1) clauses.push(`同一追踪层拆成 ${stage.parts} 张图以保持可读；图之间没有补加关系。`);
  return `**本图怎么读：** ${clauses.join(' ')}`;
}

function functionCallFlowsMarkdown(snapshot, options) {
  if (options.scope === 'overview') {
    return '当前选择的是概览模式，没有展开函数调用分析。若要生成关键函数流程图，请使用完整模式或指定入口模式。';
  }
  if (!snapshot.paths.length) return '没有识别到可信的调用入口，因此无法生成关键函数流程图。';
  const lines = [
    '## 阅读说明 {span=2}',
    '',
    `每个入口最多向下追踪 ${options.depth} 层；单条路径最多保留 ${LIMITS.pathNodes} 个节点和 ${LIMITS.pathEdges} 条关系。箭头表示 CodeGraph 识别出的静态直接调用关系，不保证运行顺序。`,
    '多个箭头只表示发现多个静态调用目标，不能据此确认条件分支、先后顺序、正常返回值或异常处理。图中叶节点也不等同于业务流程的结束点。',
  ];
  let diagramCount = 0;
  for (const [index, pathGraph] of snapshot.paths.entries()) {
    const labels = functionLabels(pathGraph.nodes);
    const calls = pathGraph.edges.filter((item) => item.kind === 'calls' && labels.has(item.source) && labels.has(item.target));
    lines.push('', `## 关键流程 ${index + 1} {span=2}`, '',
      '入口用途与实际触发场景无法仅从静态调用关系确认；此图表示结构分析选出的起点，不保证它就是用户请求或主要业务流程的入口。');
    if (!calls.length) {
      lines.push('', '当前入口没有解析到可确认的直接下游调用，因此不绘制空图。正常结果、失败结果和异常路径均无法由这组关系确认。');
      continue;
    }
    const stages = splitCallPathIntoStages(pathGraph);
    for (const stage of stages) {
      const title = `### 静态追踪层 ${stage.depth + 1}${stage.parts > 1 ? ` · ${stage.part}/${stage.parts}` : ''}`;
      lines.push('', title, '', '```flow LR');
      const groupedEdges = new Map();
      for (const edge of stage.edges) {
        const key = `${edge.source}\u0000${edge.target}`;
        groupedEdges.set(key, (groupedEdges.get(key) || 0) + 1);
      }
      for (const [key, count] of groupedEdges) {
        const [source, target] = key.split('\u0000');
        const evidence = count > 1 ? ` · ${count} 条静态关系` : '';
        lines.push(`${flowToken(labels.get(source))} -> ${flowToken(labels.get(target))}: 调用${evidence}`);
      }
      lines.push('```', '', flowReadingNotes(stage));
    }
    const targets = new Set(calls.map((edge) => edge.target));
    const sources = new Set(calls.map((edge) => edge.source));
    const leafCount = [...targets].filter((id) => !sources.has(id)).length;
    lines.push('', `本路径保留 ${pathGraph.nodes.length} 个节点和 ${calls.length} 条静态关系；各图按追踪层级拆分，共享的衔接节点均来自原图。${leafCount} 个节点在本次范围内没有已展示的后续调用；它们是否返回、抛错或产生业务输出无法确认。`);
    if (pathGraph.folded) lines.push('', '部分低优先级调用关系已折叠。', `每个节点最多展示 ${LIMITS.callsPerNode} 个下游目标；路径还受节点和关系上限限制。详见“影响与边界”页。`);
    if (pathGraph.queryFailed) lines.push('', '至少一次下游关系查询失败，这条路径可能不完整；失败后的运行行为无法确认。');
    diagramCount += 1;
  }
  if (!diagramCount) lines.push('', '所有已识别入口都没有可确认的下游调用关系。');
  return lines.join('\n');
}

function impactMarkdown(snapshot) {
  const { focalModule, modules, edges, depth, truncated } = snapshot.impact;
  if (snapshot.impactStatus === 'not-requested') return '概览模式未执行静态影响查询，因此本报告无法确认影响范围。';
  if (snapshot.impactStatus === 'no-entry') return '未识别到可用入口，未执行静态影响查询；当前无法确认影响范围。';
  if (snapshot.impactStatus === 'query-failed') return '静态影响查询失败，无法确认影响范围。';
  if (snapshot.impactStatus === 'no-relations' || !focalModule || !modules.length || !edges.length) {
    return '在当前索引和所选深度内，没有获得可绘制的跨模块静态影响关系。这不表示运行时一定没有影响。';
  }
  const lines = [
    `CodeGraph 在深度 ${depth} 内识别到所选模块与另外 ${modules.length} 个区域之间的静态关系。箭头按静态关系方向绘制，不表示实际执行顺序或结果。`,
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
  if (snapshot.unresolvedStatus === 'not-requested') return '概览模式未查询未解析引用，因此本报告无法确认这部分边界。';
  if (snapshot.unresolvedStatus === 'no-path') return '没有可分析的调用路径，未解析引用查询没有运行；不能据此判断项目中是否存在未解析引用。';
  if (snapshot.unresolvedStatus === 'unsupported') return '当前 CodeGraph 接口不支持未解析引用查询，本报告无法确认这部分边界。';
  if (!snapshot.unresolved.length && snapshot.unresolvedStatus === 'complete') {
    return '本次选取的调用路径未返回可汇总的未解析引用；这不代表项目其他区域没有此类引用。';
  }
  const lines = [
    `未解析引用表示静态引用无法可靠映射到已索引定义，不代表代码一定有错误。查询结果覆盖所选调用路径，并按模块和引用名称去重汇总。`,
    '',
    '```flow LR',
  ];
  for (const ref of snapshot.unresolved) {
    lines.push(`${flowToken(ref.module)} -> ${flowToken('未解析引用')}: ${ref.count} 种`);
  }
  lines.push('```');
  if (snapshot.unresolvedStatus === 'partial') lines.push('', '部分引用查询失败；图中只包含成功查询到的结果，完整边界无法确认。');
  if (snapshot.unresolvedCapped) lines.push('', `为控制图表大小，只汇总最多 ${LIMITS.unresolved} 种不同引用；更多关系已折叠。`);
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
  const layout = selectPageLayout(key, snapshot, body);
  return `---
${layoutFrontmatter(layout)}
theme: auto
lang: zh-CN
title: ${quoteYaml(`${snapshot.project.name} · ${heading}`)}
subtitle: ${quoteYaml(`${subtitle} · ${snapshot.project.analyzedAt}`)}
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
  const scopeLabels = {
    overview: '项目概览；不展开函数调用和静态影响查询。',
    full: '项目结构和有限数量的关键调用路径。',
    symbol: '围绕指定入口筛选关键调用路径。',
  };
  const pageRows = REPORT_PAGES.slice(1).map(({ key, label }) => {
    const descriptions = {
      architecture: '查看模块组成、依赖方向和跨模块概览。',
      flows: '查看带源码函数名的关键调用流程，以及分支含义。',
      details: '查看静态影响范围、未解析引用和分析限制。',
    };
    return `| [${label}](${encodeURI(path.basename(pages[key]))}) | ${descriptions[key]} |`;
  }).join('\n');
  const body = `# 项目总览

## 项目结论 {span=2}

${summary}

**分析范围：** ${scopeLabels[options.scope] || options.scope}

本报告用静态关系筛选重点模块和调用路径；它不保证运行时执行顺序，也不推测未被索引确认的业务结果。

## 项目规模 {span=2}

${statsMarkdown(snapshot)}

## 项目区域 {span=2}

${projectAreasMarkdown(snapshot, 8) || '索引中没有可展示的目录区域。'}

## 架构速览 {span=2}

${architectureMarkdown(snapshot, 7)}

## 阅读路线 {span=2}

| 页面 | 阅读内容 |
| --- | --- |
${pageRows}

函数名称只出现在关键调用流程图中；其他页面按项目区域和模块关系组织，不列源码位置清单。`;
  return pageDocument(snapshot, pages, 'overview', '项目总览', '项目结构、重点模块和阅读导航', body);
}

function architecturePageMarkdown(snapshot, options, pages) {
  const areas = projectAreasMarkdown(snapshot) || '索引中没有可展示的目录区域。';
  const body = `# 项目架构图

此页先展示项目区域，再呈现模块关系和候选入口。箭头说明静态关系方向，不能确认模块的运行先后或业务职责。

## 项目区域 {span=2}

${areas}

## 模块关系 {span=2}

${architectureMarkdown(snapshot)}

${entrySurfacesMarkdown(snapshot)}

${moduleFlowMarkdown(snapshot, options)}

## 阅读建议

先从项目区域定位模块，再按关系标签阅读依赖方向。入口图只展示静态筛选出的候选起点；跨模块流程只展示已识别的调用关系。需要看源码函数名称时，打开“函数调用流程”页。`;
  return pageDocument(snapshot, pages, 'architecture', '项目架构图', '模块组成、关系方向和架构阅读说明', body);
}

function functionCallFlowsPageMarkdown(snapshot, options, pages) {
  const body = `# 关键函数调用流程

${functionCallFlowsMarkdown(snapshot, options)}

## 无法从调用图确认的内容

静态调用关系不能说明正常返回值、用户可见输出、异常处理或失败后的恢复行为。动态分派、反射、运行时注入和生成代码也可能造成遗漏；图表用于定位值得阅读的路径，不保证覆盖全部运行情况。源码函数名只显示在图中，页面不附带文件路径或行号清单。`;
  return pageDocument(snapshot, pages, 'flows', '关键函数调用流程', '保留源码函数名的关键静态调用关系图', body);
}

function detailsPageMarkdown(snapshot, options, pages) {
  const analysisWarnings = snapshot.analysisWarnings || snapshot.warnings || [];
  const presentationWarnings = snapshot.presentationWarnings || [];
  const indexStateLabels = { complete: '已完成', partial: '部分完成', indexing: '正在索引', stale: '已过期' };
  const state = snapshot.project.indexState || 'unknown';
  const warningList = (items, empty) => items.length ? items.map((warning) => `- ${warning}`).join('\n') : `- ${empty}`;
  const body = `# 影响范围与分析边界

本页说明索引状态、当前查询结果和图表展示上限。未绘制关系不等于运行时不存在。

## 索引与分析状态 {span=2}

当前索引状态：**${indexStateLabels[state] || (state === 'unknown' ? '未知' : state)}**。

${warningList(analysisWarnings, '本次索引和关系查询没有其他已知警告。')}

## 图表范围与折叠 {span=2}

${warningList(presentationWarnings, '当前图表没有因展示上限折叠关系。')}

- 架构图最多显示 ${LIMITS.architectureModules} 个模块和 ${LIMITS.architectureEdges} 条关系。
- 每条调用路径最多显示 ${LIMITS.pathNodes} 个节点和 ${LIMITS.pathEdges} 条关系。
- 每个调用节点最多显示 ${LIMITS.callsPerNode} 个优先级较高的下游目标。
- 影响图最多显示 ${LIMITS.impactModules} 个模块和 ${LIMITS.impactEdges} 条关系。
- 未解析引用图最多汇总 ${LIMITS.unresolved} 种不同引用名称；数量按模块和名称去重。

## 静态影响范围 {span=2}

${impactMarkdown(snapshot)}

## 未解析引用 {span=2}

${unresolvedMarkdown(snapshot)}

## 排除范围与解释边界

- 测试、样例、文档、第三方依赖、生成代码、mock 和构建目录会从主要结构图中排除。
- 常见语言运行时名称会从未解析引用图中省略，以减少噪声。
- 未解析引用表示引用无法可靠映射到已索引定义，不代表项目代码一定有错误。
- 关系和计数仅覆盖当前索引及已选入口；“未识别到”不代表“没有发生”。`;
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

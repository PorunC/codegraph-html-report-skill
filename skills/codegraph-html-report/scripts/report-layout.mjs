/** Stable thresholds for choosing a compact board or a linear reading page. */
export const LAYOUT_THRESHOLDS = Object.freeze({
  architecture: Object.freeze({ maxSections: 3, maxDiagrams: 2, maxVisualSections: 2 }),
  flows: Object.freeze({ maxPaths: 1, maxNodes: 6, maxEdges: 6, maxSections: 3 }),
  details: Object.freeze({ maxSections: 4, maxWarnings: 2, maxCharacters: 2600 }),
});

export const CALL_FLOW_STAGE_LIMITS = Object.freeze({ maxNodes: 6, maxEdges: 6 });

function countHeadings(markdown) {
  return [...String(markdown).matchAll(/^##\s+/gm)].length;
}

function countDiagrams(markdown) {
  return [...String(markdown).matchAll(/^```(?:flow|sequence|tree|timeline|er|chart|limits)\b/gm)].length;
}

function hasImpact(snapshot) {
  return Boolean(snapshot?.impact?.edges?.length);
}

function hasUnresolved(snapshot) {
  return Boolean(snapshot?.unresolved?.length);
}

/**
 * Pick a predictable template from the report's existing data and Markdown size.
 * `doc` is reserved for pages whose sections or diagrams benefit from linear reading.
 */
export function selectPageLayout(key, snapshot = {}, markdown = '') {
  const sections = countHeadings(markdown);
  const diagrams = countDiagrams(markdown);
  const limits = LAYOUT_THRESHOLDS[key];
  let useDoc = false;

  if (key === 'architecture') {
    const visualSections = [
      Boolean(snapshot?.directories?.length),
      Boolean(snapshot?.architecture?.links?.length),
      Boolean(snapshot?.entries?.length),
      Boolean(snapshot?.moduleFlows?.length),
    ].filter(Boolean).length;
    useDoc = sections > limits.maxSections
      || diagrams > limits.maxDiagrams
      || visualSections > limits.maxVisualSections;
  } else if (key === 'flows') {
    const paths = Array.isArray(snapshot?.paths) ? snapshot.paths : [];
    const pathCount = paths.length;
    const nodeCount = paths.reduce((sum, item) => sum + (item?.nodes?.length || 0), 0);
    const edgeCount = paths.reduce((sum, item) => sum + (item?.edges?.filter((edge) => edge?.kind === 'calls').length || 0), 0);
    useDoc = pathCount > limits.maxPaths
      || nodeCount > limits.maxNodes
      || edgeCount > limits.maxEdges
      || sections > limits.maxSections;
  } else if (key === 'details') {
    const warningCount = snapshot?.analysisWarnings?.length
      ?? ((snapshot?.warnings?.length || 0) - (snapshot?.presentationWarnings?.length || 0));
    useDoc = sections > limits.maxSections
      || warningCount > limits.maxWarnings
      || String(markdown).length > limits.maxCharacters
      || (hasImpact(snapshot) && hasUnresolved(snapshot));
  } else {
    // Overview stays a compact entry point even when its child pages are detailed.
    useDoc = false;
  }

  return useDoc ? { template: 'doc' } : { template: 'sheet', cols: 2 };
}

export function layoutFrontmatter(layout) {
  const lines = [`template: ${layout.template}`];
  if (layout.template === 'sheet') lines.push(`cols: ${layout.cols || 2}`);
  return lines.join('\n');
}

/**
 * Split an existing call graph into compact, depth-ordered pieces.
 * Nodes may repeat at stage boundaries; the input node and edge sets do not change.
 */
export function splitCallPathIntoStages(path, limits = CALL_FLOW_STAGE_LIMITS) {
  const nodes = Array.isArray(path?.nodes) ? path.nodes : [];
  const edges = Array.isArray(path?.edges) ? path.edges : [];
  if (!edges.length) return [];

  const nodeById = new Map(nodes.filter((node) => node?.id).map((node) => [node.id, node]));
  const maxNodes = Math.max(2, Number(limits.maxNodes) || CALL_FLOW_STAGE_LIMITS.maxNodes);
  const maxEdges = Math.max(1, Number(limits.maxEdges) || CALL_FLOW_STAGE_LIMITS.maxEdges);
  const depthOf = (id) => Number(nodeById.get(id)?.level) || 0;

  // Edges from one source depth form a static tracing layer. Keep their input order.
  const depthGroups = [];
  const groupByDepth = new Map();
  for (const edge of edges) {
    const depth = depthOf(edge?.source);
    let group = groupByDepth.get(depth);
    if (!group) {
      group = { depth, edges: [] };
      groupByDepth.set(depth, group);
      depthGroups.push(group);
    }
    group.edges.push(edge);
  }
  depthGroups.sort((a, b) => a.depth - b.depth);

  const stages = [];
  for (const group of depthGroups) {
    let batch = [];
    let batchNodeIds = new Set();
    const flush = () => {
      if (!batch.length) return;
      const part = stages.filter((stage) => stage.depth === group.depth).length + 1;
      stages.push({
        depth: group.depth,
        part,
        edges: batch,
        nodes: nodes.filter((node) => batchNodeIds.has(node.id)),
      });
      batch = [];
      batchNodeIds = new Set();
    };

    for (const edge of group.edges) {
      const edgeNodeIds = [edge?.source, edge?.target].filter(Boolean);
      const additions = edgeNodeIds.filter((id) => !batchNodeIds.has(id));
      if (batch.length && (batch.length >= maxEdges || batchNodeIds.size + additions.length > maxNodes)) flush();
      batch.push(edge);
      for (const id of edgeNodeIds) batchNodeIds.add(id);
    }
    flush();
  }

  const partsByDepth = new Map();
  for (const stage of stages) partsByDepth.set(stage.depth, (partsByDepth.get(stage.depth) || 0) + 1);
  for (const stage of stages) stage.parts = partsByDepth.get(stage.depth);
  return stages;
}

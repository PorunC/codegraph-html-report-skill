/** Stable layout thresholds for compact boards and sequential reading pages. */
export const LAYOUT_THRESHOLDS = Object.freeze({
  architecture: Object.freeze({ maxAreas: 4, maxRelationships: 3, maxSections: 4 }),
  flows: Object.freeze({ maxFlows: 1, maxNodes: 6, maxEdges: 5, maxSections: 3 }),
  details: Object.freeze({ maxSections: 4, maxCharacters: 2400 }),
});

function countHeadings(markdown) {
  return [...String(markdown).matchAll(/^##\s+/gm)].length;
}

function countDiagrams(markdown) {
  return [...String(markdown).matchAll(/^```(?:flow|sequence|tree)\b/gm)].length;
}

/** Select a template using only validated report data and the page draft. */
export function selectPageLayout(key, analysis = {}, markdown = '') {
  const sections = countHeadings(markdown);
  const diagrams = countDiagrams(markdown);
  const limits = LAYOUT_THRESHOLDS[key];
  let useDoc = false;

  if (key === 'architecture') {
    useDoc = (analysis.areas?.length || 0) > limits.maxAreas
      || (analysis.relationships?.length || 0) > limits.maxRelationships
      || sections > limits.maxSections
      || diagrams > 2;
  } else if (key === 'flows') {
    const flows = Array.isArray(analysis.flows) ? analysis.flows : [];
    const nodeCount = flows.reduce((sum, flow) => sum + (flow.steps?.length || 0), 0);
    const edgeCount = flows.reduce((sum, flow) => sum + (flow.edges?.length || 0), 0);
    useDoc = flows.length > limits.maxFlows
      || nodeCount > limits.maxNodes
      || edgeCount > limits.maxEdges
      || sections > limits.maxSections
      || diagrams > 1;
  } else if (key === 'details') {
    useDoc = sections > limits.maxSections || String(markdown).length > limits.maxCharacters;
  }

  return useDoc ? { template: 'doc' } : { template: 'sheet', cols: 2 };
}

export function layoutFrontmatter(layout) {
  const lines = [`template: ${layout.template}`];
  if (layout.template === 'sheet') lines.push(`cols: ${layout.cols || 2}`);
  return lines.join('\n');
}

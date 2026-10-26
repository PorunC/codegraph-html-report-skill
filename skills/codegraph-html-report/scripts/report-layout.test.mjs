import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFrontmatter, selectPageLayout, splitCallPathIntoStages } from './report-layout.mjs';

const shortMarkdown = '## A 摘要\n一段说明。\n\n```flow\nA -> B: 调用\n```';

test('overview stays a two-column sheet and sheet-only cols are emitted conditionally', () => {
  assert.deepEqual(selectPageLayout('overview', {}, '# 总览\n'.repeat(20)), { template: 'sheet', cols: 2 });
  assert.equal(layoutFrontmatter({ template: 'sheet', cols: 2 }), 'template: sheet\ncols: 2');
  assert.equal(layoutFrontmatter({ template: 'doc' }), 'template: doc');
});

test('architecture uses doc when multiple visual sections need a reading order', () => {
  const compact = { directories: [['src', 2]], architecture: { links: [] }, entries: [], moduleFlows: [] };
  const complex = {
    directories: [['src', 2]],
    architecture: { links: [{ source: 'src', target: 'lib' }] },
    entries: [{ module: 'src' }],
    moduleFlows: [{ links: [{ source: 'src', target: 'lib' }] }],
  };
  assert.equal(selectPageLayout('architecture', compact, shortMarkdown).template, 'sheet');
  assert.equal(selectPageLayout('architecture', complex, shortMarkdown).template, 'doc');
});

test('one short call path stays a sheet; multiple or long paths use doc', () => {
  const shortPath = { paths: [{ nodes: [{}, {}, {}], edges: [{ kind: 'calls' }, { kind: 'calls' }] }] };
  const longPath = { paths: [{ nodes: Array.from({ length: 8 }, () => ({})), edges: Array.from({ length: 7 }, () => ({ kind: 'calls' })) }] };
  const multiplePaths = { paths: [shortPath.paths[0], shortPath.paths[0]] };
  assert.equal(selectPageLayout('flows', shortPath, shortMarkdown).template, 'sheet');
  assert.equal(selectPageLayout('flows', longPath, shortMarkdown).template, 'doc');
  assert.equal(selectPageLayout('flows', multiplePaths, shortMarkdown).template, 'doc');
});

test('compact details stay a sheet while combined impact and unresolved findings use doc', () => {
  assert.equal(selectPageLayout('details', { warnings: [] }, shortMarkdown).template, 'sheet');
  assert.equal(selectPageLayout('details', {
    impact: { edges: [{ source: 'app', target: 'core' }] },
    unresolved: [{ module: 'app', count: 1 }],
    warnings: [],
  }, shortMarkdown).template, 'doc');
});

test('call-flow stages keep the original node and edge sets within readable bounds', () => {
  const nodes = [
    { id: 'entry', level: 0 },
    { id: 'a', level: 1 }, { id: 'b', level: 1 }, { id: 'c', level: 1 },
    { id: 'd', level: 2 }, { id: 'e', level: 2 }, { id: 'f', level: 2 },
    { id: 'g', level: 2 }, { id: 'h', level: 2 }, { id: 'i', level: 2 },
  ];
  const edges = [
    { source: 'entry', target: 'a', kind: 'calls' },
    { source: 'entry', target: 'b', kind: 'calls' },
    { source: 'entry', target: 'c', kind: 'calls' },
    { source: 'a', target: 'd', kind: 'calls' }, { source: 'a', target: 'e', kind: 'calls' },
    { source: 'a', target: 'd', kind: 'calls' },
    { source: 'b', target: 'f', kind: 'calls' }, { source: 'b', target: 'g', kind: 'calls' },
    { source: 'c', target: 'h', kind: 'calls' }, { source: 'c', target: 'i', kind: 'calls' },
    { source: 'g', target: 'a', kind: 'calls' },
  ];
  const stages = splitCallPathIntoStages({ nodes, edges });
  const stagedEdges = stages.flatMap((stage) => stage.edges);
  const edgeSignature = (edge) => `${edge.source}>${edge.target}:${edge.kind}`;

  assert.deepEqual(stagedEdges.map(edgeSignature).sort(), edges.map(edgeSignature).sort());
  assert.ok(stages.length > 2, 'the wider second tracing layer should be split');
  for (const stage of stages) {
    assert.ok(stage.nodes.length <= 6);
    assert.ok(stage.edges.length <= 6);
    for (const node of stage.nodes) assert.ok(nodes.includes(node), 'stages may repeat only original nodes');
  }
  assert.equal(new Set(stages.flatMap((stage) => stage.nodes)).size, nodes.length);
});

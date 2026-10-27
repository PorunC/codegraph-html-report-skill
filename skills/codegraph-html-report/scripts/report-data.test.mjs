import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPageDrafts, validateAnalysis } from './report-data.mjs';

function evidence(source = 'src/app.js', basis = 'direct') {
  return [{ source, location: 'exported function', basis, note: 'The cited source states this relationship.' }];
}

function validAnalysis() {
  return {
    schemaVersion: 1,
    project: {
      name: 'fixture',
      summary: 'A small request pipeline.',
      summaryEvidence: evidence('README.md'),
      analysisScope: {
        included: ['README.md', 'src/app.js', 'src/store.js'],
        excluded: ['node_modules'],
        method: 'Read the README and the two source modules.',
      },
    },
    conclusions: [{ title: 'Pipeline', description: 'The API delegates persistence to the store area.', evidence: evidence() }],
    areas: [
      { id: 'api', name: 'API', responsibility: 'Accepts and validates requests.', evidence: evidence('src/app.js') },
      { id: 'store', name: 'Store', responsibility: 'Reads persisted records.', evidence: evidence('src/store.js') },
    ],
    relationships: [{ from: 'api', to: 'store', label: '读取', evidence: evidence('src/app.js') }],
    entryClues: [{ title: 'Exported handler', description: 'The module exports the request handler.', evidence: evidence() }],
    flows: [{
      title: 'Request path',
      purpose: 'The handler validates input before reading records.',
      purposeEvidence: evidence(),
      steps: [
        { id: 'receive', label: '接收请求', description: 'The handler accepts input.', evidence: evidence() },
        { id: 'read', label: '读取记录', description: 'The handler calls the store.', evidence: evidence('src/app.js') },
      ],
      edges: [{ from: 'receive', to: 'read', label: '调用', evidence: evidence('src/app.js') }],
      unknowns: ['The runtime trigger is not confirmed by the reviewed files.'],
    }],
    extensionPoints: [],
    risks: [],
    unknowns: [{ question: 'What invokes the handler?', reason: 'The reviewed files do not show the runtime adapter.', checked: ['src/app.js'] }],
    analysisLimits: ['This report covers only the listed files and README.'],
  };
}

test('valid source analysis passes structural validation and evidence checks', () => {
  const analysis = validAnalysis();
  assert.deepEqual(validateAnalysis(analysis), []);
});

test('missing fields, wrong types, unknown keys, duplicate IDs, and unsupported edges fail validation', () => {
  const analysis = validAnalysis();
  delete analysis.project.summary;
  analysis.extra = true;
  analysis.areas[1].id = analysis.areas[0].id;
  analysis.flows[0].edges[0].to = 'missing-step';
  analysis.risks = [{ title: 'Risk', description: 'Description', severity: 'critical', evidence: evidence() }];
  const errors = validateAnalysis(analysis);
  assert.ok(errors.some((error) => error.includes('project 缺少必填字段 summary')));
  assert.ok(errors.some((error) => error.includes('不支持的字段 extra')));
  assert.ok(errors.some((error) => error.includes('areas[1].id 重复')));
  assert.ok(errors.some((error) => error.includes('未匹配到步骤 ID')));
  assert.ok(errors.some((error) => error.includes('severity')));
});

test('evidence paths must be relative and point inside the project when a root is supplied', () => {
  const analysis = validAnalysis();
  analysis.conclusions[0].evidence[0].source = '../outside.js';
  const errors = validateAnalysis(analysis, { projectRoot: process.cwd() });
  assert.ok(errors.some((error) => error.includes('相对路径')));
});

test('interpretive-only edges are rejected while interpretation remains valid in prose claims', () => {
  const analysis = validAnalysis();
  analysis.relationships[0].evidence = evidence('src/app.js', 'interpretation');
  const errors = validateAnalysis(analysis);
  assert.ok(errors.some((error) => error.includes('relationships[0].evidence 至少需要一条 basis 为 direct')));
  analysis.relationships[0].evidence = evidence('src/app.js');
  analysis.flows[0].edges[0].evidence = evidence('src/app.js', 'interpretation');
  assert.ok(validateAnalysis(analysis).some((error) => error.includes('flows[0].edges[0].evidence 至少需要一条 basis 为 direct')));
  analysis.flows[0].edges[0].evidence = evidence('src/app.js');
  analysis.flows[0].steps[1].evidence = evidence('src/app.js', 'interpretation');
  assert.ok(validateAnalysis(analysis).some((error) => error.includes('连接的步骤 read 缺少 direct 源码依据')));
  analysis.flows[0].steps[1].evidence = evidence('src/app.js');
  analysis.relationships = [];
  analysis.conclusions[0].evidence = evidence('src/app.js', 'interpretation');
  assert.deepEqual(validateAnalysis(analysis), []);
});

test('a single area with no supported relationships keeps unknowns and omits empty diagrams', () => {
  const analysis = validAnalysis();
  analysis.areas = [analysis.areas[0]];
  analysis.relationships = [];
  analysis.flows = [];
  analysis.unknowns = [{ question: 'Is there a second adapter?', reason: 'No source in the reviewed scope confirms it.' }];
  const errors = validateAnalysis(analysis);
  assert.deepEqual(errors, []);
  const drafts = buildPageDrafts(analysis, {
    overview: '/tmp/index.html', architecture: '/tmp/architecture.html', flows: '/tmp/call-flows.html', details: '/tmp/details.html',
  });
  assert.match(drafts.architecture, /没有提供有源码依据的区域关系/);
  assert.doesNotMatch(drafts.architecture, /```flow/);
  assert.match(drafts.flows, /没有足够证据整理出关键流程/);
  assert.doesNotMatch(drafts.flows, /```flow/);
  assert.match(drafts.details, /Is there a second adapter/);
});

test('untrusted Markdown fields cannot inject raw HTML, links, or additional flow lines', () => {
  const analysis = validAnalysis();
  analysis.project.summary = '<script>alert(1)</script> [remote](https://example.invalid)';
  analysis.flows[0].steps[0].label = 'Start\nInjected -> Edge';
  const drafts = buildPageDrafts(analysis, {
    overview: '/tmp/index.html', architecture: '/tmp/architecture.html', flows: '/tmp/call-flows.html', details: '/tmp/details.html',
  });
  assert.doesNotMatch(drafts.overview, /<script>/);
  assert.doesNotMatch(drafts.overview, /\]\(https:\/\/example\.invalid/);
  const graph = drafts.flows.match(/```flow LR[\s\S]*?```/);
  assert.ok(graph);
  const diagramLines = graph[0].split('\n').slice(1, -1).filter((line) => line.trim());
  assert.equal(diagramLines.length, 1);
  assert.doesNotMatch(diagramLines[0], /^Injected\b/);
  assert.equal((graph[0].match(/->/g) || []).length, 1);
});

test('reader-facing evidence omits pinpoint locations while retaining source paths', () => {
  const analysis = validAnalysis();
  analysis.conclusions[0].evidence[0].location = 'internalFunctionName';
  const drafts = buildPageDrafts(analysis, {
    overview: '/tmp/index.html', architecture: '/tmp/architecture.html', flows: '/tmp/call-flows.html', details: '/tmp/details.html',
  });
  assert.match(drafts.overview, /`src\/app\.js`/);
  assert.doesNotMatch(Object.values(drafts).join('\n'), /internalFunctionName/);
});

test('empty analysis is rejected instead of becoming an empty report', () => {
  const errors = validateAnalysis({});
  assert.ok(errors.length >= 10);
});

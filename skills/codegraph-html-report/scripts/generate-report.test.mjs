import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./generate_report.mjs', import.meta.url));

function fixtureAnalysis() {
  const ref = (source) => [{ source, location: 'internalFunctionName', basis: 'direct', note: 'The cited code supports this statement.' }];
  return {
    schemaVersion: 1,
    project: {
      name: 'generator-fixture',
      summary: 'A small source-backed report fixture.',
      summaryEvidence: ref('README.md'),
      analysisScope: { included: ['README.md', 'src/app.js'], excluded: ['node_modules'], method: 'Read README and app source.' },
    },
    conclusions: [{ title: 'Delegation', description: 'The app delegates to a storage area.', evidence: ref('src/app.js') }],
    areas: [
      { id: 'app', name: 'App', responsibility: 'Handles the request.', evidence: ref('src/app.js') },
      { id: 'store', name: 'Store', responsibility: 'Persists data.', evidence: ref('src/app.js') },
    ],
    relationships: [{ from: 'app', to: 'store', label: '调用', evidence: ref('src/app.js') }],
    entryClues: [],
    flows: [{
      title: 'Request flow', purpose: 'The app calls storage.', purposeEvidence: ref('src/app.js'),
      steps: [
        { id: 'start', label: '接收请求', description: 'The app receives input.', evidence: ref('src/app.js') },
        { id: 'save', label: '保存数据', description: 'The app calls storage.', evidence: ref('src/app.js') },
      ],
      edges: [{ from: 'start', to: 'save', label: '调用', evidence: ref('src/app.js') }],
      unknowns: ['The transport trigger is not shown.'],
    }],
    extensionPoints: [],
    risks: [],
    unknowns: [],
    analysisLimits: ['Only the fixture files were reviewed.'],
  };
}

function writeFixture(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export function run() { return true; }\n', 'utf8');
}

test('generator renders four offline pages without creating a .codegraph directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-analysis-report-'));
  const output = path.join(root, 'report');
  const analysisPath = path.join(root, 'source-analysis.json');
  try {
    writeFixture(root);
    fs.writeFileSync(analysisPath, JSON.stringify(fixtureAnalysis(), null, 2), 'utf8');
    const result = spawnSync(process.execPath, [script, '--project', root, '--analysis', analysisPath, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal((result.stderr.match(/STE ✓ 0 warnings/g) || []).length, 4, result.stderr);
    for (const filename of ['index.html', 'architecture.html', 'call-flows.html', 'details.html']) {
      const html = fs.readFileSync(path.join(output, filename), 'utf8');
      assert.ok(html.length > 0, filename);
      assert.match(html, /<title>[^<]+<\/title>/i);
      assert.doesNotMatch(html, /(?:src|href)=["'](?:https?:)?\/\//i);
      assert.doesNotMatch(html, /url\(\s*["']?(?:https?:)?\/\//i);
      assert.doesNotMatch(html, /internalFunctionName/);
      for (const [, href] of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
        const target = decodeURIComponent(href.split(/[?#]/, 1)[0]);
        if (target) assert.ok(fs.existsSync(path.resolve(output, target)), `${filename} → ${href}`);
      }
    }
    assert.ok(!fs.existsSync(path.join(root, '.codegraph')));
    assert.match(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), /architecture\.html/);
    const generatorSource = fs.readFileSync(script, 'utf8');
    assert.doesNotMatch(generatorSource, /@colbymchenry\/codegraph|CodeGraph\.(?:open|init)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generator rejects a missing analysis file with a non-zero exit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-analysis-report-invalid-'));
  try {
    writeFixture(root);
    const result = spawnSync(process.execPath, [script, '--project', root, '--analysis', path.join(root, 'missing.json')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot read --analysis file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generator rejects malformed and empty analysis JSON before creating a report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-analysis-report-invalid-json-'));
  const output = path.join(root, 'report');
  try {
    writeFixture(root);
    const analysisPath = path.join(root, 'source-analysis.json');
    fs.writeFileSync(analysisPath, '{', 'utf8');
    let result = spawnSync(process.execPath, [script, '--project', root, '--analysis', analysisPath, '--output', output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid analysis JSON/);
    assert.ok(!fs.existsSync(output));
    fs.writeFileSync(analysisPath, '{}', 'utf8');
    result = spawnSync(process.execPath, [script, '--project', root, '--analysis', analysisPath, '--output', output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Analysis JSON is invalid/);
    assert.ok(!fs.existsSync(output));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderer failures propagate as non-zero command status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-analysis-report-render-failure-'));
  try {
    writeFixture(root);
    const analysisPath = path.join(root, 'source-analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(fixtureAnalysis()), 'utf8');
    const failingRenderer = path.join(root, 'fail-renderer.mjs');
    fs.writeFileSync(failingRenderer, 'process.exit(17);\n', 'utf8');
    const result = spawnSync(process.execPath, [script, '--project', root, '--analysis', analysisPath, '--output', path.join(root, 'report')], {
      encoding: 'utf8',
      env: { ...process.env, ANSWER_ME_WITH_HTML_BIN: failingRenderer },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed with exit code 17/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

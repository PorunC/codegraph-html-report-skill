import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFrontmatter, selectPageLayout } from './report-layout.mjs';

const shortMarkdown = '## Summary\nA short section.\n\n```flow\nAPI -> Store: reads\n```';

test('overview stays compact and only sheets receive cols', () => {
  assert.deepEqual(selectPageLayout('overview', {}, '# Summary\n'.repeat(20)), { template: 'sheet', cols: 2 });
  assert.equal(layoutFrontmatter({ template: 'sheet', cols: 2 }), 'template: sheet\ncols: 2');
  assert.equal(layoutFrontmatter({ template: 'doc' }), 'template: doc');
});

test('small package report uses sheet; many areas and relationships use doc', () => {
  const singlePackage = { areas: [{ id: 'app' }], relationships: [] };
  const multiArea = {
    areas: Array.from({ length: 6 }, (_, index) => ({ id: `area-${index}` })),
    relationships: Array.from({ length: 5 }, () => ({})),
  };
  assert.equal(selectPageLayout('architecture', singlePackage, shortMarkdown).template, 'sheet');
  assert.equal(selectPageLayout('architecture', multiArea, shortMarkdown).template, 'doc');
});

test('many workflow steps or sections use doc while a short workflow stays a sheet', () => {
  const small = { flows: [{ steps: [{}, {}], edges: [{}, {}] }] };
  const larger = { flows: [{ steps: Array.from({ length: 8 }, () => ({})), edges: Array.from({ length: 7 }, () => ({})) }] };
  assert.equal(selectPageLayout('flows', small, shortMarkdown).template, 'sheet');
  assert.equal(selectPageLayout('flows', larger, shortMarkdown).template, 'doc');
  assert.equal(selectPageLayout('flows', small, '## One\n## Two\n## Three\n## Four').template, 'doc');
});

test('long details content uses doc', () => {
  assert.equal(selectPageLayout('details', {}, shortMarkdown).template, 'sheet');
  assert.equal(selectPageLayout('details', {}, '## scope\n'.repeat(7)).template, 'doc');
});

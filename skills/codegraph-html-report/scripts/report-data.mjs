import fs from 'node:fs';
import path from 'node:path';
import { layoutFrontmatter, selectPageLayout } from './report-layout.mjs';

const TOP_LEVEL_KEYS = [
  'schemaVersion', 'project', 'conclusions', 'areas', 'relationships', 'entryClues',
  'flows', 'extensionPoints', 'risks', 'unknowns', 'analysisLimits',
];
const BASIS_LABELS = { direct: '源码可直接确认', interpretation: '解释性判断' };
const RISK_LABELS = { low: '低', medium: '中', high: '高', unknown: '未评估' };

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkKeys(value, required, allowed, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是 JSON 对象。`);
    return false;
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${label} 缺少必填字段 ${key}。`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label} 包含不支持的字段 ${key}。`);
  }
  return true;
}

function checkText(value, label, errors) {
  if (!hasText(value)) errors.push(`${label} 必须是非空字符串。`);
}

function checkArray(value, label, errors, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组。`);
    return false;
  }
  if (value.length < minimum) errors.push(`${label} 至少需要 ${minimum} 项。`);
  if (value.length > maximum) errors.push(`${label} 最多允许 ${maximum} 项；请保留最重要内容，不要静默截断。`);
  return true;
}

function checkEvidenceList(value, label, errors, { requireDirect = false } = {}) {
  if (!checkArray(value, label, errors, 1, 3)) return;
  value.forEach((item, index) => checkEvidence(item, `${label}[${index}]`, errors));
  if (requireDirect && !value.some((item) => item?.basis === 'direct')) {
    errors.push(`${label} 至少需要一条 basis 为 direct 的源码依据，才能绘制这条关系。`);
  }
}

function checkEvidence(value, label, errors) {
  const keys = ['source', 'location', 'basis', 'note'];
  if (!checkKeys(value, keys, keys, label, errors)) return;
  checkText(value.source, `${label}.source`, errors);
  checkText(value.location, `${label}.location`, errors);
  checkText(value.note, `${label}.note`, errors);
  if (!['direct', 'interpretation'].includes(value.basis)) {
    errors.push(`${label}.basis 必须是 direct 或 interpretation。`);
  }
  if (hasText(value.source)) {
    const normalized = value.source.replaceAll('\\', '/');
    if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized) || normalized.split('/').includes('..')) {
      errors.push(`${label}.source 必须是项目内的相对路径，不能使用绝对路径或 ..。`);
    }
  }
}

function checkClaim(value, label, errors) {
  const keys = ['title', 'description', 'evidence'];
  if (!checkKeys(value, keys, keys, label, errors)) return;
  checkText(value.title, `${label}.title`, errors);
  checkText(value.description, `${label}.description`, errors);
  checkEvidenceList(value.evidence, `${label}.evidence`, errors);
}

function checkUniqueIds(items, label, errors) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (!hasText(item?.id)) continue;
    if (seen.has(item.id)) errors.push(`${label}[${index}].id 重复：${item.id}。`);
    seen.add(item.id);
  }
  return seen;
}

function checkSourceFiles(analysis, projectRoot, errors) {
  if (!projectRoot) return;
  let rootReal;
  try {
    rootReal = fs.realpathSync(projectRoot);
  } catch {
    errors.push(`项目目录不可读取：${projectRoot}`);
    return;
  }
  const sources = collectEvidence(analysis).map((item) => item.source);
  for (const source of new Set(sources.filter(hasText))) {
    const absolute = path.resolve(rootReal, ...source.replaceAll('\\', '/').split('/'));
    let real;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      errors.push(`依据文件不存在或不可读取：${source}`);
      continue;
    }
    const relative = path.relative(rootReal, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push(`依据文件必须位于项目目录内：${source}`);
    } else if (!fs.statSync(real).isFile()) {
      errors.push(`依据路径不是文件：${source}`);
    }
  }
}

export function collectEvidence(analysis) {
  if (!isRecord(analysis)) return [];
  const results = [];
  if (Array.isArray(analysis.project?.summaryEvidence)) results.push(...analysis.project.summaryEvidence);
  const take = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (Array.isArray(item?.evidence)) results.push(...item.evidence);
    }
  };
  take(analysis.conclusions);
  take(analysis.areas);
  take(analysis.relationships);
  take(analysis.entryClues);
  take(analysis.extensionPoints);
  take(analysis.risks);
  for (const flow of Array.isArray(analysis.flows) ? analysis.flows : []) {
    if (Array.isArray(flow?.purposeEvidence)) results.push(...flow.purposeEvidence);
    take(flow?.steps);
    take(flow?.edges);
  }
  return results;
}

/** Return all structural and project-local evidence errors without rendering. */
export function validateAnalysis(analysis, { projectRoot } = {}) {
  const errors = [];
  if (Buffer.byteLength(JSON.stringify(analysis ?? null), 'utf8') > 2_000_000) {
    errors.push('analysis JSON 超过 2 MB；请缩短说明并保留最重要的证据。');
    return errors;
  }
  if (!checkKeys(analysis, TOP_LEVEL_KEYS, TOP_LEVEL_KEYS, 'analysis', errors)) return errors;
  if (analysis.schemaVersion !== 1) errors.push('analysis.schemaVersion 必须为 1。');

  const projectKeys = ['name', 'summary', 'summaryEvidence', 'analysisScope'];
  if (checkKeys(analysis.project, projectKeys, projectKeys, 'project', errors)) {
    checkText(analysis.project.name, 'project.name', errors);
    checkText(analysis.project.summary, 'project.summary', errors);
    checkEvidenceList(analysis.project.summaryEvidence, 'project.summaryEvidence', errors);
    const scopeKeys = ['included', 'excluded', 'method'];
    if (checkKeys(analysis.project.analysisScope, scopeKeys, scopeKeys, 'project.analysisScope', errors)) {
      checkArray(analysis.project.analysisScope.included, 'project.analysisScope.included', errors, 1, 20);
      checkArray(analysis.project.analysisScope.excluded, 'project.analysisScope.excluded', errors, 0, 20);
      checkText(analysis.project.analysisScope.method, 'project.analysisScope.method', errors);
      for (const key of ['included', 'excluded']) {
        if (Array.isArray(analysis.project.analysisScope[key])) {
          analysis.project.analysisScope[key].forEach((text, index) => checkText(text, `project.analysisScope.${key}[${index}]`, errors));
        }
      }
    }
  }

  for (const key of ['conclusions', 'areas', 'relationships', 'entryClues', 'flows', 'extensionPoints', 'risks', 'unknowns', 'analysisLimits']) {
    const limits = {
      conclusions: 6, areas: 12, relationships: 14, entryClues: 8, flows: 5,
      extensionPoints: 8, risks: 8, unknowns: 10, analysisLimits: 8,
    };
    checkArray(analysis[key], key, errors, key === 'conclusions' || key === 'areas' || key === 'analysisLimits' ? 1 : 0, limits[key]);
  }

  if (Array.isArray(analysis.conclusions)) analysis.conclusions.forEach((item, index) => checkClaim(item, `conclusions[${index}]`, errors));

  const areaIds = Array.isArray(analysis.areas) ? checkUniqueIds(analysis.areas, 'areas', errors) : new Set();
  if (Array.isArray(analysis.areas)) {
    analysis.areas.forEach((area, index) => {
      const label = `areas[${index}]`;
      const keys = ['id', 'name', 'responsibility', 'evidence'];
      if (!checkKeys(area, keys, keys, label, errors)) return;
      for (const key of ['id', 'name', 'responsibility']) checkText(area[key], `${label}.${key}`, errors);
      checkEvidenceList(area.evidence, `${label}.evidence`, errors);
    });
  }

  if (Array.isArray(analysis.relationships)) {
    analysis.relationships.forEach((edge, index) => {
      const label = `relationships[${index}]`;
      const keys = ['from', 'to', 'label', 'evidence'];
      if (!checkKeys(edge, keys, keys, label, errors)) return;
      for (const key of ['from', 'to', 'label']) checkText(edge[key], `${label}.${key}`, errors);
      if (hasText(edge.from) && !areaIds.has(edge.from)) errors.push(`${label}.from 未匹配到 areas.id：${edge.from}。`);
      if (hasText(edge.to) && !areaIds.has(edge.to)) errors.push(`${label}.to 未匹配到 areas.id：${edge.to}。`);
      checkEvidenceList(edge.evidence, `${label}.evidence`, errors, { requireDirect: true });
    });
  }

  for (const key of ['entryClues', 'extensionPoints']) {
    if (Array.isArray(analysis[key])) analysis[key].forEach((item, index) => checkClaim(item, `${key}[${index}]`, errors));
  }

  if (Array.isArray(analysis.flows)) {
    analysis.flows.forEach((flow, index) => {
      const label = `flows[${index}]`;
      const keys = ['title', 'purpose', 'purposeEvidence', 'steps', 'edges', 'unknowns'];
      if (!checkKeys(flow, keys, keys, label, errors)) return;
      checkText(flow.title, `${label}.title`, errors);
      checkText(flow.purpose, `${label}.purpose`, errors);
      checkEvidenceList(flow.purposeEvidence, `${label}.purposeEvidence`, errors);
      checkArray(flow.steps, `${label}.steps`, errors, 1, 12);
      checkArray(flow.edges, `${label}.edges`, errors, 0, 20);
      checkArray(flow.unknowns, `${label}.unknowns`, errors, 0, 10);
      if (Array.isArray(flow.unknowns)) flow.unknowns.forEach((item, itemIndex) => checkText(item, `${label}.unknowns[${itemIndex}]`, errors));

      const stepIds = Array.isArray(flow.steps) ? checkUniqueIds(flow.steps, `${label}.steps`, errors) : new Set();
      if (Array.isArray(flow.steps)) {
        flow.steps.forEach((step, stepIndex) => {
          const stepLabel = `${label}.steps[${stepIndex}]`;
          const requiredStepKeys = ['id', 'label', 'description', 'evidence'];
          const stepKeys = [...requiredStepKeys, 'area'];
          if (!checkKeys(step, requiredStepKeys, stepKeys, stepLabel, errors)) return;
          for (const key of ['id', 'label', 'description']) checkText(step[key], `${stepLabel}.${key}`, errors);
          if ('area' in step) checkText(step.area, `${stepLabel}.area`, errors);
          checkEvidenceList(step.evidence, `${stepLabel}.evidence`, errors);
        });
      }
      if (Array.isArray(flow.edges)) {
        flow.edges.forEach((edge, edgeIndex) => {
          const edgeLabel = `${label}.edges[${edgeIndex}]`;
          const edgeKeys = ['from', 'to', 'label', 'evidence'];
          if (!checkKeys(edge, edgeKeys, edgeKeys, edgeLabel, errors)) return;
          for (const key of ['from', 'to', 'label']) checkText(edge[key], `${edgeLabel}.${key}`, errors);
          if (hasText(edge.from) && !stepIds.has(edge.from)) errors.push(`${edgeLabel}.from 未匹配到步骤 ID：${edge.from}。`);
          if (hasText(edge.to) && !stepIds.has(edge.to)) errors.push(`${edgeLabel}.to 未匹配到步骤 ID：${edge.to}。`);
          checkEvidenceList(edge.evidence, `${edgeLabel}.evidence`, errors, { requireDirect: true });
          for (const endpoint of [edge.from, edge.to]) {
            const step = Array.isArray(flow.steps) ? flow.steps.find((item) => item?.id === endpoint) : null;
            if (step && !step.evidence?.some((item) => item?.basis === 'direct')) {
              errors.push(`${edgeLabel} 连接的步骤 ${endpoint} 缺少 direct 源码依据，不能作为确定图节点。`);
            }
          }
        });
      }
    });
  }

  if (Array.isArray(analysis.risks)) {
    analysis.risks.forEach((risk, index) => {
      const label = `risks[${index}]`;
      const keys = ['title', 'description', 'severity', 'evidence'];
      if (!checkKeys(risk, keys, keys, label, errors)) return;
      checkText(risk.title, `${label}.title`, errors);
      checkText(risk.description, `${label}.description`, errors);
      if (!Object.hasOwn(RISK_LABELS, risk.severity)) errors.push(`${label}.severity 必须是 low、medium、high 或 unknown。`);
      checkEvidenceList(risk.evidence, `${label}.evidence`, errors);
    });
  }

  if (Array.isArray(analysis.unknowns)) {
    analysis.unknowns.forEach((unknown, index) => {
      const label = `unknowns[${index}]`;
      const required = ['question', 'reason'];
      const allowed = [...required, 'checked'];
      if (!checkKeys(unknown, required, allowed, label, errors)) return;
      checkText(unknown.question, `${label}.question`, errors);
      checkText(unknown.reason, `${label}.reason`, errors);
      if ('checked' in unknown) {
        checkArray(unknown.checked, `${label}.checked`, errors);
        if (Array.isArray(unknown.checked)) unknown.checked.forEach((item, itemIndex) => checkText(item, `${label}.checked[${itemIndex}]`, errors));
      }
    });
  }

  if (Array.isArray(analysis.analysisLimits)) analysis.analysisLimits.forEach((item, index) => checkText(item, `analysisLimits[${index}]`, errors));
  checkSourceFiles(analysis, projectRoot, errors);
  return errors;
}

function md(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('*', '\\*').replaceAll('_', '\\_')
    .replaceAll('{', '\\{').replaceAll('}', '\\}').replaceAll('[', '\\[').replaceAll(']', '\\]')
    .replaceAll('(', '\\(').replaceAll(')', '\\)').replaceAll('#', '\\#').replaceAll('+', '\\+')
    .replaceAll('-', '\\-').replaceAll('.', '\\.').replaceAll('!', '\\!').replaceAll('|', '\\|')
    .replaceAll('\n', ' ').replaceAll('\r', ' ').trim();
}

function flowToken(value) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replaceAll('-->', '⇢').replaceAll('->', '→')
    .replaceAll(':', '：').replaceAll('[', '［').replaceAll(']', '］').trim() || '未命名';
  if (/^[A-Za-z0-9_.$/-]+$/.test(text)) return text;
  if (!text.includes(']')) return `[${text.replaceAll(']', '］')}]`;
  if (!text.includes(')')) return `(${text.replaceAll(')', '）')})`;
  return `{${text.replaceAll('}', '］')}}`;
}

function quoteYaml(value) {
  return JSON.stringify(String(value ?? ''));
}

function evidenceLines(evidence, reference = null) {
  const visible = evidence.slice(0, 3);
  const lines = visible.map((item) => {
    const basis = BASIS_LABELS[item.basis] || item.basis;
    const source = String(item.source).replaceAll('`', 'ˋ').replace(/[\r\n]+/g, ' ');
    return `- ${reference ? `[${reference}] ` : ''}${basis}：\`${source}\` — ${md(item.note)}`;
  });
  if (evidence.length > visible.length) lines.push(`- 另有 ${evidence.length - visible.length} 条依据未展开。`);
  return lines;
}

function navigationMarkdown(currentKey, pages) {
  const entries = [
    ['overview', '总览'], ['architecture', '架构图'], ['flows', '关键流程'], ['details', '证据与边界'],
  ];
  return `**报告导航：** ${entries.map(([key, label]) => key === currentKey
    ? `**${label}**`
    : `[${label}](${encodeURI(path.basename(pages[key]))})`).join('　·　')}`;
}

function pageDocument(analysis, pages, key, title, subtitle, body) {
  const layout = selectPageLayout(key, analysis, body);
  return `---
${layoutFrontmatter(layout)}
theme: auto
lang: zh-CN
title: ${quoteYaml(`${analysis.project.name} · ${title}`)}
subtitle: ${quoteYaml(`${subtitle} · 源码阅读整理`)}
---
${navigationMarkdown(key, pages)}

${body}
`;
}

function claimsMarkdown(items, emptyMessage) {
  if (!items.length) return emptyMessage;
  const lines = [];
  for (const item of items) {
    lines.push(`### ${md(item.title)}`, '', md(item.description), '', '**依据**', ...evidenceLines(item.evidence), '');
  }
  return lines.join('\n').trimEnd();
}

function architectureDiagram(analysis) {
  if (!analysis.relationships.length) {
    return '没有提供有源码依据的区域关系，因此不绘制连线。区域职责仍可在上方逐项阅读。';
  }
  const areaById = new Map(analysis.areas.map((area) => [area.id, area]));
  const lines = ['```flow LR'];
  const references = [];
  for (const [index, relation] of analysis.relationships.entries()) {
    const ref = index + 1;
    const label = `${md(relation.label)} · 依据 ${ref}`;
    lines.push(`${flowToken(areaById.get(relation.from).name)} -> ${flowToken(areaById.get(relation.to).name)}: ${label}`);
    references.push(...evidenceLines(relation.evidence, ref));
  }
  lines.push('```', '', '每条连线都至少有一条直接源码依据。箭头只表示已注明的源码关系，不代表完整运行顺序。解释性判断保留在文字结论中，不作为确定的关系边。', '', '**连线依据**', ...references);
  return lines.join('\n');
}

function areasMarkdown(areas) {
  const tree = ['```tree list', '项目 | 主要代码区域'];
  for (const area of areas) tree.push(`  ${md(area.name)} | ${md(area.responsibility)}`);
  tree.push('```');
  const descriptions = areas.flatMap((area) => [
    `### ${md(area.name)}`, '', md(area.responsibility), '', '**职责依据**', ...evidenceLines(area.evidence), '',
  ]);
  return [...tree, '', ...descriptions].join('\n').trimEnd();
}

function flowMarkdown(flow) {
  const lines = [`### ${md(flow.title)}`, '', `**用途说明：** ${md(flow.purpose)}`, '', '**用途依据**', ...evidenceLines(flow.purposeEvidence), '', '#### 源码步骤', ''];
  flow.steps.forEach((step, index) => {
    lines.push(`- **步骤 ${index + 1}：** ${md(step.description)}`);
    lines.push(...evidenceLines(step.evidence));
  });
  if (flow.steps.some((step) => !step.evidence.some((item) => item.basis === 'direct'))) {
    lines.push('', '部分步骤只得到解释性支持；这些判断不作为确定的流程关系。');
  }
  if (!flow.edges.length) {
    lines.push('', '这些步骤有各自的源码依据，但没有提供足以确认步骤间关系的依据，因此不绘制流程连线。');
  } else {
    const stepById = new Map(flow.steps.map((step) => [step.id, step]));
    const edgeReferences = [];
    lines.push('', '#### 有依据的步骤关系', '', '```flow LR');
    for (const [index, edge] of flow.edges.entries()) {
      const ref = index + 1;
      const label = `${md(edge.label)} · 依据 ${ref}`;
      const from = stepById.get(edge.from);
      const to = stepById.get(edge.to);
      const fromLabel = `${from.area ? `${from.area} · ` : ''}${from.label}`;
      const toLabel = `${to.area ? `${to.area} · ` : ''}${to.label}`;
      lines.push(`${flowToken(fromLabel)} -> ${flowToken(toLabel)}: ${label}`);
      edgeReferences.push(...evidenceLines(edge.evidence, ref));
    }
    lines.push('```', '', '每条连线都至少有一条直接源码依据。图中没有表达的条件和时序无法确认。', '', '**连线依据**', ...edgeReferences);
  }
  if (flow.unknowns.length) lines.push('', '**本流程尚无法确认**', ...flow.unknowns.map((item) => `- ${md(item)}`));
  return lines.join('\n');
}

function scopeMarkdown(analysis) {
  const scope = analysis.project.analysisScope;
  return [
    `**纳入范围：** ${scope.included.map(md).join('、')}`,
    `**排除范围：** ${scope.excluded.length ? scope.excluded.map(md).join('、') : '未单独排除目录；实际阅读范围见纳入项。'}`,
    `**分析方式：** ${md(scope.method)}`,
  ].join('\n\n');
}

function detailsMarkdown(analysis) {
  const entry = claimsMarkdown(analysis.entryClues, '没有记录可由源码支持的入口线索。');
  const extensions = claimsMarkdown(analysis.extensionPoints, '没有记录可由源码支持的扩展点。');
  const risks = analysis.risks.length ? analysis.risks.map((risk) => [
    `### ${md(risk.title)} · 风险${RISK_LABELS[risk.severity]}`,
    '', md(risk.description), '', '**依据**', ...evidenceLines(risk.evidence), '',
  ].join('\n')).join('\n') : '没有记录可由源码支持的主要风险。';
  const unknowns = analysis.unknowns.length ? analysis.unknowns.map((item) => [
    `- **${md(item.question)}** ${md(item.reason)}`,
    ...(item.checked?.length ? [`  - 已检查：${item.checked.map(md).join('、')}`] : []),
  ].join('\n')).join('\n') : '本次整理没有另外记录的未知项。';
  const limits = analysis.analysisLimits.map((item) => `- ${md(item)}`).join('\n');
  return `# 证据与分析边界

此页列出本次阅读覆盖范围、证据类型、风险和无法确认的问题。结论只适用于已阅读的文件和文档。

## 分析范围 {span=2}

${scopeMarkdown(analysis)}

## 证据类型 {span=2}

- **源码可直接确认**：依据指向具体源码或文档位置，文字描述该处直接表达的行为。
- **解释性判断**：依据仍来自项目文件，但结论需要结合上下文理解；这类判断写在说明中，不画成确定关系边。
- 每条图中连线至少需要一条直接源码依据；不确定行为会保留在未知项中。

## 入口线索 {span=2}

${entry}

## 扩展点 {span=2}

${extensions}

## 风险 {span=2}

${risks}

## 未知项 {span=2}

${unknowns}

## 本次分析限制 {span=2}

${limits}`;
}

/** Build the four Markdown pages from validated structured source findings. */
export function buildPageDrafts(analysis, pages) {
  const conclusionItems = analysis.conclusions.map((item) => [
    `### ${md(item.title)}`, '', md(item.description), '', '**依据**', ...evidenceLines(item.evidence), '',
  ].join('\n')).join('\n');
  const pageLinks = [
    ['architecture', '架构图', '查看主要代码区域、职责和有依据的模块关系。'],
    ['flows', '关键流程', '按源码依据理解主要步骤、关系和未知项。'],
    ['details', '证据与边界', '核对分析范围、风险、扩展点和证据限制。'],
  ].map(([key, title, description]) => `| [${title}](${encodeURI(path.basename(pages[key]))}) | ${description} |`).join('\n');

  const overview = `# 项目总览

## 项目结论 {span=2}

${md(analysis.project.summary)}

**摘要依据**

${evidenceLines(analysis.project.summaryEvidence).join('\n')}

## 本次分析范围 {span=2}

${scopeMarkdown(analysis)}

## 主要发现 {span=2}

${conclusionItems}

## 阅读路线 {span=2}

| 页面 | 适合回答的问题 |
| --- | --- |
${pageLinks}`;

  const architecture = `# 项目架构

先看区域职责，再查看有源码依据的区域关系。没有关系数据时保留职责说明，不补画推测连线。

## 主要代码区域 {span=2}

${areasMarkdown(analysis.areas)}

## 区域关系 {span=2}

${architectureDiagram(analysis)}

关系来自源码阅读整理；每条连线均有直接依据，解释性判断只在文字中标注。图不表示运行时的完整调用顺序。`;

  const flows = `# 关键流程

流程按源码阅读整理。每个步骤和每条连线都附有可核对的依据；图中没有表达的关系不作补全。

${analysis.flows.length
    ? analysis.flows.map(flowMarkdown).join('\n\n---\n\n')
    : '本次分析没有足够证据整理出关键流程，因此不生成推测流程图。'}

## 阅读边界

这些流程是基于所列文件的源码阅读整理，不是动态运行记录。源码中的明确顺序可作为直接依据；框架回调、动态分派、配置注入和未阅读区域可能改变实际路径。报告只表达 JSON 中列出的步骤和关系。`;

  const details = detailsMarkdown(analysis);
  return {
    overview: pageDocument(analysis, pages, 'overview', '项目总览', '项目范围、结论和阅读路线', overview),
    architecture: pageDocument(analysis, pages, 'architecture', '项目架构', '主要区域职责与有依据的关系', architecture),
    flows: pageDocument(analysis, pages, 'flows', '关键流程', '按源码依据整理的流程与交互', flows),
    details: pageDocument(analysis, pages, 'details', '证据与边界', '来源、范围、风险和未知项', details),
  };
}

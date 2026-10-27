#!/usr/bin/env node

/** Render an evidence-backed source analysis JSON document as offline HTML. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPageDrafts, validateAnalysis } from './report-data.mjs';

const REPORT_PAGES = [
  { key: 'overview', filename: 'index.html' },
  { key: 'architecture', filename: 'architecture.html' },
  { key: 'flows', filename: 'call-flows.html' },
  { key: 'details', filename: 'details.html' },
];

function usage() {
  console.log(`Usage: generate_report.mjs --analysis <source-analysis.json> [options]

Options:
  --analysis <path>  Evidence-backed analysis JSON (required)
  --project <path>   Project root used to validate evidence paths (default: current directory)
  --output <path>    Report directory or overview HTML path (default: <project>/.codewiki/reports/source-analysis-report-<timestamp>/)
  --draft <path>     Keep Markdown drafts in this directory (or beside this .md path)
  --help             Show this help
`);
}

function parseArgs(argv) {
  const args = { project: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--analysis') args.analysis = argv[++index];
    else if (arg === '--project' || arg === '-p') args.project = argv[++index];
    else if (arg === '--output' || arg === '-o') args.output = argv[++index];
    else if (arg === '--draft') args.draft = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.analysis) throw new Error('--analysis is required. Create a source-analysis.json using references/source-analysis.schema.json.');
  return args;
}

function ensureProject(projectArg) {
  const root = path.resolve(projectArg || process.cwd());
  const stat = fs.statSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`Project directory does not exist: ${root}`);
  fs.accessSync(root, fs.constants.R_OK);
  return root;
}

function loadAnalysis(analysisArg, projectRoot) {
  const analysisPath = path.resolve(analysisArg);
  let source;
  try {
    source = fs.readFileSync(analysisPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read --analysis file ${analysisPath}: ${error.message}`);
  }
  let analysis;
  try {
    analysis = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid analysis JSON in ${analysisPath}: ${error.message}`);
  }
  const errors = validateAnalysis(analysis, { projectRoot });
  if (errors.length) {
    const list = errors.slice(0, 30).map((item) => `  - ${item}`).join('\n');
    const extra = errors.length > 30 ? `\n  - ... ${errors.length - 30} more validation errors` : '';
    throw new Error(`Analysis JSON is invalid:\n${list}${extra}\nSee references/source-analysis.schema.json and correct the cited project-relative evidence paths.`);
  }
  return analysis;
}

function resolveOutputPaths(root, outputArg) {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const requested = path.resolve(outputArg || path.join(root, '.codewiki', 'reports', `source-analysis-report-${timestamp}`));
  const extension = path.extname(requested);
  if (extension.toLowerCase() === '.html') {
    const stem = path.basename(requested, extension);
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
    const directory = path.join(root, '.codewiki', 'tmp', `source-analysis-report-${pid}`);
    return {
      directory,
      cleanup: true,
      pages: Object.fromEntries(REPORT_PAGES.map(({ key, filename }) => [key, path.join(directory, filename.replace(/\.html$/, '.md'))])),
    };
  }
  const requested = path.resolve(draftArg);
  if (path.extname(requested).toLowerCase() === '.md') {
    const stem = path.basename(requested, path.extname(requested));
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

function findRenderer() {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configured = process.env.ANSWER_ME_WITH_HTML_BIN;
  if (configured && fs.existsSync(configured)) return { command: process.execPath, argsPrefix: [configured] };
  const local = path.join(skillRoot, 'node_modules', 'answer-me-with-html', 'bin', 'am.js');
  if (fs.existsSync(local)) return { command: process.execPath, argsPrefix: [local] };
  return null;
}

function renderMarkdown(renderer, draftPath, outputPath) {
  const result = spawnSync(renderer.command, [...renderer.argsPrefix, 'render', draftPath, '-o', outputPath, '--no-open'], { encoding: 'utf8' });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(`Cannot start answer-me-with-html: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`answer-me-with-html failed with exit code ${result.status}`);
}

function sanitizeOfflineHtml(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace(/\s+(?:href|src|srcset|poster|data)=["'][^"']*(?:https?:)?\/\/[^"']*["']/gi, '');
  fs.writeFileSync(filePath, html, 'utf8');
  if (/(?:href|src|srcset|poster|data)=["'][^"']*(?:https?:)?\/\//i.test(html)
    || /url\(\s*["']?(?:https?:)?\/\//i.test(html)
    || /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i.test(html)) {
    throw new Error('Generated HTML contains an external resource reference.');
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
        throw new Error(`Generated page has an invalid local link: ${pageName} → ${href}`);
      }
    }
  }
}

function renderPageSet(drafts, output, expectedTitles) {
  const stagingDirectory = path.join(output.directory, `.source-analysis-report-${process.pid}-staging`);
  const renderer = findRenderer();
  if (!renderer) throw new Error('answer-me-with-html is not installed. Run npm install in the codegraph-html-report skill directory.');
  fs.rmSync(stagingDirectory, { recursive: true, force: true });
  fs.mkdirSync(stagingDirectory, { recursive: true });
  try {
    for (const { key } of REPORT_PAGES) {
      const stagedHtml = path.join(stagingDirectory, path.basename(output.pages[key]));
      renderMarkdown(renderer, drafts[key], stagedHtml);
      if (!fs.existsSync(stagedHtml) || fs.statSync(stagedHtml).size === 0) throw new Error(`Renderer did not create a valid page: ${key}`);
      sanitizeOfflineHtml(stagedHtml);
      const html = fs.readFileSync(stagedHtml, 'utf8');
      if (!/<title>[^<]+<\/title>/i.test(html) || !html.includes(expectedTitles[key])) {
        throw new Error(`Page title is missing or incomplete: ${key}`);
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

function expectedTitle(analysis, title) {
  return `${analysis.project.name} · ${title}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = ensureProject(args.project);
  const analysis = loadAnalysis(args.analysis, projectRoot);
  const output = resolveOutputPaths(projectRoot, args.output);
  const drafts = resolveDraftPaths(projectRoot, args.draft, process.pid);
  fs.mkdirSync(output.directory, { recursive: true });
  fs.mkdirSync(drafts.directory, { recursive: true });
  try {
    const pageDrafts = buildPageDrafts(analysis, output.pages);
    for (const { key } of REPORT_PAGES) fs.writeFileSync(drafts.pages[key], pageDrafts[key], 'utf8');
    const expectedTitles = {
      overview: expectedTitle(analysis, '项目总览'),
      architecture: expectedTitle(analysis, '项目架构'),
      flows: expectedTitle(analysis, '关键流程'),
      details: expectedTitle(analysis, '证据与边界'),
    };
    renderPageSet(drafts.pages, output, expectedTitles);
    console.log(JSON.stringify({
      output: output.pages.overview,
      reportDirectory: output.directory,
      pages: output.pages,
      project: analysis.project.name,
      analysisScope: analysis.project.analysisScope,
      warnings: [],
    }, null, 2));
  } finally {
    if (drafts.cleanup) fs.rmSync(drafts.directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`source-analysis-html-report: ${error.message}`);
  process.exitCode = 1;
});

# Project HTML Analysis Skill

一个用于 Codex 的本地 Skill：由调用 Skill 的 Agent 阅读项目源码和文档，整理有依据的架构与流程分析，再由本地脚本生成四页离线 HTML 报告。

## 能力

- 阅读 README、配置、关键目录和实现，按实际阅读范围说明项目职责与结论
- 生成项目总览、架构、关键流程、证据与边界四个互相导航的页面
- 只将带有具体源码依据的区域关系画成图；保留未知项，不推断缺失行为
- 生成自包含 HTML，可从总览页离线阅读
- 在本机处理，不运行被分析项目的脚本、不上传源码、不启动服务

分析由 Agent 阅读源码完成。生成器只校验 `source-analysis.json`、生成 Markdown 并调用本地 HTML 渲染器；不调用模型 API，不安装、运行或要求 CodeGraph。它不创建、更新或删除项目中已有的 `.codegraph/`。

## 安装和调用

完整安装说明见[安装与使用指南](docs/INSTALL.md)。安装后，在目标项目中调用：

```text
使用 $codegraph-html-report 阅读当前项目源码，整理有依据的架构和关键流程，并生成完整的离线 HTML 分析报告。
```

默认总览页位于：

```text
.codewiki/reports/source-analysis-report-<timestamp>/index.html
```

## 直接运行渲染器

命令行只负责渲染已完成的结构化分析，不代替 Agent 阅读源码。分析 JSON 格式见 [source-analysis.schema.json](skills/codegraph-html-report/references/source-analysis.schema.json)。

```bash
npm install --prefix skills/codegraph-html-report
node skills/codegraph-html-report/scripts/generate_report.mjs \
  --project /path/to/project \
  --analysis /path/to/source-analysis.json \
  --output /path/to/project/.codewiki/reports/my-report
```

生成四个页面：

- `index.html`：项目结论、分析范围和阅读路线
- `architecture.html`：主要区域职责和有依据的区域关系
- `call-flows.html`：有源码依据的关键流程步骤与关系
- `details.html`：分析范围、入口线索、扩展点、风险、证据限制和未知项

证据以精简的项目相对路径附在相关结论旁，不生成冗长的文件或代码位置清单。图只展示分析 JSON 明确提供且通过校验的关系。输出页之间使用相对链接，不引用外部网页资源。

## 仓库结构

```text
.
├── DESIGN.md
├── docs/INSTALL.md
└── skills/codegraph-html-report/
    ├── SKILL.md
    ├── agents/openai.yaml
    ├── package.json
    ├── references/
    │   ├── report-format.md
    │   └── source-analysis.schema.json
    └── scripts/
        ├── generate_report.mjs
        ├── report-data.mjs
        ├── report-layout.mjs
        └── *.test.mjs
```

Skill 标识 `$codegraph-html-report` 保留，以避免破坏现有调用方式。

## 依赖与验证

- Node.js `>=20`
- Skill 目录中的固定版本 `answer-me-with-html`
- 不依赖 CodeGraph，也不安装目标项目依赖

运行本地测试：

```bash
node --test skills/codegraph-html-report/scripts/*.test.mjs
```

更多说明见 [设计文档](DESIGN.md)、[Skill 文件](skills/codegraph-html-report/SKILL.md) 和[报告格式说明](skills/codegraph-html-report/references/report-format.md)。

# CodeGraph HTML Report Skill 设计

## 目标

把项目分析做成一个 Codex Skill。用户调用 `$codegraph-html-report` 后，Skill 在本地读取当前项目，调用 CodeGraph 分析源码，再用 Answer me with HTML 渲染一份完整、可离线阅读的 HTML 架构报告。

典型调用：

```text
使用 $codegraph-html-report 分析这个项目，并生成完整的 HTML 架构文档。
```

默认生成一个报告目录，总览页面位于：

```text
.codewiki/reports/codegraph-report-<timestamp>/index.html
```

## 运行边界

- 只在本机运行，不启动 HTTP 服务，不跨机器访问。
- 不上传源码，不执行被分析项目的脚本，不安装被分析项目的依赖。
- CodeGraph 只写项目自己的 `.codegraph/` 索引目录。
- 总览和架构页面使用模块级图表；关键调用流程图在节点上保留少量源码函数名，不在说明文字中重复列名，也不列具体文件或代码位置。
- 每个 HTML 页面都内嵌 CSS、SVG 和脚本，页面间使用相对链接，脱离网络也可直接打开。

## Skill 结构

```text
skills/codegraph-html-report/
├── SKILL.md
├── agents/openai.yaml
├── package.json
├── package-lock.json
├── references/
│   ├── codegraph-api.md
│   └── report-format.md
└── scripts/
    └── generate_report.mjs
```

### SKILL.md

定义调用场景、输出要求和执行流程。Skill 被调用后会：

1. 确认项目路径和 Node.js 版本。
2. 阅读 README、包管理文件、配置文件和明显入口，形成架构补充说明。
3. 运行报告生成脚本。
4. 检查总览与所有子页完整、页面导航可用、可离线打开，并输出总览路径。

### generate_report.mjs

负责可重复的分析和渲染：

1. 用 `CodeGraph.isInitialized()` 判断是否已有索引。
2. 使用 `CodeGraph.open()` 打开已有索引，或用 `CodeGraph.init()` 建立索引。
3. 提取统计、入口候选、模块聚合关系、关键下游路径、影响范围和未解析引用。
4. 生成总览、架构、关键函数调用流程、影响与边界四份 Markdown 草稿。
5. 调用本地 `answer-me-with-html` CLI，分别渲染为相互链接的 HTML。
6. 检查页面标题、本地相对导航、文件大小和外部资源引用。
7. 关闭 CodeGraph 并清理临时草稿。

## 报告内容

报告目录包含以下页面：

- `index.html`：项目规模、区域目录图、入口区域、架构速览和子页导航。
- `architecture.html`：项目目录、模块依赖、入口和跨模块流程概览。
- `call-flows.html`：最多三条关键下游函数调用图；节点使用源码函数名，模块名作为上下文。
- `details.html`：静态影响图、未解析引用图和分析限制。

### 可读性约束

- 总览和架构图不展开函数清单；只有关键流程子页显示源码函数名，不附文件路径或行号列表。
- 流程图只在节点上按模块标记关键函数名，用中文解释调用边和分支，并明确静态分析边界；正文不重复列举函数清单。
- 目录图、架构图、关键调用图、静态影响图和未解析引用图分布在独立页面，避免把所有信息堆在一页。
- 没有可信关系时解释原因，不生成空图或推测连线。

## 默认限制

- 架构图最多 8 个模块、14 条关系。
- 最多 3 条入口路径，每条最多 10 个内部节点、14 条边；关键流程页显示筛选后的函数级关系。
- 静态影响图最多 8 个模块、14 条关系。
- 未解析边界最多聚合 12 个未解析引用。
- `--depth` 支持 1 到 6，默认 2。

超出限制时必须在报告里明确说明，不能静默丢弃关系。

## 可选参数

```bash
node skills/codegraph-html-report/scripts/generate_report.mjs \
  --project ./project \
  --output ./project-report \
  --symbol main \
  --depth 2 \
  --scope full \
  --supplement /tmp/architecture-notes.md
```

- `--scope overview`：只生成总览和架构内容，关键流程页会说明未展开调用分析。
- `--scope symbol --symbol <name>`：围绕指定符号生成报告。
- `--supplement <md>`：加入 Skill 根据项目文档和源码撰写的架构说明。

## 依赖

Skill 锁定以下版本：

- `@colbymchenry/codegraph@1.6.2`
- `answer-me-with-html@76c3c6d`（GitHub 固定 commit 的 tarball，因为该项目当前不是 npm registry 包）
- Node.js `>=22.5`

依赖安装在 Skill 自己的目录中，不进入被分析项目的依赖树。

## 已验证行为

在当前 `codewiki` 项目上执行了完整流程：

- CodeGraph 成功建立/更新索引。
- 成功生成总览、架构、函数调用流程、影响与边界四个 HTML 页面。
- 页面导航使用相对链接，各页面可以直接离线打开，没有外部资源引用。
- 生成器通过 Node.js 语法检查，并在多模块示例项目上验证页面内容和调用图命名。

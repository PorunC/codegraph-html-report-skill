# CodeGraph HTML Report Skill 设计

## 目标

把项目分析做成一个 Codex Skill。用户调用 `$codegraph-html-report` 后，Skill 在本地读取当前项目，调用 CodeGraph 分析源码，再用 Answer me with HTML 渲染一份完整、可离线阅读的 HTML 架构报告。

典型调用：

```text
使用 $codegraph-html-report 分析这个项目，并生成完整的 HTML 架构文档。
```

默认报告输出到：

```text
.codewiki/reports/codegraph-report-<timestamp>.html
```

## 运行边界

- 只在本机运行，不启动 HTTP 服务，不跨机器访问。
- 不上传源码，不执行被分析项目的脚本，不安装被分析项目的依赖。
- CodeGraph 只写项目自己的 `.codegraph/` 索引目录。
- 报告只嵌入必要的源码片段、统计和图数据。
- HTML 内嵌 CSS、SVG 和脚本，生成后可以脱离网络直接打开。

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
4. 检查 HTML 文件完整、可离线打开并输出路径。

### generate_report.mjs

负责可重复的分析和渲染：

1. 用 `CodeGraph.isInitialized()` 判断是否已有索引。
2. 使用 `CodeGraph.open()` 打开已有索引，或用 `CodeGraph.init()` 建立索引。
3. 提取统计、入口候选、模块聚合关系、关键下游路径、路径证据、影响范围和未解析引用。
4. 生成 Answer me with HTML 格式的 Markdown 草稿。
5. 调用本地 `answer-me-with-html` CLI 生成 HTML。
6. 删除远程 `href/src`，检查标题、文件大小和外部资源引用。
7. 关闭 CodeGraph 并清理临时草稿。

## 报告内容

生成的 HTML 包含以下面板：

1. 项目概览：文件、语言、框架和索引状态。
2. 入口候选：入口位置及 CodeGraph 选择依据。
3. 模块架构：用模块聚合 API 生成主要模块和高置信度关系。
4. 关键调用路径：每个入口独立向下游展开，控制节点和边数量。
5. 路径证据：只展示关键路径中的少量源码片段。
6. 影响范围：主入口的静态影响节点。
7. 未解析引用：只展示关键路径相关的未解析引用。
8. 分析限制：排除文件、图折叠、源码片段限制和静态分析边界。

### 可读性约束

- 函数调用图使用 CodeGraph 节点的源码名称（`node.name`），不使用节点 ID、哈希或内部合成名称。
- 同名函数在图和路径表中追加项目相对文件路径与起始行号；其他位置优先使用短名称，避免把完整限定名铺满页面。
- 图边和入口选择依据转换为读者能直接理解的文字，例如 `calls`、`depends on`、`exported entry` 和 `no indexed callers`。
- 概览模式不展开调用路径、源码证据、影响范围和未解析引用；没有内容的面板不输出。

## 默认限制

- 架构图最多 8 个模块、14 条关系。
- 最多 3 条入口路径，每条最多 10 个节点、14 条边。
- 路径证据最多 12 个符号。
- 单个源码片段最多 20 行。
- 未解析引用最多展示 12 行。
- `--depth` 支持 1 到 6，默认 2。

超出限制时必须在报告里明确说明，不能静默丢弃关系。

## 可选参数

```bash
node skills/codegraph-html-report/scripts/generate_report.mjs \
  --project ./project \
  --output ./project-report.html \
  --symbol main \
  --depth 2 \
  --scope full \
  --supplement /tmp/architecture-notes.md
```

- `--scope overview`：只生成概览和结构，跳过调用图展开。
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
- 成功生成以项目摘要、模块架构和关键调用路径为主的 HTML。
- HTML 文件可独立打开，未保留外部脚本、样式或资源引用。
- 生成器通过 Node.js 语法检查，并在当前仓库和多模块示例项目上完成报告冒烟测试。

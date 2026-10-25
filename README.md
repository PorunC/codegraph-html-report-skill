# CodeGraph HTML Report Skill

一个用于 Codex 的本地 Skill：调用 [CodeGraph](https://colbymchenry.github.io/codegraph/reference/api/) 分析源码，再用 [Answer me with HTML](https://github.com/QingYunA/answer-me-with-html) 生成可离线阅读的 HTML 架构文档。

它适合需要快速了解陌生项目、查看函数调用图、梳理模块依赖，或交付一份可搜索、可分享的源码分析文档的场景。

## 功能

- 一键分析本地项目的文件、语言、框架和入口信息
- 只挑选重要模块，生成紧凑的架构图
- 按入口分别生成 1–3 条关键下游调用路径
- 调用图使用源码中的函数名；同名函数自动附加文件路径和行号
- 展示路径涉及的符号、文件路径、行号和少量源码证据
- 报告未解析引用、索引状态和截断限制
- 生成单文件 HTML，内嵌样式、图形和脚本，保存后可直接用浏览器打开
- 只在本机读取项目，不启动 HTTP 服务、不上传源码、不运行被分析项目的脚本

## 快速开始

### 1. 安装 Skill

本仓库是一个 Skill 源码仓库，Skill 本体位于 `skills/codegraph-html-report/`。完整的安装方式见 [安装与使用指南](docs/INSTALL.md)。

在 Codex 的 Skill 目录中安装后，先进入需要分析的项目目录，再直接调用：

```text
使用 $codegraph-html-report 分析当前项目，并生成完整的 HTML 架构文档。
```

指定项目、入口符号和输出路径：

```text
使用 $codegraph-html-report 分析 /path/to/project，围绕 main 生成调用图，并将报告保存到 /path/to/project/docs/codegraph.html。
```

默认报告位置：

```text
.codewiki/reports/codegraph-report-<timestamp>.html
```

生成后直接用浏览器打开这个 HTML 文件即可，不需要启动服务。

## 直接运行命令行脚本

如果不通过 Codex 调用 Skill，也可以直接运行生成器。先在 Skill 目录安装锁定的依赖：

```bash
cd skills/codegraph-html-report
npm install
```

然后分析一个本地项目：

```bash
node skills/codegraph-html-report/scripts/generate_report.mjs \
  --project ./path/to/project \
  --output ./path/to/project/.codewiki/reports/codegraph.html
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--project <path>` | 项目目录，默认是当前目录 |
| `--output <path>` | HTML 输出路径，默认写入 `.codewiki/reports/` |
| `--symbol <name>` | 指定调用图的焦点符号，例如 `main` 或 `App.run` |
| `--depth <1-6>` | 调用图和影响范围的遍历深度，默认 `2` |
| `--scope full` | 完整报告，默认模式 |
| `--scope overview` | 只生成概览和项目结构，不展开调用图 |
| `--scope symbol --symbol <name>` | 围绕指定符号生成报告 |
| `--supplement <md>` | 合并一份基于项目源码整理的架构说明 |
| `--draft <path>` | 保留中间 Markdown 草稿，默认会自动清理 |
| `--help` | 查看命令帮助 |

例如，围绕 `main` 展开三层调用关系：

```bash
node skills/codegraph-html-report/scripts/generate_report.mjs \
  --project ./my-project \
  --symbol main \
  --depth 3 \
  --scope symbol \
  --output ./my-project/codegraph-report.html
```

## 报告包含什么

生成的 HTML 包含以下内容：

1. 项目概览、索引状态、语言和检测到的框架
2. 入口候选及其来源
3. 主要模块之间的高置信度关系
4. 每个入口单独的关键下游调用路径，节点使用源码函数名
5. 路径涉及的少量源码证据
6. 选定入口的静态影响范围
7. 未解析引用、排除项和分析限制

报告展示的是静态源码图。动态分派、反射、生成代码和外部依赖内部实现可能无法解析，调用边也不等于运行时一定会执行的路径。

报告中的 CodeGraph ID 只用于内部查询，不会直接展示。函数重名时，图节点会补充项目相对路径和起始行号，帮助读者区分不同定义。

## 默认限制

为保证报告可读，脚本默认限制如下：

- 架构图最多 8 个模块、14 条关系
- 最多展示 3 条入口路径，每条最多 10 个节点、14 条边
- 路径证据最多 12 个符号
- 每个源码片段最多 20 行
- 未解析引用最多展示 12 行
- `--depth` 允许 `1` 到 `6`

达到限制时，报告会在“分析限制”面板中明确提示。

## 项目结构

```text
.
├── DESIGN.md
├── docs/
│   └── INSTALL.md
└── skills/
    └── codegraph-html-report/
        ├── SKILL.md
        ├── agents/openai.yaml
        ├── package.json
        ├── package-lock.json
        ├── references/
        └── scripts/generate_report.mjs
```

- `SKILL.md`：Codex 的调用条件、执行边界和分析工作流
- `scripts/generate_report.mjs`：CodeGraph 提取和 HTML 生成器
- `references/`：CodeGraph API 和报告格式参考
- `docs/INSTALL.md`：安装、调用、命令行和故障排查指南
- `DESIGN.md`：项目设计文档

## 依赖

- Node.js `>=22.5`
- `@colbymchenry/codegraph@1.6.2`
- 固定 commit 的 `answer-me-with-html`

依赖安装在 Skill 自己的目录中，不会安装到被分析项目，也不会修改被分析项目的依赖文件。首次安装需要网络，生成报告和打开 HTML 不需要运行服务。

## 相关文档

- [安装与使用指南](docs/INSTALL.md)
- [设计文档](DESIGN.md)
- [Skill 说明](skills/codegraph-html-report/SKILL.md)
- [CodeGraph API 参考](skills/codegraph-html-report/references/codegraph-api.md)
- [报告格式参考](skills/codegraph-html-report/references/report-format.md)

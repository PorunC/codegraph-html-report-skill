# CodeGraph HTML Report Skill

一个用于 Codex 的本地 Skill：调用 [CodeGraph](https://colbymchenry.github.io/codegraph/reference/api/) 分析源码，再用 [Answer me with HTML](https://github.com/QingYunA/answer-me-with-html) 生成可离线阅读的 HTML 架构文档。

它适合需要快速了解陌生项目、梳理模块依赖，或交付一份可搜索、可分享的架构分析文档的场景。

## 功能

- 一键分析本地项目的文件、语言、框架和入口信息
- 只挑选重要模块，生成项目区域、架构和依赖图
- 输出一个总览页面和多个可互相导航的子页面
- 用图展示项目区域、模块架构、关键函数调用流程、静态影响和未解析边界
- 在关键调用流程图中保留源码函数名，并用中文说明节点、箭头和分支
- 报告未解析引用、索引状态和截断限制
- 每个页面都是自包含 HTML；页面间使用相对链接，可直接打开总览页离线阅读
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
使用 $codegraph-html-report 分析 /path/to/project，围绕 main 生成关键模块流向图，并将报告保存到 /path/to/project/docs/codegraph.html。
```

默认报告目录和总览页：

```text
.codewiki/reports/codegraph-report-<timestamp>/index.html
```

生成后打开 `index.html`，再从页首导航进入架构图、函数调用流程和影响分析子页面。无需启动服务。

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
  --output ./path/to/project/.codewiki/reports/my-project-report
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--project <path>` | 项目目录，默认是当前目录 |
| `--output <path>` | 报告目录，默认创建带时间戳的目录；指定 `.html` 时，该文件作为总览页，其余页面以相同文件名开头生成在旁边 |
| `--symbol <name>` | 指定用于筛选关键流程入口的符号；流程图会保留源码函数名 |
| `--depth <1-6>` | 设置内部调用关系和影响范围的分析深度，默认 `2` |
| `--scope full` | 完整报告，默认模式 |
| `--scope overview` | 生成总览与架构内容，不展开关键调用流程 |
| `--scope symbol --symbol <name>` | 围绕指定符号生成报告 |
| `--supplement <md>` | 合并一份基于项目源码整理的架构说明 |
| `--draft <path>` | 保留四份 Markdown 草稿；可传目录或总览 `.md` 路径，默认自动清理 |
| `--help` | 查看命令帮助 |

例如，围绕入口符号展开三层关系，分别生成模块架构图和带函数名的关键调用流程图：

```bash
node skills/codegraph-html-report/scripts/generate_report.mjs \
  --project ./my-project \
  --symbol main \
  --depth 3 \
  --scope symbol \
  --output ./my-project/.codewiki/reports/my-project-report
```

## 报告包含什么

报告目录包含一个总览页面和三个相互链接的子页面：

- `index.html`：项目摘要、代码区域、入口区域、架构速览和子页导航
- `architecture.html`：目录树、主要模块关系和跨模块流程概览
- `call-flows.html`：CodeGraph 挑出的关键函数调用流程，保留源码函数名并解释箭头、分支和截断
- `details.html`：静态影响范围、未解析引用边界和本次分析限制

所有页面都是自包含 HTML，通过相对链接互相导航，断网后仍可直接阅读。流程图展示静态源码关系；动态分派、反射、生成代码和外部依赖内部实现可能无法解析，调用边也不等于运行时一定会执行的路径。

总览与架构图按模块展示。少量源码函数名只作为关键调用流程图的节点；正文不重复列函数清单。报告不生成具体文件和行号清单，也不显示 CodeGraph 内部 ID。若将 `--output` 指定为 `docs/codegraph.html`，架构、调用流程和详情页会生成在同目录，文件名分别追加 `-architecture`、`-call-flows` 和 `-details`。

## 默认限制

为保证报告可读，脚本默认限制如下：

- 架构图最多 8 个模块、14 条关系
- 最多展示 3 条入口路径；内部分析每条最多 10 个调用节点、14 条边，关键调用子页显示筛选后的函数流程
- 静态影响图最多 8 个模块、14 条关系
- 未解析边界图最多聚合 12 个未解析引用
- `--depth` 允许 `1` 到 `6`

达到限制时，报告会在对应子页面中解释折叠范围。

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

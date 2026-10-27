# 安装与使用指南

本文介绍如何安装 `$codegraph-html-report` Skill，以及如何调用本地渲染器生成四页离线报告。源码分析由调用 Skill 的 Agent 完成；命令行生成器只读取分析 JSON 并渲染页面。

## 环境要求

- macOS、Linux 或 Windows
- Node.js 20 或更高版本
- npm
- Codex Desktop（调用 Skill 时）

检查 Node.js：

```bash
node --version
```

## 安装 Skill

仓库中的 Skill 目录是 `skills/codegraph-html-report/`，安装时需将该目录本身放入 Codex 的 `skills` 目录。

macOS、Linux、WSL 和 Git Bash：

```bash
mkdir -p "$HOME/Projects"
git clone https://github.com/PorunC/codegraph-html-report-skill.git \
  "$HOME/Projects/codegraph-html-report-skill"

CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$CODEX_SKILLS_DIR"
ln -s "$HOME/Projects/codegraph-html-report-skill/skills/codegraph-html-report" \
  "$CODEX_SKILLS_DIR/codegraph-html-report"
```

如果不使用符号链接，可将 Skill 目录复制到 `$CODEX_SKILLS_DIR/codegraph-html-report`。复制前确认目标目录不存在，或先备份已有安装。

Windows PowerShell：

```powershell
$RepoDir = Join-Path $HOME 'Projects\codegraph-html-report-skill'
New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null
git clone https://github.com/PorunC/codegraph-html-report-skill.git $RepoDir

$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$SkillsDir = Join-Path $CodexRoot 'skills'
New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
$SkillDir = Join-Path $RepoDir 'skills\codegraph-html-report'
New-Item -ItemType Junction -Path (Join-Path $SkillsDir 'codegraph-html-report') -Target $SkillDir
```

## 安装 HTML 渲染依赖

在 Skill 目录安装锁定的依赖：

```bash
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
npm install --prefix "$CODEX_SKILLS_DIR/codegraph-html-report"
```

PowerShell：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
npm install --prefix (Join-Path $CodexRoot 'skills\codegraph-html-report')
```

该依赖只提供本地 Markdown 到 HTML 的渲染功能。它不会安装目标项目的依赖，也不会执行目标项目脚本。

检查命令是否可用：

```bash
node "$CODEX_SKILLS_DIR/codegraph-html-report/scripts/generate_report.mjs" --help
```

在 Codex Desktop 中刷新 Skill 列表或重新打开会话，然后进入需要分析的项目。

## 通过 Skill 生成报告

在 Codex 中发送：

```text
使用 $codegraph-html-report 阅读当前项目源码，整理有依据的架构和关键流程，并生成完整的离线 HTML 分析报告。
```

也可以指定目标目录和输出位置：

```text
使用 $codegraph-html-report 分析 /Users/me/Projects/my-app，输出到 /Users/me/Projects/my-app/docs/project-report。
```

Agent 会阅读 README、项目配置、关键目录、相关实现和有助于理解行为的测试或部署设置。它应按项目规模选择阅读范围，避免宣称穷尽全仓库。结论和图表都来自 Agent 整理的源码证据；无法确认的行为会保留为未知项。

默认总览页：

```text
<项目目录>/.codewiki/reports/source-analysis-report-<timestamp>/index.html
```

打开 `index.html` 后，可通过相对链接浏览架构、关键流程和证据边界页面。无需启动服务。

## 直接运行渲染器

命令行模式要求已有分析 JSON。它不读取源码来推断项目职责或生成分析数据。数据结构和字段约束见 [source-analysis.schema.json](../skills/codegraph-html-report/references/source-analysis.schema.json)。

```bash
REPORT_SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/codegraph-html-report"
node "$REPORT_SKILL_DIR/scripts/generate_report.mjs" \
  --project /path/to/project \
  --analysis /path/to/source-analysis.json \
  --output /path/to/project/.codewiki/reports/my-report
```

参数：

| 参数 | 用途 |
| --- | --- |
| `--analysis <path>` | 必填。Agent 准备的 JSON 文件；结构和证据路径均须通过校验 |
| `--project <path>` | 项目根目录，用于检查证据引用的相对路径；默认当前目录 |
| `--output <path>` | 报告目录；若指定 `.html` 文件，则该文件为总览页，其余页面生成在旁边 |
| `--draft <path>` | 保留 Markdown 草稿；可指定目录或总览 `.md` 路径。未指定时成功或失败后自动清理临时草稿 |
| `--help` | 显示命令帮助 |

缺少 `--analysis`、JSON 格式错误、数据缺字段或证据文件不在项目目录时，命令会返回非零状态并说明修正方式，不会生成空报告。渲染失败也会返回非零状态。

## 报告页面

| 页面 | 内容 |
| --- | --- |
| `index.html` | 项目结论、实际分析范围和阅读路线 |
| `architecture.html` | 主要区域职责及有源码依据的区域关系 |
| `call-flows.html` | 有依据的流程步骤和步骤关系；不确定行为列入未知项 |
| `details.html` | 入口线索、扩展点、风险、分析范围、限制和未知项 |

生成器会检查页面是否非空、标题是否正确、内部相对链接是否可访问，以及是否残留外部资源引用。关系图只绘制分析 JSON 提供并通过校验的边；缺少关系数据时会解释原因，不补造连线。

## 运行期间写入的文件

- `.codewiki/reports/<报告名>/`：四个 HTML 报告页面
- `.codewiki/tmp/`：生成过程中的 Markdown 草稿，默认在结束后清理
- Agent 创建的临时分析 JSON：应在报告成功生成后只清理本次创建的临时文件

本流程不创建、更新或删除 `.codegraph/`。如果项目之前已有该目录，报告生成过程不会访问或改动它。

不希望将报告提交到 Git 时，可在项目 `.gitignore` 中添加：

```gitignore
.codewiki/
```

## 故障排查

### `answer-me-with-html is not installed`

依赖未安装到 Skill 目录。重新执行：

```bash
npm install --prefix "${CODEX_HOME:-$HOME/.codex}/skills/codegraph-html-report"
```

### `--analysis is required` 或 `Analysis JSON is invalid`

确认调用 Skill 时已创建结构化分析 JSON，并按照 schema 填写必需字段。所有证据 `source` 都必须是项目内存在的相对文件路径，图中关系至少要有一条 `basis: "direct"` 的依据。不要用空 JSON 代替分析。

### 证据文件不存在或超出项目目录

修正 JSON 中的 `source` 路径。使用相对项目根目录的文件路径；不要写绝对路径、`..` 或指向项目外的符号链接。

### 报告中有未知项

未知项表示当前阅读范围和证据无法确认该行为。报告会保留问题，不会根据命名、目录结构或框架惯例补出答案。

## 本地边界

- 分析与报告生成只处理本地项目文件。
- 不运行项目构建、测试或启动脚本。
- 不启动 HTTP 服务，不上传源码。
- HTML 经过检查，不保留外部资源请求。
- 报告内容可能包含项目和模块名称；分享前请自行检查。

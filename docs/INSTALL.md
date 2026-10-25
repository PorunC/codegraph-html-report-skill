# 安装与使用指南

本文说明如何把 `codegraph-html-report` 安装为 Codex Skill，以及如何通过 Skill 或命令行生成项目分析报告。下文的 shell 示例适用于 macOS、Linux、WSL 和 Git Bash；原生 Windows 用户可使用 PowerShell 示例。

## 环境要求

- macOS、Linux 或 Windows
- Node.js `22.5` 或更高版本
- npm
- Codex Desktop（通过 Skill 调用时需要）

检查 Node.js 版本：

```bash
node --version
```

如果版本低于 `22.5`，请先升级 Node.js。CodeGraph 依赖这个运行时版本。

## 安装到 Codex

Skill 目录需要直接包含 `SKILL.md`。因此，安装仓库时要使用仓库中的 `skills/codegraph-html-report/` 子目录作为 Skill 目录。

### macOS、Linux、WSL 和 Git Bash

先将仓库克隆到一个长期保留的目录：

```bash
mkdir -p "$HOME/Projects"
git clone https://github.com/PorunC/codegraph-html-report-skill.git \
  "$HOME/Projects/codegraph-html-report-skill"

CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$CODEX_SKILLS_DIR"
```

推荐使用符号链接，这样以后从源码目录拉取更新即可：

```bash
ln -s "$HOME/Projects/codegraph-html-report-skill/skills/codegraph-html-report" \
  "$CODEX_SKILLS_DIR/codegraph-html-report"
```

如果你希望把 Skill 独立复制到 Codex 目录，而不使用符号链接：

```bash
cp -R "$HOME/Projects/codegraph-html-report-skill/skills/codegraph-html-report" \
  "$CODEX_SKILLS_DIR/codegraph-html-report"
```

复制时目标目录必须尚不存在。如果该目录已有内容，请先备份或选择新的目标位置。复制安装后，更新时需要再次从新版本仓库复制文件。

### Windows PowerShell

克隆仓库并使用 Windows 目录联接注册 Skill：

```powershell
$RepoDir = Join-Path $HOME 'Projects\codegraph-html-report-skill'
New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null
git clone https://github.com/PorunC/codegraph-html-report-skill.git $RepoDir

$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$SkillsDir = Join-Path $CodexRoot 'skills'
New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null

$SkillDir = Join-Path $RepoDir 'skills\codegraph-html-report'
$SkillLink = Join-Path $SkillsDir 'codegraph-html-report'
New-Item -ItemType Junction -Path $SkillLink -Target $SkillDir
```

创建联接前，`$SkillLink` 目标不能已经存在。若要保留已有安装，请先备份；也可以改用 PowerShell 的 `Copy-Item -Recurse` 复制 Skill 目录。

## 安装运行时依赖

进入 Skill 目录执行：

```bash
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
npm install --prefix "$CODEX_SKILLS_DIR/codegraph-html-report"
```

PowerShell：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$SkillDir = Join-Path $CodexRoot 'skills\codegraph-html-report'
npm install --prefix $SkillDir
```

这会安装锁定版本的 CodeGraph 和 Answer me with HTML。依赖只放在 Skill 目录中，不会安装被分析项目的依赖，也不会执行被分析项目的脚本。

安装完成后，可以检查生成器是否可用：

```bash
node "$CODEX_SKILLS_DIR/codegraph-html-report/scripts/generate_report.mjs" --help
```

在 Codex Desktop 中，重新开始一个会话或刷新 Skill 列表后即可调用 `$codegraph-html-report`。如果 Skill 已经被当前会话加载，重新打开会话最稳妥。

## 通过 Codex 使用

进入需要分析的项目目录，在 Codex 中发送：

```text
使用 $codegraph-html-report 分析当前项目，并生成包含总览、架构图和关键函数调用流程的 HTML 报告。
```

指定项目路径：

```text
使用 $codegraph-html-report 分析 /Users/me/Projects/my-app，并生成完整的 HTML 架构文档。
```

指定焦点符号、深度和报告目录：

```text
使用 $codegraph-html-report 分析当前项目，围绕 main 展开 3 层关键调用流程，并将报告保存到 docs/codegraph-report/。
```

Skill 会先阅读项目的 README、包管理文件、配置文件和明显入口，再把这些信息作为架构补充说明传给报告生成器。它默认使用当前工作目录，也支持用户提供项目路径。

## 直接通过命令行使用

先定位 Skill 目录：

```bash
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
REPORT_SKILL_DIR="$CODEX_SKILLS_DIR/codegraph-html-report"
```

生成完整报告：

```bash
node "$REPORT_SKILL_DIR/scripts/generate_report.mjs" \
  --project /path/to/project \
  --output /path/to/project/.codewiki/reports/my-project-report
```

如果从本仓库目录运行，也可以直接使用：

```bash
npm install --prefix skills/codegraph-html-report
node skills/codegraph-html-report/scripts/generate_report.mjs \
  --project ./my-project
```

### 参数说明

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--project <path>` | 当前目录 | 指定要分析的项目目录 |
| `--output <path>` | `.codewiki/reports/codegraph-report-<timestamp>/` | 指定报告目录；指定 `.html` 时，该文件作为总览页，其余页面以相同文件名开头生成在旁边 |
| `--symbol <name>` | 自动选择 | 指定关键调用流程的入口符号，流程图显示源码函数名 |
| `--depth <1-6>` | `2` | 设置内部调用关系和影响范围深度 |
| `--scope full` | `full` | 生成完整报告 |
| `--scope overview` | — | 不展开调用关系；函数流程子页会说明此范围限制 |
| `--scope symbol` | — | 围绕 `--symbol` 生成报告 |
| `--supplement <md>` | 无 | 加入额外架构说明 Markdown |
| `--draft <path>` | 自动临时目录 | 保留四份 Markdown 草稿；可指定目录或总览 `.md` 路径 |

示例：

```bash
node "$REPORT_SKILL_DIR/scripts/generate_report.mjs" \
  --project ./my-project \
  --symbol App.run \
  --depth 3 \
  --scope symbol \
  --output ./my-project/docs/codegraph-report
```

## 查看结果

默认报告生成在：

```text
<项目目录>/.codewiki/reports/codegraph-report-<timestamp>/index.html
```

报告由四个自包含 HTML 页面组成。直接打开总览页即可：

| 页面 | 内容 |
| --- | --- |
| `index.html` | 项目摘要、代码区域、入口概览、架构速览和子页面导航 |
| `architecture.html` | 目录树、模块依赖、入口区域和跨模块流程 |
| `call-flows.html` | 关键函数调用图，使用源码函数名，并说明调用方向和分支 |
| `details.html` | 静态影响范围、未解析引用和分析限制 |

报告以图为主：总览与架构页按模块展示；少量源码函数名只作为关键调用流程图的节点，正文不重复列函数清单。所有页都不列具体文件和行号清单，CodeGraph 内部 ID 不会展示。页面间通过相对链接导航，打开 `index.html` 即可离线浏览整个报告。目录图会过滤测试、构建、生成和第三方目录，避免主结构被噪声淹没。若 `--output` 指定为 `docs/codegraph.html`，其余页面会以 `codegraph-architecture.html`、`codegraph-call-flows.html` 和 `codegraph-details.html` 的名称生成在同目录。

```bash
# macOS
open /path/to/project/.codewiki/reports/codegraph-report-<timestamp>/index.html

# Linux
xdg-open /path/to/project/.codewiki/reports/codegraph-report-<timestamp>/index.html
```

Windows 可以在文件管理器中双击 `index.html`，或在 PowerShell 中执行 `Start-Process 'C:\path\to\report\index.html'`。报告不依赖 HTTP 服务或外部网络资源。

## 生成过程和本地文件

运行时会在被分析项目中创建或更新：

- `.codegraph/`：CodeGraph 的本地索引
- `.codewiki/reports/<报告名>/`：总览、架构、函数调用流程、影响与边界四个 HTML 页面
- `.codewiki/tmp/`：生成过程中的 Markdown 草稿，成功后会清理

如果不希望把这些生成物提交到项目 Git 仓库，可以加入：

```gitignore
.codegraph/
.codewiki/
```

Skill 不启动服务、不开放端口、不上传源码，也不会执行被分析项目的构建、测试或启动脚本。

## 故障排查

### `CodeGraph is not installed`

确认依赖安装在 Skill 目录，而不是被分析项目：

```bash
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
npm install --prefix "$CODEX_SKILLS_DIR/codegraph-html-report"
```

### `answer-me-with-html is not installed`

这通常表示依赖安装不完整。重新安装 Skill 自己的锁定依赖：

```bash
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
npm ci --prefix "$CODEX_SKILLS_DIR/codegraph-html-report"
```

### Node.js 版本不满足

升级到 Node.js `22.5` 或更高版本，然后重新安装依赖。不同 Node.js 主版本可能导致原生依赖或模块加载失败。

### 报告提示没有明显入口符号

这不是索引失败。自动入口选择没有找到 `main`、`run`、`start`、`app` 或 `index` 等常见名称时，可以手动指定符号：

```bash
node "$REPORT_SKILL_DIR/scripts/generate_report.mjs" \
  --project /path/to/project \
  --symbol MyNamespace.MyEntry \
  --scope symbol
```

### 需要重新建立索引

如果索引状态过期或项目结构发生较大变化，删除被分析项目中的 `.codegraph/` 后重新运行。该目录是可重建的本地缓存，不包含项目源码修改。

### 报告中存在未解析引用或关键路径被折叠

这是静态分析或可读性限制提示。可以降低范围、指定更准确的符号或调整 `--depth`；动态分派、反射、生成代码和外部包内部实现仍可能无法解析。报告会保留重要提示，并把次要分支折叠，不会把缺失关系当作确定事实。

## 安全和隐私

- 分析范围是本地目录
- 报告生成不上传源码
- 仅关键调用流程图显示少量源码函数名；不嵌入源码片段，不生成函数清单或文件位置清单
- 生成的 HTML 经过检查，不保留外部 `http(s)` 资源引用

公开分享报告前，仍建议检查其中的项目名称、模块名称和业务名称。

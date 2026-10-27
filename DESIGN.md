# Source Analysis HTML Report Skill 设计

## 目标

用户调用 `$codegraph-html-report` 后，Skill Agent 阅读本地项目的源码和文档，产出有依据的结构化分析 JSON；本地生成器校验 JSON 并使用 Answer me with HTML 渲染四页离线报告。

```text
Agent 阅读源码与文档
        ↓
source-analysis.json
        ↓
结构与证据校验
        ↓
四份 Markdown 草稿
        ↓
本地 Answer me with HTML
        ↓
四页离线报告
```

默认总览页：

```text
.codewiki/reports/source-analysis-report-<timestamp>/index.html
```

## 职责边界

### Skill Agent

- 阅读 README、项目配置、关键目录与相关实现；按规模决定阅读深度。
- 用项目相对路径和位置描述记录结论依据。
- 区分源码直接确认和上下文解释，保留未知项与分析排除范围。
- 只在关系有具体源码依据时将其写成可视化边；不能根据名字、目录结构或框架惯例补图。
- 不运行被分析项目脚本，不上传源码，不启动服务。

### 本地生成器

- 读取并校验 `source-analysis.json` 及其项目相对证据路径。
- 根据经过校验的数据生成 Markdown 和四页 HTML。
- 校验页面标题、本地链接和外部资源引用。
- 不调用模型 API、不读取源码来做分析、不加载 CodeGraph、不访问或修改 `.codegraph/`。

## 数据契约

`skills/codegraph-html-report/references/source-analysis.schema.json` 规定以下内容：

- 项目名称、摘要和真实分析范围；
- 有依据的主要发现、区域和关系；
- 入口线索、关键流程步骤和有证据支持的步骤关系；
- 扩展点、风险、未知项与分析限制；
- 依据文件、仅供内部核对的位置、简短说明和证据类型。渲染报告时不展示具体位置字段，也不列函数或代码位置清单。

数据校验除了 JSON 字段外，还检查区域 ID 与流程步骤 ID、关系端点、证据类型、引用路径安全性和文件存在性。每条关系边至少要有一条 `direct` 依据。解释性判断可以作为文字结论保留，但不会单独成为确定的图边。没有证据的流程步骤或边会导致校验失败。

## 报告结构

- `index.html`：项目范围、结论、主要发现和阅读路线。
- `architecture.html`：区域职责树和有依据的区域关系图；没有关系时显示原因。
- `call-flows.html`：来源明确的步骤和关系图；未确认行为作为未知项。
- `details.html`：入口线索、扩展点、风险、证据、分析范围及限制。

四页用相对链接导航。所有资源内嵌，可从 `index.html` 离线打开。版式由已有数据和 Markdown 大小确定：简短并列内容用 `sheet`，长内容用 `doc`；只有 `sheet` 设置 `cols`。

## 依赖与运行

- Node.js `>=20`。
- Skill 自身固定版本的 `answer-me-with-html` 渲染器。
- 不依赖项目依赖，不安装或运行 CodeGraph。

```bash
npm install --prefix skills/codegraph-html-report
node skills/codegraph-html-report/scripts/generate_report.mjs \
  --project ./project \
  --analysis ./source-analysis.json \
  --output ./project/.codewiki/reports/my-report
```

`--analysis` 必填。格式错误、字段缺失、证据路径无效、渲染器缺失或页面检查失败都会返回非零状态。失败时不会生成一份伪造的空分析报告。

## 本地文件边界

- 分析 JSON 可由 Agent 临时写入项目 `.codewiki/tmp/`；成功后仅清理本次生成的临时文件。
- 生成器在 `.codewiki/tmp/` 写 Markdown 草稿，在 `.codewiki/reports/` 写 HTML。
- 不创建、更新或删除已有 `.codegraph/`，也不扫描该目录。
- 报告默认不会上传或启动服务；用户可直接离线浏览 HTML。

## 验证

运行以下命令执行结构校验、布局测试和报告生成集成测试：

```bash
node --test skills/codegraph-html-report/scripts/*.test.mjs
```

测试覆盖合法与非法 JSON、证据和未知项、布局选择、无关系输入、四页输出、离线链接和渲染失败退出码，并确认生成器不会创建 `.codegraph/`。

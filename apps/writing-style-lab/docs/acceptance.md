# 验收记录

对应任务书第九节 13 条验收标准。**只记录实际跑过的结果**；没跑的写「未验证」，不写「已通过」。

自动测试位置：`tests/`。运行方式：`npm test`（Vitest，node 环境）。

## 汇总

| # | 验收标准 | 验证方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 输入法/粘贴/刷新后稿件与来源标记正确、保存错误可见 | 代码审查 + 浏览器手工验收 | **部分**：代码有 IME 组合守卫与保存状态机；**浏览器手工验收未做** |
| 2 | 无 Key 仍可写作/备份/恢复/查看结果，不伪造分析 | 接口行为 + 状态页 | **部分**：服务端返回 `CONFIG_MISSING_KEY`（400），不产生任何分析；端到端未跑 |
| 3 | AI/混合来源与 holdout 不默认发送 | 自动测试 | **通过**（`tests/rules.test.ts`） |
| 4 | 题目强制「全用短句」不被归为作者通用短句偏好 | 自动测试 | **通过**（`tests/rules.test.ts`） |
| 5 | 假引用/无效 JSON/空正文/截断 → 拒绝保存为有效分析 | 自动测试 | **通过**（`tests/verify.test.ts`，11 例） |
| 6 | 编辑/删除/改来源/排除/holdout 后重验，失效证据不进新 Skill | 自动测试 | **通过**（`tests/rules.test.ts`） |
| 7 | 未确认/已拒绝/过期规则不进导出；确认的与导出一致；偏好标记清楚 | 自动测试 | **通过**（`tests/export.test.ts`） |
| 8 | 默认导出无原稿、未确认规则、未选摘录、密钥、日志、失效链接 | 自动测试 | **通过**（`tests/export.test.ts`） |
| 9 | 重复点击不重复发起；重试有上限；失败不覆盖已完成分析；无 usage 显示未知 | 自动测试 + 打桩 fetch + 接口冒烟 | **通过（本地）**：分析/归纳/试写三条路径都用同一套在飞去重（同键返回 409）；重试按 runId 记账、尊重 Retry-After 且有总额度上限；无 usage 保持“未知”。上游行为用打桩 fetch 验证（401 不重试、429 退避、Retry-After=3600 不干等）。**归纳路径的并发行为只做了代码审查与单元级验证，未做端到端并发实测；真实上游未验证** |
| 10 | 备份恢复保留正文/任务/规则/版本关系；坏文件与 ID 冲突不静默破坏 | 自动测试 | **通过**（`tests/backup.test.ts`，13 例） |
| 11 | A/B 条件评价前隐藏；AI 试写不自动进样本库 | 自动测试 + 代码审查 | **部分**：随机排布与映射有测试；**界面手工验收未做** |
| 12 | 构建通过；本地服务可按说明启动；真实 API 与作者效果分别记录 | 实际执行 | **构建与启动通过**（见下）；**真实 API 与作者效果：未验证** |
| 13 | 直接丢入已写好的文字：逐字不变、只读、来源门禁、约束记 unknown、切分不静默截断 | 自动测试 | **通过**（`tests/direct-sample.test.ts` 10 例 + `tests/stylometry.test.ts`） |

## 自动测试实况

```
npx vitest run
Test Files  8 passed (8)
Tests      126 passed (126)
```

覆盖文件：

- `tests/text.test.ts` —— 字数口径（码点/emoji/空白）、段落偏移、句切分、hash 不归一化、接收特征、长文分区切分可还原、长度校验
- `tests/verify.test.ts` —— 分析验收关卡：假引用、空白差异、不存在的段落、无效 JSON、schema 不符、空正文、截断、部分坏引用、约束未知强制为 unknown、上游失败
- `tests/rules.test.ts` —— 来源门禁、holdout、归纳降级、题目强制特征不被当成习惯、去伪重复、版本失效重算、作者决定不被覆盖
- `tests/export.test.ts` —— 只导出接受且有效的规则、作者修订留痕、偏好标记、默认无摘录与无失效链接、Mock 阻断、空模板、frontmatter 与七小节
- `tests/backup.test.ts` —— schemaVersion、坏 JSON、含密钥备份拒绝、版本过高拒绝、冲突预览、三种导入模式、失败不破坏现有数据
- `tests/ab.test.ts` —— 随机映射正确、条目不含条件、非常量顺序
- `tests/direct-sample.test.ts` —— 原文逐字一致、只读性（函数不改动输入）、片段还原、来源自述门禁、部分样本标记
- `tests/stylometry.test.ts` —— 统计确定性与归一化、口径防漂移、交叉核对、近似重复只算一份
- `tests/server-guards.test.ts` —— 任务去重、重试额度按批次隔离、Retry-After 解析、无 usage 保持未知、密钥不出现在状态字段、上游地址不可改成别家、Mock 默认关闭且必须过验收关卡、提示词确实写了任务书要求的约束

## 接口层实测（本地服务，非真实 API）

服务端代理在本地起服务实测并通过（详细命令与输出见其交付记录，这里只记结论）：

- `GET /api/status`：字段正确、`priceNote=null`、**不含任何密钥信息**。
- 缺 Key → `400 CONFIG_MISSING_KEY`；7001 字 → `400 LENGTH_LIMIT`；缺字段 → `400 BAD_REQUEST`；空白正文 → 400；
  `skillMarkdown` 超长 → 400；1.1MB body → 413；`text/plain` → 415；恶意 Origin/Host → 403；未知 /api → 404。
- 用**打桩 fetch**（无真实网络）验证：URL 恒为固定端点（伪造 `DEEPSEEK_BASE_URL` 被忽略）、
  analyze 带 `response_format`+`thinking` 而 tryout 两者皆无、401 不重试、429 按 `Retry-After` 退避、
  同一 runId 两路并发共享 2 次重试额度、无 usage 落成 `UNKNOWN_USAGE`。
- 日志只落元信息（route/status/model/usage/errorCode/attempts…），无正文、无密钥。


## 构建与启动（实际执行）

```
$ npm run build
> tsc -p tsconfig.json --noEmit        # 0 错误
> vite build
✓ 62 modules transformed.
dist/web/index.html                   0.48 kB │ gzip:   0.35 kB
dist/web/assets/index-lgvG79qx.css   11.93 kB │ gzip:   3.00 kB
dist/web/assets/index-A0JKMr0X.js   315.07 kB │ gzip: 104.24 kB
✓ built in 668ms
```

```
$ PORT=8787 npx tsx src/server/index.ts     # 只绑定 127.0.0.1
GET /api/status  → 200，apiKeyConfigured=false、priceNote=null、limits 与 shared/limits.ts 完全一致
GET /            → 200，返回 dist/web 的 SPA 外壳
```

错误路径（真实 HTTP 请求，逐条实测）：

| 请求 | 结果 |
| --- | --- |
| 缺 Key 时分析 | `400 CONFIG_MISSING_KEY`，文案只讲怎么配置，**不伪造结果** |
| 恶意 Origin | `403 NOT_ALLOWED_ORIGIN` |
| `Content-Type: text/plain` | `415 BAD_CONTENT_TYPE` |
| 7001 字正文 | `400 LENGTH_LIMIT`（含当前字数与处理建议） |
| 字段不合 schema | `400 BAD_REQUEST` + details |
| 未知 `/api` 路径 | `404` |

端到端链路（`ALLOW_MOCK_ANALYSIS=1` + 请求体显式 `"mock": true`，全程无真实网络调用）：

| 步骤 | 结果 |
| --- | --- |
| 单篇分析 | `ok`，`status=ok`、`mock=true`、5 条观察、`rejectedObservations=0`、`attempts=1`、统计已算 |
| 多篇归纳 | `ok`，1 条候选，scope 被**自动降级为 preliminary**（只有一篇支持），Mock 局限已写入 limitations |
| 对照试写 | `ok`，两版同参数（temperature=1.0），312 字 / 314 字 |
| 归纳不带 `mock` 标志 | `400 CONFIG_MISSING_KEY` —— 开关打开也不会“偷偷”走 Mock |

## 未验证项（必须由你或后续阶段补上）

1. **真实 DeepSeek 调用**：仓库里没有 `DEEPSEEK_API_KEY`，所以模型参数、错误分支、重试与
   usage 记录**全部未实测**。测试里所有“通过”都是对本地逻辑与校验关卡的验证，不是对模型效果的验证。
2. **中文输入法真机测试**：需要你在浏览器里用拼音输入法连续输入、切页、刷新后确认光标不跳、不重复插字。
3. **作者效果验收**：A/B 试写是否能看出区别、导出的 Skill 是否像你，只能由你本人判断；
   一次 A/B 不能证明效果。
4. **长文切分在真实稿件上的表现**：目前只有构造用例。

## 复现步骤（你本人验收时照这个走）

```bash
cd apps/writing-style-lab
npm install
cp .env.example .env        # 想跑真实分析就填 DEEPSEEK_API_KEY；不填也能走完除模型外的全部流程
npm run build
npm start                   # http://127.0.0.1:8787
```

1. 「写作任务与样本库」→ 选一张任务卡 → 写或粘贴一段 → 看保存状态与「字数（含标点）」。
2. 点「直接采样」→ 粘贴一段旧文 → 看接收特征（换行风格/BOM/零宽字符）与统计数字 → 选来源自述 → 入库。
3. 「分析」→ 核对待发送清单与最大调用次数 → 点分析 → 逐条看观察与原文依据。
4. 「规则」→ 接受/修改/拒绝 → 预览 SKILL.md → 导出三个文件（含/不含摘录各试一次）。
5. 「设置」→ 导出备份 → 改点东西 → 用 duplicate 模式导入 → 确认没有静默覆盖。
6. 把某篇样本改成 holdout → 回到「规则」确认相关规则变成「需重新确认」且不能导出。

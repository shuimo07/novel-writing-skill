# 文风采样器 · M0 设计说明与任务清单

本文档是 M0 的产出：范围、数据结构、页面流程、风险与验收条件，以及任务清单。
写完后立即进入实现，不在这里堆长方案。

## 1 一句话定位

作者按写作框架亲自写样本（或把已经写好的文字直接丢进来），程序调用 DeepSeek 分析**本人样本**，
汇总**可核查**的文风规则；作者接受、修改或拒绝规则后，导出可给其他写作智能体用的 `SKILL.md`。

Skill 是**结构化写作指令**，不是训练好的模型权重。不承诺完美复制作者，不给“还原度百分比”。

## 2 范围

**做**：本地单用户 MVP。写作任务、编辑器与直接采样、样本库与来源标记、分析（单篇 → 多篇归纳）、
原文依据核对、规则确认与版本失效、`SKILL.md` / `style-profile.json` 导出、A/B 对照试写、备份恢复。

**不做**（首版明确排除）：账号、支付、社区、自动发布、小说批量生成、联网采集、向量库、微调、
复杂智能体调度平台、公共 API 发布。

## 3 技术栈与目录

- 前端 React + TypeScript + Vite；后端 Node.js + Express + TypeScript；Zod 校验；原生 fetch；Vitest。
- 浏览器 IndexedDB 保存稿件、规则、结果与版本；服务端**不落库**，只在内存里处理单次请求。
- 目录：
  - `src/shared/` 口径与契约层（字数、切分、schema、证据校验、规则有效性、导出编译、备份、A/B）
  - `src/server/` Express：状态、单篇分析、跨篇归纳、试写；DeepSeek 客户端；调用控制与失败恢复
  - `src/web/` React 工作台：任务/样本库、编辑器、直接采样、分析、规则、试写、设置
  - `tests/` Vitest：按验收标准逐条对应，不写只复述实现的测试

## 4 数据结构（关键实体）

完整 Zod schema 见 `src/shared/schema.ts`。要点：

| 实体 | 关键字段 | 说明 |
| --- | --- | --- |
| `WritingTask` | id / version / 题目 / constraints / 目标字数 / sceneTags | 6 张内置卡可改；作者加的框架约束进 `constraints` |
| `SourceDocument` | id / 原样 text / contentHash / receipt（换行风格、BOM、零宽字符） | 文稿级条目；直接采样产生，用于记录“程序没动过原文” |
| `Sample` | id / revision / entryMode / sourceType / text / paragraphs / contentHash / useForAnalysis / holdout / partial / fragment | 一篇文稿可切出 0—n 个片段，共享 `sourceDocumentId` |
| `SampleAnalysis` | sampleId / revision / contentHash / taskConstraintsHash / model / promptVersion / stats / observations / rejectedObservations / usage / status | 版本三件套（revision + contentHash + constraintsHash）任一变化即过期 |
| `Observation` | dimension / claim / scope / evidence[] / constraintInfluence / limitations | `constraintInfluence` 允许 `unknown`（直接采样无题目时强制为它） |
| `Evidence` | sampleId / sampleRevision / paragraphId / quote | quote 必须是该段落正文的**逐字连续子串** |
| `StyleRule` | statement / scope / origin / evidence / counterEvidence / decision / statementOriginal / stale | 手工修改保留原说法与理由，不伪造证据 |
| `StyleProfile` | version / 样本快照 / rules / 覆盖场景 / 局限 | 导出时只取 accepted + 未失效 + 非 Mock |
| `Evaluation` | 新题目 / 两版输出 / abOrder 映射 / feedback / 模型参数 / usage | 评价前隐藏条件 |
| `PreferenceMark` | sampleId / paragraphId / kind(keep\|avoid) | 成稿上的“这段我想保留 / 不代表我的风格” |

**两套单位，不混用**：偏移量（`start/end`）是 UTF-16 下标；**字数**是 Unicode 码点、排除空白、含标点
（界面写作“字数（含标点）”）。句段统计按终止标点断句，是明确口径的近似值，不假装是语言学测量。

## 5 页面流程

任务导航 6 个区域（不做聊天界面）：

1. **写作任务与样本库** —— 6 张任务卡；样本列表（字数/来源/场景/是否入选/holdout/状态徽章）；
   **直接采样入口与“从题目开始写作”并列**。
2. **写作编辑区** —— 纯文本、粘贴、TXT/Markdown 导入、自动保存、保存状态可见、IME 组合期不打断。
3. **直接采样** —— 丢入已写好的文字 → 字数与接收特征 → 点选来源自述 → 超限时给出切分预览
   → 只读视图（可另存为草稿，原文不动）→ 可按段落标偏好。
4. **分析** —— 待发送清单 + 本轮最大调用次数 → 顺序执行、逐项保存 → 观察 + 原文依据（可回看高亮）
   → 被丢弃的观察单独列原因。
5. **规则确认与 Skill 预览** —— 接受 / 修改（填理由）/ 拒绝 / 手工加“本人指定偏好”；失效规则醒目提示；
   导出 SKILL.md、style-profile.json、可选 references/evidence.md。
6. **对照试写、历史与设置** —— 新题目 → 两版生成 → A/B 隐藏条件 → 评价 → 揭示 → 存档；
   备份导出/导入（先预览冲突）；API 状态与 Mock 徽章。

## 6 关键取舍（记录理由）

1. **入口并列而非新增导航区**：避免把工作台做成聊天框。
2. **来源自述只点一次且默认不预选**：程序不能判断作者身份，自述即来源标记；但默认不预选保证不会
   “顺手”把 AI 文本当成作者样本。
3. **切分是分区不是裁剪，同篇片段只算一份证据**：否则把一篇文章切成两段就能凑出“两篇支持”，
   “至少两篇非重复样本”的工程门槛会被自己绕过。
4. **直接采样视图只读**：要改就另存为写作区草稿，原文 revision 不动。
5. **不做任何静默规范化**：全角/半角、标点、换行、首尾空白、零宽字符、BOM、Markdown 标记全部原样保留。
   这是“不能更改原文”的落地方式，也是引用校验能成立的前提。
6. **约束未知 ≠ 无约束**：无题目样本的 `constraintInfluence` 强制为 `unknown`；
   归纳时若支持样本都没约束信息，通用规则降级为“特定场景”并写明局限。
7. **服务端只绑 127.0.0.1、不做通用转发**：上游地址固定；严格校验长度、Content-Type、同源来源。
8. **Mock 只能显式开启**：带 Mock 标记，且不能导出为正式作者 Skill。

## 7 风险

| 风险 | 处理 |
| --- | --- |
| 偏移/编码处理出错导致引用校验错位 | 原文不做任何规范化；偏移与 slice 同单位；测试覆盖 CRLF、BOM、零宽字符、emoji |
| 模型把题目强制特征说成作者习惯 | `constraintOverlap` 确定性降级 + `constraintInfluence` 强制 unknown + 验收第 4 条专门测 |
| 长文超限被静默截断 | 只做分区切分，拼接必须逐字还原（有断言）；截断只能作者显式选择并标 partial |
| 样本一改，旧规则偷偷继续生效 | 证据三重校验（revision/hash/资格），失效即 `stale`，不进导出 |
| 重复点击造成重复计费 | 前端 in-flight 守卫 + 服务端按任务 ID 去重（409），重试有总额度上限 |
| 把 Mock 当成真实接入 | 状态页与结果页都带 Mock 标记，导出直接阻断 |
| 备份覆盖导致数据损坏 | 导入先校验、先预览冲突，三种模式显式选择，整体校验失败则放弃 |

## 8 验收条件

见 `docs/acceptance.md`：逐条对应任务书第九节 13 条验收标准，标明验证方式（自动测试 / 手工步骤 / 未验证）。

## 9 任务清单

- [x] M0 设计说明与任务清单；环境检查；契约层（schema / 口径 / 常量）
- [ ] M1 任务卡、编辑器、来源标记、样本库、自动保存、JSON 备份恢复、直接采样入口
- [ ] M2 服务端 DeepSeek 接入、schema 与引用校验、调用控制与失败反馈
- [ ] M3 多篇归纳、作者确认、版本失效、SKILL.md 与 JSON 导出
- [ ] M4 A/B 试写、关键流程测试、README 与交付记录

> 本清单在 `docs/progress.md` 里持续更新；新增需求先写进 backlog 并说明影响。

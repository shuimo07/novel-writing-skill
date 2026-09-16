# 进度记录

状态图例：`done` 已完成并有依据 / `in_progress` 进行中 / `blocked` 被外部条件卡住。

最后更新：M0–M4 全部完成（真实 API 与浏览器手工验收除外，见「未验证项」）。

## done

| 项 | 依据 |
| --- | --- |
| **M0** 设计说明、任务清单、环境检查 | `docs/design.md`；node v24 / npm 11 / vite 5.4 可用；仓库原有内容（`prompt-写作技能-deepseek-v4.md`、`review-checklist.md`、`1.1/1.2/check1.2`、`.claude/skills/novel-*`、`关于我的小说`）未改动 |
| **M1** 任务卡、编辑器、来源标记、样本库、自动保存、直接采样、备份恢复 | `src/web/**`（6 个区域对应 6 个面板）；IME 三道闸门见 `src/web/app/hooks.ts`；直接采样只读视图见 `DirectSamplingPanel.tsx` |
| **M2** 服务端 DeepSeek 接入、schema 与引用校验、调用控制 | `src/server/**`；错误路径与打桩 fetch 实测结论见 `docs/acceptance.md` |
| **M3** 多篇归纳、作者确认、版本失效、SKILL.md 与 JSON 导出 | `src/shared/rules.ts`、`src/shared/export.ts`；导出恒由程序编译，不调模型 |
| **M4** A/B 试写、关键流程测试、README 与交付记录 | `tests/**`、`README.md`、`docs/acceptance.md` |
| 共享契约层（全部实体 Zod schema、字数口径、切分、hash） | `src/shared/schema.ts`、`src/shared/text.ts` |
| 分析验收关卡 | `src/shared/verify.ts`：空正文/截断/无效 JSON/schema 不符/引用不实/版本不符一律拒绝 |
| 风格学统计与交叉核对（借鉴同类项目） | `src/shared/stylometry.ts`；理由与出处见 `docs/research-prior-art.md` |
| 自动测试 | `npx vitest run` → **8 个文件 / 127 个用例全部通过** |
| 构建与启动 | `npm run build` 通过（tsc 0 错误 + vite 62 模块）；`npm start` 起服务，`/api/status` 与 SPA 均 200 |
| 端到端链路（Mock，无真实网络） | 分析 `status=ok / obs=5 / attempts=1`；归纳 1 条候选且**自动降级为 preliminary**；试写两版同参数 310/310 字 |

## in_progress

无。

## blocked

| 项 | 阻塞条件 |
| --- | --- |
| 仓库改名为 `novel-writing-skill` | 你给的 fine-grained PAT 缺少 `Administration: Read and write`，GitHub API 返回 403「Resource not accessible by personal access token」。推送权限正常，因此代码可以推；**改名需要你补权限或在网页端手动改**。改名后旧地址会自动跳转，不影响本地 remote。 |

## 未验证项（不得写成已通过）

1. **真实 DeepSeek 调用**：环境里没有 `DEEPSEEK_API_KEY`，模型参数、错误分支、重试与 usage 全部未实测；
   所有 Mock/打桩验证只证明本项目的校验关卡与调用控制生效，不证明模型效果。
2. **浏览器手工验收**：中文输入法组合输入、刷新与切页、IndexedDB 读写、A/B 揭示、备份导入这些路径
   只过了类型检查、构建与代码走查，**没有真人在浏览器里点过**。
3. **作者效果**：导出的 Skill 像不像你、A/B 有没有差别，只能由你本人判断；一次 A/B 不能证明效果。
4. **归纳路径的并发去重**：与另两条路径共用同一机制并已单元验证，但没有做并发端到端实测。
5. **120 秒超时**：只验证了 signal 传递与超时到错误码的映射，没有真等满 120 秒。

## 本阶段的技术取舍（记录在此，不另开文档）

| 取舍 | 理由 |
| --- | --- |
| 超长文只做「分区切分」，绝不截断 | 拼接后必须逐字还原原文（有断言）；要截断只能作者显式选择并标 partial |
| 归纳阶段的近似重复判定只在有正文片段时才做 | 曾用「证据摘录」当指纹，结果两篇不同样本引用同一句话就被误判为重复，反而杀掉了本该发现的跨篇信号；改成有正文才聚类，否则按文稿计数 |
| 规则重算（拿得到完整正文）用真实文本严格去重 | 这里才是「独立支持」的执法点，近似重复只算一份 |
| 提交 r2 时把 r1 自动移出本轮 | 同一文稿的多个版本重复计入证据会虚增支持度 |
| 上游传输失败不落库、内容级失败落 `status=rejected` 的分析 | 传输失败时拿不到 model/统计口径，硬造记录会污染数据 |
| 分析请求用 200 + `status:"rejected"` 表达内容级失败 | 传输层失败才用 4xx/5xx；这样前端的逐项状态能显示明确原因 |
| Mock 需要两道开关（环境变量 + 请求体 `mock:true`） | 避免「没配 Key 就自动变 Mock」的伪造结果 |

## backlog（新增需求与新想法）

| 需求 | 范围影响 | 状态 |
| --- | --- | --- |
| 「把已经写好的文字直接丢进来采样」 | 已并入提示词（三节新增小节 + 验收 13），并落到数据与代码：`SourceDocument`/`entryMode`/`fragment`/只读视图/来源自述/切分预览 | done |
| 借鉴「要具体不要空泛」 | `stylometry.ts`：统计进提示词、进界面、并交叉核对模型说法 | done |
| 借鉴「跨篇重复才算真特征」 | 归纳与规则重算按「独立支持」计数，近似重复只算一份 | done |
| 「调用次数」落库 | `SampleAnalysis.attempts`，界面显示「调用次数」，含重试 | done |
| 跨作者对照语料（和别人的文风对比） | 超出当前范围：需要额外语料与隐私处理 | 未排期 |
| 平台专用 Skill 打包（如某平台自动加载） | 未验证前不声称支持 | 未排期 |
| 导出历史版本管理（多份 Skill 并存对比） | 现在只保留 profile 版本号，没有 UI 对比 | 未排期 |

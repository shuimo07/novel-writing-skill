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
| 静态演示版（GitHub Pages） | `.github/workflows/pages.yml` + `PAGES_BASE` / `VITE_STATIC_DEMO` 开关；本地已验证两种构建产物（`base=/` 与 `/novel-writing-skill/`）与「资源路径正确、无密钥痕迹、开关生效」 |
| 静态直连模式（BYOK：访客自带 Key 直连模型） | `src/web/directCredentials.ts` + `directClient.ts` + `app/ApiKeyPanel.tsx`；复用服务端同一套提示词与校验关卡（`server/prompts.ts` 只依赖 shared，可直接被前端 import）。`tests/direct-mode.test.ts` 18 个用例覆盖端点/参数/校验不放松/重试额度/Key 不进持久存储 |
| 端点可配置 | 默认 DeepSeek 官方，可填任何 OpenAI 兼容的 https 端点（含自建 Worker）；只接受 https，非法地址回落默认 |
| 在线版上线（GitHub Pages） | <https://shuimo07.github.io/novel-writing-skill/> —— 分支部署（`main` / `/docs`），状态 `built`；线上实测：index.html 200、JS/CSS 200、含直连版文案、**0 处密钥形态、无服务端代码** |
| 首屏体验 | 黄色警示横幅改为一行紧凑提示条；凭据面板默认收起；未填 Key 时不再显示红色告警徽章（改橙色「未填 Key」） |
| 三分钟上手 + 示例数据 | `GettingStarted.tsx` + `exampleData.ts`：三步引导 + 一键载入 3 篇示例文本（固定 ID、可一键删除、不联网） |
| 无 Key 试玩 | `directMock*`：静态版没填 Key 时用本机占位数据跑完分析/归纳/试写，**一个请求都不发**，仍过同一套校验关卡，结果带 Mock 标记且不能导出为正式 Skill |
| 安全收尾（本机） | `E:\AI\.gitignore` 补上 `.git-credentials`（原先一次 `git add -A` 就会把凭据推上公开仓库）；33 个本地日志文件里的 token **已抹除**（324 处，复核为 0）；`.git-credentials` 里的 token 条目已清除（原文件备份在 `E:\AI\.tmp\`）。经核查：该 token **从未被提交、从未被推送**，没有公开泄露 |

## in_progress

无。

## blocked

| 项 | 阻塞条件 |
| --- | --- |
| GitHub Actions 自动部署（可选升级） | fine-grained PAT 缺 `Workflows: Read and write`，推送 `.github/workflows/pages.yml` 会被 GitHub 拒收（`refusing to allow a Personal Access Token to create or update workflow`）。**当前不影响使用**：线上已用 Pages 分支部署上线，见下方 done。workflow 文件备份在本地，等权限补上后可切换（届时需把 Pages 源改为 GitHub Actions，并删除 `docs/` 以免两套并存）。 |

## 未验证项（不得写成已通过）

1. **真实 DeepSeek 调用**：环境里没有 `DEEPSEEK_API_KEY`，模型参数、错误分支、重试与 usage 全部未实测；
   所有 Mock/打桩验证只证明本项目的校验关卡与调用控制生效，不证明模型效果。
2. **浏览器手工验收**：中文输入法组合输入、刷新与切页、IndexedDB 读写、A/B 揭示、备份导入这些路径
   只过了类型检查、构建与代码走查，**没有真人在浏览器里点过**。
3. **作者效果**：导出的 Skill 像不像你、A/B 有没有差别，只能由你本人判断；一次 A/B 不能证明效果。
4. **归纳路径的并发去重**：与另两条路径共用同一机制并已单元验证，但没有做并发端到端实测。
5. **120 秒超时**：只验证了 signal 传递与超时到错误码的映射，没有真等满 120 秒。
6. **在线版的真机交互**：线上页面「能加载、资源 200、含正确文案」已实测；但真人点击（填 Key、试玩、
   A/B、备份导入）与手机端排版仍未验证。

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

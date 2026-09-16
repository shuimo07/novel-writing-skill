# novel-writing-skill

> 曾用名：`deep-seekv4pro-api-novel-writing-skill`

小说写作技能与配套工具集合。

## 写作技能（Claude Code / 通用 Markdown Skill）

- `prompt-写作技能-deepseek-v4.md` —— DeepSeek V4 写作技能主提示词
- `.claude/skills/novel-*` —— 8 个可安装技能模块：选题、大纲、设定、写作、审稿、编辑、读者视角审读、封面
- `review-checklist.md` —— 三遍审查清单（写手/查手分离）
- `1.1`、`1.2`、`check1.2` —— 写作规则与自检脚本
- `关于我的小说` —— 作品与交流入口

## 应用：文风采样器（apps/writing-style-lab）

本地单用户工具：按写作框架亲自写样本，**或把已经写好的文字直接丢进来**；程序调用 DeepSeek 分析
**作者本人样本**，汇总**可核查**的文风规则；作者接受、修改或拒绝后，导出可给其他写作智能体用的
`SKILL.md`，再用新题目做 A/B 对照试写。

> Skill 是**结构化写作指令**，不是训练好的模型权重。不承诺完美复制作者，也不给“还原度百分比”这类
> 未经验证的数字。

启动方式、配置说明、调用控制、隐私边界与已知限制见
[apps/writing-style-lab/README.md](apps/writing-style-lab/README.md)。

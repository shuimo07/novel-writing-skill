/**
 * Skill 导出编译：**由程序确定性完成，不调用模型**。
 *
 * 硬要求：
 * - 只导出 `accepted` 且未失效（stale=false）且非 Mock 的规则；
 * - 默认不含原稿正文、不含待确认/已拒绝规则、不含未选择的摘录、不含密钥与请求日志；
 * - 未勾选“包含短摘录”时，SKILL.md 里不能出现指向 references/evidence.md 的失效链接；
 * - 作者改过的说法保留来源与支持说明，但不伪造支持新说法的证据。
 */
import { PROMPT_VERSION } from './limits';
import {
  type Sample,
  type StyleProfile,
  type StyleRule,
  ELIGIBLE_SOURCE_TYPES,
  RULE_SCOPE_LABEL,
} from './schema';
import { selectExportableRules } from './rules';
import { countChars } from './text';

export interface ExportInput {
  profile: StyleProfile;
  samples: Sample[];
  rules: StyleRule[];
  options: {
    includeEvidence: boolean;
    now?: Date;
    appVersion?: string;
  };
}

export interface ExportResult {
  skillMarkdown: string;
  /** 已序列化好的 style-profile.json 文本，UI 直接下载即可。 */
  profileJson: string;
  /** 仅当 includeEvidence 时为非 null。 */
  evidenceMarkdown: string | null;
  /** 非 null 表示不允许导出为正式作者 Skill。 */
  blocked: { reason: string } | null;
  /** true 表示没有任何被接受的规则，导出的是明确标记为空的模板。 */
  empty: boolean;
  fileNameBase: string;
}

const SKILL_NAME = 'author-writing-style';
const SKILL_DESCRIPTION = '根据作者确认的文风规则辅助创作和审稿；在请求使用作者文风时应用。';

function scopeHeading(scope: StyleRule['scope']): string {
  return RULE_SCOPE_LABEL[scope];
}

/** 说法 + 标记（作者修订 / 作者指定偏好）。人工修改必须留痕，不能看起来像模型原话。 */
function statementWithMarks(rule: StyleRule): string {
  const edited = rule.statementOriginal !== null && rule.statementOriginal !== rule.statement;
  const marks: string[] = [];
  if (edited) marks.push('作者修订');
  if (rule.origin === 'preference') marks.push('作者指定偏好');
  return marks.length ? `${rule.statement}（${marks.join('、')}）` : rule.statement;
}

function ruleLine(rule: StyleRule): string {
  return `- ${statementWithMarks(rule)}`;
}

function ruleBlock(rule: StyleRule, includeEvidence: boolean, index: number): string {
  const lines: string[] = [];
  lines.push(`### R${index + 1}. ${statementWithMarks(rule)}`);
  lines.push('');
  lines.push(`- 范围：${scopeHeading(rule.scope)}`);
  if (rule.origin === 'preference') lines.push('- 来源：作者指定的未来偏好（不一定有原文依据）');
  if (rule.statementOriginal !== null && rule.statementOriginal !== rule.statement) {
    lines.push(`- 原始说法：${rule.statementOriginal}`);
    if (rule.userEditReason) lines.push(`- 修改理由：${rule.userEditReason}`);
  }
  if (rule.supportDescription) lines.push(`- 支持说明：${rule.supportDescription}`);
  if (rule.limitations.length) lines.push(`- 局限：${rule.limitations.join('；')}`);
  if (rule.counterEvidence.length) lines.push(`- 反例：另有 ${rule.counterEvidence.length} 处文本与该说法不完全一致`);
  if (includeEvidence && rule.evidence.length) {
    lines.push('- 原文依据（仅用于说明写法，不要求照抄）：');
    for (const ev of rule.evidence) {
      lines.push(`  - ${ev.sampleId} ${ev.paragraphId}：${ev.quote}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function compileExport(input: ExportInput): ExportResult {
  const now = input.options.now ?? new Date();
  const version = input.profile.version;
  const fileNameBase = `${SKILL_NAME}-v${version}`;
  const exportable = selectExportableRules(input.rules);

  if (input.profile.mock || input.rules.some((r) => r.mock)) {
    return {
      skillMarkdown: '',
      profileJson: '',
      evidenceMarkdown: null,
      blocked: {
        reason: '本轮结果包含 Mock（开发模拟）数据，不能导出为正式作者 Skill。请关闭 Mock 后重新分析。',
      },
      empty: exportable.length === 0,
      fileNameBase,
    };
  }

  const empty = exportable.length === 0;
  const general = exportable.filter((r) => r.origin === 'observed' && r.scope === 'general');
  const scenario = exportable.filter((r) => r.origin === 'observed' && r.scope !== 'general');
  const preferences = exportable.filter((r) => r.origin === 'preference');
  const avoidRules = exportable.filter((r) => /避免|不要|少用|忌/.test(r.statement));

  const sampleMap = new Map(input.samples.map((s) => [s.id, s]));
  const coveredScenes = Array.from(new Set(exportable.flatMap((r) => r.evidence.map((e) => sampleMap.get(e.sampleId)).flatMap((s) => s?.sceneTags ?? []))));
  const sampleIds = Array.from(new Set(exportable.flatMap((r) => r.evidence.map((e) => e.sampleId))));
  const coveredSamples = sampleIds.map((id) => sampleMap.get(id)).filter((s): s is Sample => Boolean(s));
  const includeEvidence = input.options.includeEvidence;

  const head: string[] = [];
  head.push('---');
  head.push(`name: ${SKILL_NAME}`);
  head.push(`description: ${SKILL_DESCRIPTION}`);
  head.push('---');
  head.push('');
  head.push('# 作者文风 Skill');
  head.push('');

  const sec1: string[] = [];
  sec1.push('## 1. 用途、触发方式与适用范围');
  sec1.push('');
  sec1.push('这是一份**结构化写作指令**，不是训练好的模型权重，也不声称能完美复制作者。');
  sec1.push('当请求里提到“用我的文风”“按作者风格写/审稿”“套用这份 Skill”时应用本文件。');
  sec1.push('');
  sec1.push('- 适用范围：与本 Skill 覆盖场景相近的写作与审稿任务。');
  sec1.push(
    `- 样本覆盖：${coveredSamples.length} 篇样本（${coveredSamples.map((s) => `${s.id.slice(0, 6)}@r${s.revision}`).join('、') || '无'}）${
      coveredScenes.length ? `；场景：${coveredScenes.join('、')}` : '；未标注场景'
    }。`,
  );
  sec1.push('- 超出覆盖范围时，明确说明“这是推测”，或直接按你自己的判断写，不要硬套。');
  sec1.push('');

  const sec2: string[] = [];
  sec2.push('## 2. 核心文风规则');
  sec2.push('');
  if (general.length === 0) {
    sec2.push(empty ? '_（本次没有接受任何规则，这里是明确的空模板。）_' : '_（本次没有被接受为通用习惯的规则。）_');
  } else {
    for (const [i, r] of general.entries()) sec2.push(ruleBlock(r, includeEvidence, i));
  }
  sec2.push('');

  const sec3: string[] = [];
  sec3.push('## 3. 场景差异');
  sec3.push('');
  if (scenario.length === 0) {
    sec3.push('_（没有场景专属规则；按第 2 节处理。）_');
  } else {
    for (const [i, r] of scenario.entries()) {
      sec3.push(ruleBlock(r, includeEvidence, general.length + i));
    }
  }
  sec3.push('');

  const sec4: string[] = [];
  sec4.push('## 4. 作者明确偏好');
  sec4.push('');
  if (preferences.length === 0) {
    sec4.push('_（作者未提出额外偏好。）_');
  } else {
    for (const r of preferences) {
      sec4.push(ruleLine(r));
      if (r.limitations.length) sec4.push(`  - 局限：${r.limitations.join('；')}`);
    }
  }
  sec4.push('');

  const sec5: string[] = [];
  sec5.push('## 5. 具体应避免的表达及例外');
  sec5.push('');
  if (avoidRules.length === 0) {
    sec5.push('- 没有作者明确要求避免的表达；不要自行添加“禁用词表”。');
  } else {
    for (const r of avoidRules) sec5.push(ruleLine(r));
  }
  sec5.push('- 例外：当人物口吻、题材词汇或题目要求本身需要这类表达时，以人物和题目为准，并在审稿意见里说明原因。');
  sec5.push('');

  const sec6: string[] = [];
  sec6.push('## 6. 写作/审稿时的操作步骤与自检');
  sec6.push('');
  sec6.push('写作时：');
  sec6.push('1. 先确定场景，命中第 3 节就优先用场景规则，否则用第 2 节。');
  sec6.push('2. 先写完整段，再按规则回看一遍节奏与用词，不要逐句套模板。');
  sec6.push('3. 引用只用于说明写法，不要求照抄原稿。');
  sec6.push('');
  sec6.push('审稿时逐条自检：');
  sec6.push('- [ ] 有没有把规则机械套到每一句上，导致整篇同一节奏？');
  sec6.push('- [ ] 被规则覆盖的写法，在这段场景里是否真的成立？');
  sec6.push('- [ ] 是否出现了第 5 节要求避免的表达，若有，例外理由是否成立？');
  sec6.push('- [ ] 人物口吻、题材词汇、题目强制要求是否被误当成作者习惯？');
  sec6.push('');

  const sec7: string[] = [];
  sec7.push('## 7. 版本、样本覆盖、局限');
  sec7.push('');
  sec7.push(`- Skill 版本：v${version}`);
  sec7.push(`- 生成时间：${now.toISOString()}`);
  sec7.push(`- 模型 / 提示词版本：${input.profile.model} / ${input.profile.promptVersion || PROMPT_VERSION}`);
  if (input.options.appVersion) sec7.push(`- 工具版本：${input.options.appVersion}`);
  sec7.push(`- 样本覆盖：${coveredSamples.length} 篇；场景：${coveredScenes.join('、') || '未标注'}`);
  const limitations = Array.from(new Set([...input.profile.limitations, ...exportable.flatMap((r) => r.limitations)]));
  sec7.push('- 已知局限：');
  if (limitations.length === 0) {
    sec7.push('  - 样本量与场景覆盖有限，规则只反映已写入样本里能看到的部分。');
  } else {
    for (const l of limitations) sec7.push(`  - ${l}`);
  }
  sec7.push('- 规则来自作者本人样本的归纳，未做统计检验；换一批样本结论可能变化。');
  if (includeEvidence) {
    sec7.push('- 本文件附带的短摘录见 `references/evidence.md`（仅在你选择包含摘录时导出）。');
  }
  sec7.push('');

  const skillMarkdown = [...head, ...sec1, ...sec2, ...sec3, ...sec4, ...sec5, ...sec6, ...sec7].join('\n');

  const profileJson = JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'author-writing-style-profile',
      profileId: input.profile.id,
      version: input.profile.version,
      createdAt: now.toISOString(),
      model: input.profile.model,
      promptVersion: input.profile.promptVersion,
      empty,
      rules: exportable.map((r) => ({
        id: r.id,
        statement: r.statement,
        statementOriginal: r.statementOriginal,
        editedByAuthor: r.statementOriginal !== null && r.statementOriginal !== r.statement,
        userEditReason: r.userEditReason,
        scope: r.scope,
        origin: r.origin,
        supportDescription: r.supportDescription,
        limitations: r.limitations,
        constraintInfluence: r.constraintInfluence,
        evidenceCount: r.evidence.length,
        counterEvidenceCount: r.counterEvidence.length,
        // 证据摘录只在作者明确选择时才写入（默认不导出）。
        evidence: includeEvidence
          ? r.evidence.map((e) => ({ sampleId: e.sampleId, sampleRevision: e.sampleRevision, paragraphId: e.paragraphId, quote: e.quote }))
          : undefined,
      })),
      coverage: {
        samples: coveredSamples.map((s) => ({
          sampleId: s.id,
          revision: s.revision,
          // 只保留 ID、版本、标签与覆盖情况：不含正文快照。
          sceneTags: s.sceneTags,
          entryMode: s.entryMode,
          sourceType: s.sourceType,
          eligibleSource: ELIGIBLE_SOURCE_TYPES.includes(s.sourceType),
          chars: countChars(s.text),
          fragmentIndex: s.fragment?.fragmentIndex ?? null,
        })),
        scenes: coveredScenes,
      },
      limitations,
    },
    null,
    2,
  );

  let evidenceMarkdown: string | null = null;
  if (includeEvidence && exportable.length > 0) {
    const lines: string[] = ['# 原文依据（短摘录）', '', '这些摘录只用于说明写法，不要求照抄原稿。', ''];
    for (const [i, r] of exportable.entries()) {
      lines.push(`## R${i + 1}. ${r.statement}`);
      lines.push('');
      if (r.evidence.length === 0) lines.push('_（作者指定偏好，无原文依据。）_');
      for (const ev of r.evidence) lines.push(`- ${ev.sampleId} ${ev.paragraphId}：${ev.quote}`);
      if (r.counterEvidence.length) {
        lines.push('');
        lines.push('反例：');
        for (const ev of r.counterEvidence) lines.push(`- ${ev.sampleId} ${ev.paragraphId}：${ev.quote}`);
      }
      lines.push('');
    }
    evidenceMarkdown = lines.join('\n');
  }

  return { skillMarkdown, profileJson, evidenceMarkdown, blocked: null, empty, fileNameBase };
}

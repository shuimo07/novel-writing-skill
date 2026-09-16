import { describe, expect, it } from 'vitest';
import { compileExport } from '../src/shared/export';
import { makeAnalysis, makeObservation, makeRule, makeSample } from './fixtures';
import type { Evidence, Sample, StyleProfile, StyleRule } from '../src/shared/schema';

const TEXT_A = '推开门，屋里没有人。\n\n他把伞放在门边，没有开灯，也没有叫她。';
const TEXT_B = '她说：你回来了。\n\n他把伞放在门边，没有开灯，也没有叫她。';
const SECRET_QUOTE = '他把伞放在门边，没有开灯，也没有叫她';

async function world() {
  const s1 = await makeSample({ id: 's1', text: TEXT_A, sceneTags: ['熟悉地点'] });
  const s2 = await makeSample({ id: 's2', text: TEXT_B, sceneTags: ['对话'] });
  const an1 = makeAnalysis(s1, [makeObservation(s1, 2, SECRET_QUOTE)]);
  const an2 = makeAnalysis(s2, [makeObservation(s2, 2, SECRET_QUOTE)]);
  const ev = (s: Sample): Evidence => ({ sampleId: s.id, sampleRevision: s.revision, paragraphId: 'p2', quote: SECRET_QUOTE });

  const accepted = makeRule({
    id: 'r1',
    statement: '用动作代替“他很累”这类情绪判断',
    decision: 'accepted',
    evidence: [ev(s1), ev(s2)],
    supportDescription: '由 2 篇非重复样本支持',
  });
  const pending = makeRule({ id: 'r2', statement: '待确认规则不该出现在导出里', decision: 'pending', evidence: [ev(s1)] });
  const rejected = makeRule({ id: 'r3', statement: '被拒绝规则不该出现在导出里', decision: 'rejected', evidence: [ev(s1)] });
  const stale = makeRule({ id: 'r4', statement: '失效规则不该出现在导出里', decision: 'accepted', stale: true, staleReason: '样本已删除', evidence: [] });
  const edited = makeRule({
    id: 'r5',
    statement: '我习惯让动作承担情绪',
    statementOriginal: '用动作代替情绪判断',
    userEditReason: '改成我自己的说法',
    decision: 'accepted',
    evidence: [ev(s2)],
  });
  const preference = makeRule({
    id: 'r6',
    statement: '以后少用感叹号',
    origin: 'preference',
    decision: 'accepted',
    evidence: [],
    limitations: ['作者指定偏好，无原文依据'],
  });
  const avoid = makeRule({
    id: 'r7',
    statement: '避免连续三个短句堆在一起',
    decision: 'accepted',
    evidence: [ev(s1)],
  });

  const rules: StyleRule[] = [accepted, pending, rejected, stale, edited, preference, avoid];
  const profile: StyleProfile = {
    id: 'prof1',
    version: 3,
    model: 'deepseek-flash',
    promptVersion: 'wsl-p1',
    sampleSnapshot: [
      { sampleId: s1.id, revision: s1.revision, contentHash: s1.contentHash, sceneTags: s1.sceneTags, entryMode: 'task', sourceType: 'self_current', chars: 30, fragmentIndex: null },
      { sampleId: s2.id, revision: s2.revision, contentHash: s2.contentHash, sceneTags: s2.sceneTags, entryMode: 'task', sourceType: 'self_current', chars: 30, fragmentIndex: null },
    ],
    rules,
    coveredScenes: ['熟悉地点', '对话'],
    limitations: ['样本量少，只反映这几篇里看得到的部分'],
    mock: false,
    createdAt: new Date().toISOString(),
  };
  return { s1, s2, an1, an2, rules, profile };
}

describe('Skill 导出：只导出作者确认过且仍然有效的规则', () => {
  it('接受与作者偏好进入导出，待确认/已拒绝/已失效都不进', async () => {
    const w = await world();
    const res = compileExport({ profile: w.profile, samples: [w.s1, w.s2], rules: w.rules, options: { includeEvidence: false } });
    expect(res.blocked).toBeNull();
    expect(res.skillMarkdown).toContain('用动作代替“他很累”这类情绪判断');
    expect(res.skillMarkdown).toContain('我习惯让动作承担情绪');
    expect(res.skillMarkdown).toContain('以后少用感叹号');
    expect(res.skillMarkdown).not.toContain('待确认规则不该出现在导出里');
    expect(res.skillMarkdown).not.toContain('被拒绝规则不该出现在导出里');
    expect(res.skillMarkdown).not.toContain('失效规则不该出现在导出里');
    const json = JSON.parse(res.profileJson);
    expect(json.rules.map((r: { id: string }) => r.id).sort()).toEqual(['r1', 'r5', 'r6', 'r7']);
  });

  it('作者修订保留原说法与理由，不伪造证据', async () => {
    const w = await world();
    const res = compileExport({ profile: w.profile, samples: [w.s1, w.s2], rules: w.rules, options: { includeEvidence: false } });
    expect(res.skillMarkdown).toContain('（作者修订）');
    expect(res.skillMarkdown).toContain('原始说法：用动作代替情绪判断');
    expect(res.skillMarkdown).toContain('修改理由：改成我自己的说法');
    const json = JSON.parse(res.profileJson);
    const edited = json.rules.find((r: { id: string }) => r.id === 'r5');
    expect(edited.evidenceCount).toBe(1);
    expect(edited.evidence).toBeUndefined();
  });

  it('作者指定的偏好被明确标记', async () => {
    const w = await world();
    const res = compileExport({ profile: w.profile, samples: [w.s1, w.s2], rules: w.rules, options: { includeEvidence: false } });
    expect(res.skillMarkdown).toContain('（作者指定偏好）');
  });

  it('默认（不含摘录）时没有原稿、没有指向 evidence.md 的失效链接', async () => {
    const w = await world();
    const res = compileExport({ profile: w.profile, samples: [w.s1, w.s2], rules: w.rules, options: { includeEvidence: false } });
    expect(res.evidenceMarkdown).toBeNull();
    expect(res.skillMarkdown).not.toContain('references/evidence.md');
    expect(res.skillMarkdown).not.toContain(SECRET_QUOTE);
    expect(res.profileJson).not.toContain(SECRET_QUOTE);
    expect(res.skillMarkdown).not.toContain('推开门，屋里没有人');
  });

  it('明确选择包含摘录时才生成 evidence.md，并在 SKILL.md 里给出对应链接', async () => {
    const w = await world();
    const res = compileExport({
      profile: w.profile,
      samples: [w.s1, w.s2],
      rules: w.rules,
      options: { includeEvidence: true },
    });
    expect(res.evidenceMarkdown).not.toBeNull();
    expect(res.evidenceMarkdown).toContain(SECRET_QUOTE);
    expect(res.skillMarkdown).toContain('references/evidence.md');
  });

  it('导出内容里不含密钥、请求日志等敏感信息', async () => {
    const w = await world();
    const res = compileExport({ profile: w.profile, samples: [w.s1, w.s2], rules: w.rules, options: { includeEvidence: true } });
    const all = `${res.skillMarkdown}\n${res.profileJson}\n${res.evidenceMarkdown ?? ''}`;
    expect(all).not.toMatch(/DEEPSEEK_API_KEY|Bearer |sk-[A-Za-z0-9]{8}|github_pat/);
    expect(all).not.toContain('prompt_tokens'); // 请求日志字段不进导出
  });

  it('没有任何被接受的规则时，导出明确标记为空的模板', async () => {
    const w = await world();
    const onlyPending = w.rules.map((r) => ({ ...r, decision: 'pending' as const }));
    const res = compileExport({ profile: w.profile, samples: [w.s1, w.s2], rules: onlyPending, options: { includeEvidence: false } });
    expect(res.empty).toBe(true);
    expect(res.blocked).toBeNull();
    expect(res.skillMarkdown).toContain('明确的空模板');
    expect(JSON.parse(res.profileJson).empty).toBe(true);
  });

  it('Mock 结果一律不能导出为正式作者 Skill', async () => {
    const w = await world();
    const res = compileExport({
      profile: { ...w.profile, mock: true },
      samples: [w.s1, w.s2],
      rules: w.rules,
      options: { includeEvidence: false },
    });
    expect(res.blocked?.reason).toContain('Mock');
    expect(res.skillMarkdown).toBe('');
    expect(res.profileJson).toBe('');
  });

  it('SKILL.md 带 YAML frontmatter 与七个小节', async () => {
    const w = await world();
    const res = compileExport({ profile: w.profile, samples: [w.s1, w.s2], rules: w.rules, options: { includeEvidence: false } });
    expect(res.skillMarkdown.startsWith('---\nname: author-writing-style\n')).toBe(true);
    for (const heading of [
      '## 1. 用途、触发方式与适用范围',
      '## 2. 核心文风规则',
      '## 3. 场景差异',
      '## 4. 作者明确偏好',
      '## 5. 具体应避免的表达及例外',
      '## 6. 写作/审稿时的操作步骤与自检',
      '## 7. 版本、样本覆盖、局限',
    ]) {
      expect(res.skillMarkdown).toContain(heading);
    }
  });

  it('style-profile.json 只保留样本 ID、版本、标签与覆盖情况', async () => {
    const w = await world();
    const res = compileExport({ profile: w.profile, samples: [w.s1, w.s2], rules: w.rules, options: { includeEvidence: false } });
    const json = JSON.parse(res.profileJson);
    expect(json.coverage.samples.map((s: { sampleId: string }) => s.sampleId).sort()).toEqual(['s1', 's2']);
    expect(JSON.stringify(json.coverage)).not.toContain('他把伞');
    expect(json.coverage.samples[0]).not.toHaveProperty('text');
  });
});

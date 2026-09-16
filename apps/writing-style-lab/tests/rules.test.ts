import { describe, expect, it } from 'vitest';
import {
  buildCandidates,
  checkEvidenceAgainstStore,
  collectVerifiedEvidenceKeys,
  constraintOverlap,
  describeExclusion,
  isSampleEligible,
  recomputeAllRules,
  recomputeRuleValidity,
  selectExportableRules,
  selectSendableSamples,
  stripEvidenceForSamples,
} from '../src/shared/rules';
import { makeAnalysis, makeObservation, makeRule, makeSample, ctxSample } from './fixtures';
import type { Evidence, ModelRule, Sample, SampleAnalysis } from '../src/shared/schema';

const TEXT_A = '推开门，屋里没有人。\n\n他把伞放在门边，没有开灯。';
const TEXT_B = '她说：你回来了。\n\n他把伞放在门边，没有开灯。';
const TEXT_C = '灯没开。\n\n他把伞放在门边，没有开灯。';

async function buildWorld() {
  const a = await makeSample({ id: 'sA', text: TEXT_A, sceneTags: ['熟悉地点'] });
  const b = await makeSample({ id: 'sB', text: TEXT_B, sceneTags: ['对话'] });
  const c = await makeSample({ id: 'sC', text: TEXT_C, sceneTags: ['情绪'] });
  const aAn = makeAnalysis(a, [makeObservation(a, 2, '他把伞放在门边，没有开灯', { claim: '用动作代替情绪词' })]);
  const bAn = makeAnalysis(b, [makeObservation(b, 2, '他把伞放在门边，没有开灯', { claim: '用动作代替情绪词' })]);
  const cAn = makeAnalysis(c, [makeObservation(c, 2, '他把伞放在门边，没有开灯', { claim: '用动作代替情绪词' })]);
  return { a, b, c, aAn, bAn, cAn };
}

describe('来源门禁：不该发的样本默认不发', () => {
  it('AI 生成、人机混合、未确认来源都进不了提炼清单', async () => {
    const ai = await makeSample({ text: '甲。', sourceType: 'ai_generated' });
    const mixed = await makeSample({ text: '乙。', sourceType: 'mixed' });
    const unknown = await makeSample({ text: '丙。', sourceType: 'unconfirmed' });
    const mine = await makeSample({ text: '丁。', sourceType: 'self_old' });
    expect(selectSendableSamples([ai, mixed, unknown, mine]).map((s) => s.id)).toEqual([mine.id]);
    expect(describeExclusion(ai)).toContain('AI 生成');
    expect(describeExclusion(unknown)).toContain('未确认来源');
  });

  it('holdout 与已移出本轮样本集的样本不发送，并给出原因', async () => {
    const holdout = await makeSample({ text: '甲。', holdout: true });
    const removed = await makeSample({ text: '乙。', useForAnalysis: false });
    const ok = await makeSample({ text: '丙。' });
    expect(isSampleEligible(holdout)).toBe(false);
    expect(isSampleEligible(removed)).toBe(false);
    expect(selectSendableSamples([holdout, removed, ok])).toHaveLength(1);
    expect(describeExclusion(holdout)).toContain('保留样本');
    expect(describeExclusion(removed)).toContain('移出本轮样本集');
  });
});

describe('归纳后处理：程序说了算的部分', () => {
  const ruleOf = (quote: string, statement: string, over: Partial<ModelRule> = {}): ModelRule => ({
    statement,
    scope: 'general',
    origin: 'observed',
    evidence: [{ paragraphId: 'p2', quote }],
    counterEvidence: [],
    supportDescription: '',
    limitations: [],
    ...over,
  });
  /** 角色 2 的输出应当带 sampleId；不带时只有唯一匹配才允许。 */
  const multiRule = (statement: string, hits: { sampleId: string; quote: string }[], over: Partial<ModelRule> = {}): ModelRule => ({
    statement,
    scope: 'general',
    origin: 'observed',
    evidence: hits.map((h) => ({ sampleId: h.sampleId, paragraphId: 'p2', quote: h.quote })),
    counterEvidence: [],
    supportDescription: '',
    limitations: [],
    ...over,
  });

  it('引用不在已校验分析里 → 拒绝这条候选', async () => {
    const { a, aAn } = await buildWorld();
    const res = buildCandidates({
      rawRules: [ruleOf('原文里根本没有这句', '作者爱用短句')],
      samples: [ctxSample(a, aAn)],
      previousRules: [],
    });
    expect(res.candidates).toHaveLength(0);
    expect(res.rejected[0].reason).toContain('不在已通过校验的分析中');
  });

  it('只有一篇样本支持 → 降级为初步观察，不当成通用习惯', async () => {
    const { a, aAn } = await buildWorld();
    const res = buildCandidates({
      rawRules: [ruleOf('他把伞放在门边，没有开灯', '用动作代替情绪词')],
      samples: [ctxSample(a, aAn)],
      previousRules: [],
    });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].scope).toBe('preliminary');
    expect(res.candidates[0].limitations.join('')).toContain('非重复样本');
  });

  it('两篇不同样本支持 → 保持通用习惯', async () => {
    const { a, b, aAn, bAn } = await buildWorld();
    const res = buildCandidates({
      rawRules: [
        multiRule('用动作代替情绪词', [
          { sampleId: 'sA', quote: '他把伞放在门边，没有开灯' },
          { sampleId: 'sB', quote: '他把伞放在门边，没有开灯' },
        ]),
      ],
      samples: [ctxSample(a, aAn), ctxSample(b, bAn)],
      previousRules: [],
    });
    expect(res.candidates[0].scope).toBe('general');
    expect(res.candidates[0].evidence).toHaveLength(2);
  });

  it('同一句在两篇里都能找到而模型没给 sampleId → 无法定位，拒绝该条', async () => {
    const { a, b, aAn, bAn } = await buildWorld();
    const res = buildCandidates({
      rawRules: [ruleOf('他把伞放在门边，没有开灯', '用动作代替情绪词')],
      samples: [ctxSample(a, aAn), ctxSample(b, bAn)],
      previousRules: [],
    });
    expect(res.candidates).toHaveLength(0);
    expect(res.rejected[0].reason).toContain('无法定位');
  });

  it('同一篇文稿切出来的两个片段只算一份证据', async () => {
    const { a, aAn, bAn } = await buildWorld();
    const frag1 = await makeSample({
      id: 'frag1',
      text: '他把伞放在门边，没有开灯',
      sourceDocumentId: 'doc1',
      entryMode: 'direct',
      sourceType: 'self_old',
    });
    const frag2 = await makeSample({
      id: 'frag2',
      text: '他把伞放在门边，没有开灯',
      sourceDocumentId: 'doc1',
      entryMode: 'direct',
      sourceType: 'self_old',
    });
    const fragAn1 = makeAnalysis(frag1, [makeObservation(frag1, 1, '他把伞放在门边，没有开灯')]);
    const fragAn2 = makeAnalysis(frag2, [makeObservation(frag2, 1, '他把伞放在门边，没有开灯')]);
    void a;
    void aAn;
    void bAn;
    const res = buildCandidates({
      rawRules: [
        {
          statement: '用动作代替情绪词',
          scope: 'general',
          origin: 'observed',
          evidence: [
            { sampleId: 'frag1', paragraphId: 'p1', quote: '他把伞放在门边，没有开灯' },
            { sampleId: 'frag2', paragraphId: 'p1', quote: '他把伞放在门边，没有开灯' },
          ],
          counterEvidence: [],
          supportDescription: '',
          limitations: [],
        },
      ],
      samples: [ctxSample(frag1, fragAn1), ctxSample(frag2, fragAn2)],
      previousRules: [],
    });
    expect(res.candidates[0].scope).toBe('preliminary');
    expect(res.candidates[0].supportDescription).toContain('1 篇非重复样本');
  });

  it('题目强制“全用短句”时，短句特征不许被归为通用偏好', async () => {
    const { a, b, aAn, bAn } = await buildWorld();
    const res = buildCandidates({
      rawRules: [
        multiRule('作者习惯用短句，句子普遍很短', [
          { sampleId: 'sA', quote: '他把伞放在门边，没有开灯' },
          { sampleId: 'sB', quote: '他把伞放在门边，没有开灯' },
        ]),
      ],
      samples: [
        ctxSample(a, aAn, { taskConstraints: ['全用短句'] }),
        ctxSample(b, bAn, { taskConstraints: ['全用短句'] }),
      ],
      previousRules: [],
    });
    const rule = res.candidates[0];
    expect(rule.scope).toBe('scenario_specific');
    expect(rule.limitations.join('')).toContain('强制要求重合');
    expect(rule.scope).not.toBe('general');
  });

  it('约束关键词重合检测能识别“全用短句”这类要求', () => {
    expect(constraintOverlap('作者偏爱短句收束', ['全用短句'])).toBe('全用短句');
    expect(constraintOverlap('喜欢在段末留白', ['全用短句'])).toBeNull();
  });

  it('支持样本全部来自直接采样（无题目约束）时，不许断言为通用习惯', async () => {
    const d1 = await makeSample({ id: 'd1', text: TEXT_A, entryMode: 'direct', sourceType: 'self_old', sourceDocumentId: 'doc1' });
    const d2 = await makeSample({ id: 'd2', text: TEXT_B, entryMode: 'direct', sourceType: 'self_old', sourceDocumentId: 'doc2' });
    const an1 = makeAnalysis(d1, [makeObservation(d1, 2, '他把伞放在门边，没有开灯')]);
    const an2 = makeAnalysis(d2, [makeObservation(d2, 2, '他把伞放在门边，没有开灯')]);
    const res = buildCandidates({
      rawRules: [
        {
          statement: '用动作代替情绪词',
          scope: 'general',
          origin: 'observed',
          evidence: [
            { sampleId: 'd1', paragraphId: 'p2', quote: '他把伞放在门边，没有开灯' },
            { sampleId: 'd2', paragraphId: 'p2', quote: '他把伞放在门边，没有开灯' },
          ],
          counterEvidence: [],
          supportDescription: '',
          limitations: [],
        },
      ],
      samples: [ctxSample(d1, an1, { constraintKnown: false }), ctxSample(d2, an2, { constraintKnown: false })],
      previousRules: [],
    });
    expect(res.candidates[0].scope).toBe('scenario_specific');
    expect(res.candidates[0].limitations.join('')).toContain('没有题目/体裁约束信息');
  });

  it('与上一轮作者已拒绝的规则相似时给出差异提示，不覆盖作者决定', async () => {
    const { a, b, aAn, bAn } = await buildWorld();
    const res = buildCandidates({
      rawRules: [
        multiRule('用动作代替情绪词', [
          { sampleId: 'sA', quote: '他把伞放在门边，没有开灯' },
          { sampleId: 'sB', quote: '他把伞放在门边，没有开灯' },
        ]),
      ],
      samples: [ctxSample(a, aAn), ctxSample(b, bAn)],
      previousRules: [{ id: 'r_old', statement: '用动作代替情绪词', decision: 'rejected' }],
    });
    expect(res.candidates[0].conflictsWithPrevious).toHaveLength(1);
    expect(res.candidates[0].conflictsWithPrevious[0].decision).toBe('rejected');
  });
});

describe('版本失效：样本一改，规则依据必须重验', () => {
  async function world() {
    const a = await makeSample({ id: 'sA', text: TEXT_A });
    const b = await makeSample({ id: 'sB', text: TEXT_B });
    const anA = makeAnalysis(a, [makeObservation(a, 2, '他把伞放在门边，没有开灯')]);
    const anB = makeAnalysis(b, [makeObservation(b, 2, '他把伞放在门边，没有开灯')]);
    const ev = (s: Sample): Evidence => ({
      sampleId: s.id,
      sampleRevision: s.revision,
      paragraphId: 'p2',
      quote: '他把伞放在门边，没有开灯',
    });
    const rule = makeRule({ statement: '用动作代替情绪词', evidence: [ev(a), ev(b)], decision: 'accepted' });
    return { a, b, anA, anB, rule };
  }

  it('把一篇样本改成 holdout → 规则失效且不再可导出', async () => {
    const w = await world();
    const held = { ...w.b, holdout: true };
    const updated = recomputeRuleValidity(w.rule, { samples: [w.a, held], analyses: [w.anA, w.anB], preferences: [] });
    expect(updated.stale).toBe(true);
    expect(updated.evidence).toHaveLength(1);
    expect(updated.staleReason).toContain('保留样本');
    expect(selectExportableRules([updated])).toHaveLength(0);
  });

  it('样本正文版本变化 → 引用失效', async () => {
    const w = await world();
    const edited = { ...w.b, revision: 2 };
    const updated = recomputeRuleValidity(w.rule, { samples: [w.a, edited], analyses: [w.anA, w.anB], preferences: [] });
    expect(updated.stale).toBe(true);
    expect(updated.staleReason).toContain('正文版本已变');
  });

  it('样本被删除 → 证据被清空、规则失效', async () => {
    const w = await world();
    const stripped = stripEvidenceForSamples([w.rule], ['sB'])[0];
    expect(stripped.evidence).toHaveLength(1);
    expect(stripped.stale).toBe(true);
    const updated = recomputeRuleValidity(stripped, { samples: [w.a], analyses: [w.anA], preferences: [] });
    expect(updated.stale).toBe(true);
    expect(selectExportableRules([updated])).toHaveLength(0);
  });

  it('把来源改成 AI 生成 → 证据失效', async () => {
    const w = await world();
    const ai = { ...w.b, sourceType: 'ai_generated' as const };
    const updated = recomputeRuleValidity(w.rule, { samples: [w.a, ai], analyses: [w.anA, w.anB], preferences: [] });
    expect(updated.stale).toBe(true);
    expect(updated.staleReason).toContain('来源已改为');
  });

  it('有效支持不足两篇的通用规则降级为初步观察', async () => {
    const w = await world();
    const updated = recomputeRuleValidity(w.rule, { samples: [w.a], analyses: [w.anA], preferences: [] });
    expect(updated.scope).toBe('preliminary');
    expect(updated.stale).toBe(true);
  });

  it('全部有效时规则保持不变、可导出', async () => {
    const w = await world();
    const updated = recomputeRuleValidity(w.rule, { samples: [w.a, w.b], analyses: [w.anA, w.anB], preferences: [] });
    expect(updated.stale).toBe(false);
    expect(selectExportableRules([updated])).toHaveLength(1);
  });

  it('作者已拒绝的规则不会被重算改回待确认或接受', async () => {
    const w = await world();
    const rejected = { ...w.rule, decision: 'rejected' as const };
    const [updated] = recomputeAllRules([rejected], { samples: [w.a, w.b], analyses: [w.anA, w.anB], preferences: [] });
    expect(updated.decision).toBe('rejected');
    expect(selectExportableRules([updated])).toHaveLength(0);
  });

  it('作者改过的说法在重算后保留，不被模型说法覆盖', async () => {
    const w = await world();
    const edited = { ...w.rule, statement: '我习惯用动作承载情绪', statementOriginal: '用动作代替情绪词' };
    const [updated] = recomputeAllRules([edited], { samples: [w.a, w.b], analyses: [w.anA, w.anB], preferences: [] });
    expect(updated.statement).toBe('我习惯用动作承载情绪');
    expect(updated.statementOriginal).toBe('用动作代替情绪词');
  });

  it('缺少关联分析时引用无效', async () => {
    const w = await world();
    const check = checkEvidenceAgainstStore(w.rule.evidence[1], { samples: [w.a, w.b], analyses: [w.anA], preferences: [] });
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('缺少对应的有效分析');
  });

  it('分析状态为 rejected 时不能作为依据', async () => {
    const w = await world();
    const dead: SampleAnalysis = { ...w.anB, status: 'rejected', observations: [] };
    const check = checkEvidenceAgainstStore(w.rule.evidence[1], { samples: [w.a, w.b], analyses: [w.anA, dead], preferences: [] });
    expect(check.valid).toBe(false);
  });

  it('已验证证据集合只包含有效分析中的证据', async () => {
    const w = await world();
    const keys = collectVerifiedEvidenceKeys([ctxSample(w.a, w.anA), ctxSample(w.b, w.anB)]);
    expect(keys.size).toBe(2);
  });
});

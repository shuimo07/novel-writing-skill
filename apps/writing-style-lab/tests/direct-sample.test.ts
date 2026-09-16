import { describe, expect, it } from 'vitest';
import { computeTextStats, contentHash, joinFragments, planSplit, receiptFeatures, splitParagraphs } from '../src/shared/text';
import { buildCandidates, isSampleEligible, selectSendableSamples } from '../src/shared/rules';
import { ctxSample, makeAnalysis, makeObservation, makeSample } from './fixtures';

/** 故意做得很难缠的正文：BOM + CRLF + 零宽字符 + emoji + 段内单换行。 */
const TRICKY = '\uFEFF他推开门。\r\n\r\n屋里没有人👩‍🚀\u200B，\r\n他把伞放在门边。\r\n\r\n她没有回头，也没有开灯。';

describe('直接采样：把已经写好的文字丢进来', () => {
  it('入库前后原文逐字一致，程序不做任何“顺手清理”', async () => {
    const sample = await makeSample({
      text: TRICKY,
      entryMode: 'direct',
      sourceType: 'self_old',
      sourceDocumentId: 'doc1',
    });
    expect(sample.text).toBe(TRICKY);
    expect(sample.text).toContain('\uFEFF');
    expect(sample.text).toContain('\r\n');
    expect(sample.text).toContain('\u200B');
    expect(sample.text).toContain('👩‍🚀');
    expect(sample.contentHash).toBe(await contentHash(TRICKY));
  });

  it('接收特征如实报告，便于界面说明“没有帮你规范化”', () => {
    const f = receiptFeatures(TRICKY);
    expect(f.lineEnding).toBe('crlf');
    expect(f.hasBom).toBe(true);
    expect(f.hasZeroWidth).toBe(true);
    expect(f.chars).toBeLessThan(f.utf16Length); // 码点口径与 UTF-16 长度确实不同（emoji + 换行）
  });

  it('统计、切分、切片段都不改动原字符串', () => {
    const before = TRICKY;
    receiptFeatures(TRICKY);
    splitParagraphs(TRICKY);
    computeTextStats(TRICKY);
    planSplit(TRICKY, 8);
    expect(TRICKY).toBe(before);
  });

  it('直接采样样本的段落偏移仍然精确指向原文', async () => {
    const sample = await makeSample({ text: TRICKY, entryMode: 'direct', sourceType: 'self_old' });
    for (const p of sample.paragraphs) {
      expect(p.text).toBe(TRICKY.slice(p.start, p.end));
    }
  });

  it('超限长文按分区切分，逐字拼接后与原文完全一致，且不静默截断', () => {
    const long = Array.from({ length: 50 }, (_, i) => `第${i + 1}段：他把伞放在门边，没有开灯。`).join('\r\n\r\n');
    const plan = planSplit(long, 200);
    expect(plan.needsSplit).toBe(true);
    expect(joinFragments(long, plan.fragments)).toBe(long);
    expect(plan.totalChars).toBeGreaterThan(200);
    for (const f of plan.fragments) {
      expect(long.slice(f.start, f.end)).toHaveLength(f.end - f.start);
    }
  });

  it('同一篇文稿切出的片段在归纳里只算一份证据', async () => {
    const doc = '他把伞放在门边，没有开灯。\r\n\r\n她把窗户推开，没有说话。';
    const plan = planSplit(doc, 12);
    expect(plan.fragments.length).toBeGreaterThan(1);
    const frags = await Promise.all(
      plan.fragments.map((f, i) =>
        makeSample({
          id: `frag${i + 1}`,
          text: doc.slice(f.start, f.end),
          entryMode: 'direct',
          sourceType: 'self_old',
          sourceDocumentId: 'doc1',
          fragment: {
            fragmentIndex: f.index,
            fragmentCount: plan.fragments.length,
            start: f.start,
            end: f.end,
            splitInsideParagraph: f.splitInsideParagraph,
          },
        }),
      ),
    );
    const analyses = frags.map((s) => makeAnalysis(s, [makeObservation(s, 1, '他把伞放在门边，没有开灯')].filter(() => s.text.includes('他把伞放在门边，没有开灯'))));
    const usable = frags
      .map((s, i) => ({ s, an: analyses[i] }))
      .filter(({ an }) => an.observations.length > 0);
    expect(usable.length).toBeGreaterThan(0);
    const res = buildCandidates({
      rawRules: [
        {
          statement: '用动作代替情绪判断',
          scope: 'general',
          origin: 'observed',
          evidence: usable.map(({ s }) => ({ sampleId: s.id, paragraphId: 'p1', quote: '他把伞放在门边，没有开灯' })),
          counterEvidence: [],
          supportDescription: '',
          limitations: [],
        },
      ],
      samples: usable.map(({ s, an }) => ctxSample(s, an, { constraintKnown: false })),
      previousRules: [],
    });
    expect(res.candidates[0].supportDescription).toContain('1 篇非重复样本');
    expect(res.candidates[0].scope).not.toBe('general');
  });

  it('片段信息完整记录，便于作者核对切分是否合理', async () => {
    const sample = await makeSample({
      text: '甲段。',
      entryMode: 'direct',
      sourceType: 'self_old',
      sourceDocumentId: 'doc9',
      fragment: { fragmentIndex: 2, fragmentCount: 3, start: 100, end: 140, splitInsideParagraph: true },
    });
    expect(sample.fragment?.fragmentIndex).toBe(2);
    expect(sample.fragment?.splitInsideParagraph).toBe(true);
    expect(sample.sourceDocumentId).toBe('doc9');
  });

  it('来源自述决定能不能进提炼：选“含 AI 生成”或“不确定”默认不发送', async () => {
    const mine = await makeSample({ text: '甲。', entryMode: 'direct', sourceType: 'self_old' });
    const ai = await makeSample({ text: '乙。', entryMode: 'direct', sourceType: 'ai_generated' });
    const unsure = await makeSample({ text: '丙。', entryMode: 'direct', sourceType: 'unconfirmed' });
    expect(isSampleEligible(mine)).toBe(true);
    expect(isSampleEligible(ai)).toBe(false);
    expect(isSampleEligible(unsure)).toBe(false);
    expect(selectSendableSamples([mine, ai, unsure]).map((s) => s.id)).toEqual([mine.id]);
  });

  it('直接采样样本没有题目约束：taskVersion 为空且约束未知', async () => {
    const direct = await makeSample({ text: '甲。', entryMode: 'direct', sourceType: 'self_old' });
    expect(direct.entryMode).toBe('direct');
    expect(direct.taskId).toBeNull();
    expect(direct.taskVersion).toBeNull();
    expect(direct.taskConstraintsHash).toBeNull();
  });

  it('“仅前 X 字参与分析”必须显式标记为部分样本并写明说明', async () => {
    const full = '甲'.repeat(100) + '。' + '乙'.repeat(100) + '。';
    const head = Array.from(full).slice(0, 40).join('');
    const partial = await makeSample({
      text: head,
      entryMode: 'direct',
      sourceType: 'self_old',
      partial: true,
      partialNote: '仅前 40 字参与分析（作者显式选择，未静默截断）',
    });
    expect(partial.partial).toBe(true);
    expect(partial.partialNote).toContain('未静默截断');
    expect(partial.text).toBe(head);
    expect(full.startsWith(head)).toBe(true);
  });
});

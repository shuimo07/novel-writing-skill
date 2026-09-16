import { describe, expect, it } from 'vitest';
import {
  NEAR_DUPLICATE_THRESHOLD,
  computeStylometry,
  contentSimilarity,
  countIndependentSupports,
  crossCheckClaims,
  stylometryLines,
} from '../src/shared/stylometry';
import { StylometrySchema } from '../src/shared/schema';
import { gateAnalysisOutput } from '../src/shared/verify';
import { buildCandidates } from '../src/shared/rules';
import { computeTextStats } from '../src/shared/text';
import { makeAnalysis, makeObservation, makeRule, makeSample, ctxSample } from './fixtures';

const SHORT_TEXT = '灯没开。她没说话。他放下伞。';

const LONG_TEXT =
  '他把伞收起来靠在门边然后慢慢走进屋子里没有开灯也没有叫她一声。\n\n她在厨房里忙着收拾碗筷听见声音也没有回头只是轻轻应了一声。';

describe('本地风格学统计：确定性、归一化、可复现', () => {
  it('同样输入永远得到同样结果（无随机因素）', () => {
    expect(computeStylometry(LONG_TEXT)).toEqual(computeStylometry(LONG_TEXT));
  });

  it('统计结果符合 shared/schema 的口径（防字段漂移）', () => {
    const parsed = StylometrySchema.safeParse(computeStylometry(LONG_TEXT));
    expect(parsed.success).toBe(true);
  });

  it('句长分布给出的是数字，不是“喜欢用短句”这种空话', () => {
    const s = computeStylometry(SHORT_TEXT);
    expect(s.sentenceCount).toBe(3);
    expect(s.sentenceMeanChars).toBeLessThan(8);
    expect(s.shortSentenceRatio).toBe(1);
    expect(s.sentenceMaxChars).toBeLessThanOrEqual(8);

    const l = computeStylometry(LONG_TEXT);
    expect(l.sentenceMeanChars).toBeGreaterThan(20);
    expect(l.shortSentenceRatio).toBe(0);
    expect(l.longSentenceRatio).toBeGreaterThan(0);
  });

  it('标点密度是归一化的（每 100 字），文本变长不会把密度抬高', () => {
    const once = computeStylometry(LONG_TEXT);
    const twice = computeStylometry(`${LONG_TEXT}\n\n${LONG_TEXT}`);
    expect(twice.punctuationPer100['逗号']).toBeCloseTo(once.punctuationPer100['逗号'], 1);
    expect(twice.punctuationPer100['句号']).toBeCloseTo(once.punctuationPer100['句号'], 1);
  });

  it('没有出现的标点密度为 0，能被交叉核对抓到', () => {
    const s = computeStylometry(SHORT_TEXT);
    expect(s.punctuationPer100['感叹号']).toBe(0);
    expect(s.punctuationPer100['问号']).toBe(0);
  });

  it('人称占比与代词密度来自实际统计', () => {
    const s = computeStylometry('我看着她。你也看着他。');
    const sum = s.pronounShare.first + s.pronounShare.second + s.pronounShare.third;
    expect(sum).toBeCloseTo(1, 2);
    expect(s.pronounPer100).toBeGreaterThan(0);
  });

  it('用字数（去重）与字次分开，中文不需要分词', () => {
    const s = computeStylometry('甲甲乙乙');
    expect(s.charTokens).toBe(4);
    expect(s.charTypes).toBe(2);
    expect(s.typeTokenRatio).toBe(0.5);
  });

  it('高频二字组合只保留出现 2 次以上的，并声明不是词频', () => {
    const s = computeStylometry('下雨了下雨了下雨了');
    expect(s.topBigrams.length).toBeGreaterThan(0);
    expect(s.topBigrams.every((t) => t.count >= 2)).toBe(true);
    expect(stylometryLines(s).join('')).toContain('非词频');
  });
});

describe('拿实测值交叉核对模型的说法', () => {
  const long = computeStylometry(LONG_TEXT);
  const short = computeStylometry(SHORT_TEXT);

  it('说“偏爱短句”但实测平均句长 20 字以上 → 给出不一致提示', () => {
    const notes = crossCheckClaims('作者偏爱短句，句子都很短', 'rhythm', long);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('平均句长');
    expect(notes[0]).toContain('请核对');
  });

  it('说法与实测一致时不打扰作者', () => {
    expect(crossCheckClaims('句子都很短，停顿密集', 'rhythm', short)).toEqual([]);
  });

  it('说用感叹号但本篇一个都没有 → 提示不一致', () => {
    const notes = crossCheckClaims('常用感叹号收尾', 'rhythm', short);
    expect(notes.join('')).toContain('没有出现感叹号');
  });

  it('说对白多但本篇没有引号 → 提示不一致', () => {
    const notes = crossCheckClaims('对白推动情节', 'dialogue', long);
    expect(notes.join('')).toContain('没有引号内文字');
  });

  it('提示只是局限说明，不改写原句也不删观察', () => {
    const notes = crossCheckClaims('作者偏爱短句', 'rhythm', long);
    expect(notes[0]).not.toContain('改为');
    expect(notes[0]).toContain('程序统计');
  });
});

describe('近似重复样本只算一份证据', () => {
  const baseText = '他把伞收起来，靠在门边，没有开灯，也没有叫她，屋子里安静得能听见钟表走动的声音。';
  const dupText = '他把伞收起来，靠在门边，没有开灯，也没有叫她，屋子里安静得能听见钟摆走动的声音。';

  it('相似度：完全相同为 1，改一个字仍然很高，完全不同的很低', () => {
    expect(contentSimilarity(baseText, baseText)).toBe(1);
    expect(contentSimilarity(baseText, dupText)).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
    expect(contentSimilarity(baseText, '我们在山顶看日出，风很大，云走得很慢。')).toBeLessThan(0.2);
  });

  it('同一文稿的片段算一份', () => {
    expect(
      countIndependentSupports([
        { id: 'f1', text: '甲甲甲', sourceDocumentId: 'doc1' },
        { id: 'f2', text: '乙乙乙', sourceDocumentId: 'doc1' },
      ]),
    ).toBe(1);
  });

  it('近似重复的两篇算一份（复制粘贴凑不出“两篇支持”）', () => {
    expect(
      countIndependentSupports([
        { id: 's1', text: baseText, sourceDocumentId: 'doc1' },
        { id: 's2', text: dupText, sourceDocumentId: 'doc2' },
      ]),
    ).toBe(1);
  });

  it('真正不同的两篇算两份', () => {
    expect(
      countIndependentSupports([
        { id: 's1', text: baseText, sourceDocumentId: 'doc1' },
        { id: 's2', text: '我们在山顶看日出，风很大，云走得很慢。', sourceDocumentId: 'doc2' },
      ]),
    ).toBe(2);
  });

  it('归纳时近似重复样本不会凑出通用规则', async () => {
    const s1 = await makeSample({ id: 's1', text: baseText, sourceDocumentId: 'doc1' });
    const s2 = await makeSample({ id: 's2', text: dupText, sourceDocumentId: 'doc2' });
    const an1 = makeAnalysis(s1, [makeObservation(s1, 1, '他把伞收起来，靠在门边，没有开灯')]);
    const an2 = makeAnalysis(s2, [makeObservation(s2, 1, '他把伞收起来，靠在门边，没有开灯')]);
    const res = buildCandidates({
      rawRules: [
        {
          statement: '用动作代替情绪判断',
          scope: 'general',
          origin: 'observed',
          evidence: [
            { sampleId: 's1', paragraphId: 'p1', quote: '他把伞收起来，靠在门边，没有开灯' },
            { sampleId: 's2', paragraphId: 'p1', quote: '他把伞收起来，靠在门边，没有开灯' },
          ],
          counterEvidence: [],
          supportDescription: '',
          limitations: [],
        },
      ],
      samples: [ctxSample(s1, an1, { textSample: baseText }), ctxSample(s2, an2, { textSample: dupText })],
      previousRules: [],
    });
    expect(res.candidates[0].scope).toBe('preliminary');
  });

  it('规则重算也按“独立支持”算，近似重复不会撑住通用规则', async () => {
    const { recomputeRuleValidity, selectExportableRules } = await import('../src/shared/rules');
    const s1 = await makeSample({ id: 's1', text: baseText, sourceDocumentId: 'doc1' });
    const s2 = await makeSample({ id: 's2', text: dupText, sourceDocumentId: 'doc2' });
    const an1 = makeAnalysis(s1, [makeObservation(s1, 1, '他把伞收起来，靠在门边，没有开灯')]);
    const an2 = makeAnalysis(s2, [makeObservation(s2, 1, '他把伞收起来，靠在门边，没有开灯')]);
    const rule = makeRule({
      id: 'r1',
      statement: '用动作代替情绪判断',
      scope: 'general',
      decision: 'accepted',
      evidence: [
        { sampleId: 's1', sampleRevision: 1, paragraphId: 'p1', quote: '他把伞收起来，靠在门边，没有开灯' },
        { sampleId: 's2', sampleRevision: 1, paragraphId: 'p1', quote: '他把伞收起来，靠在门边，没有开灯' },
      ],
    });
    const updated = recomputeRuleValidity(rule, { samples: [s1, s2], analyses: [an1, an2], preferences: [] });
    expect(updated.stale).toBe(true);
    expect(updated.scope).toBe('preliminary');
    expect(selectExportableRules([updated])).toHaveLength(0);
  });
});

describe('分析关卡接上风格学统计', () => {
  it('分析记录带上统计，并给与实测不一致的说法加上局限提示', async () => {
    const sample = await makeSample({ id: 'sq', text: LONG_TEXT });
    const analysis = gateAnalysisOutput({
      sampleId: sample.id,
      sampleRevision: sample.revision,
      contentHash: sample.contentHash,
      taskConstraintsHash: null,
      paragraphs: sample.paragraphs,
      stats: computeTextStats(LONG_TEXT, sample.paragraphs),
      text: LONG_TEXT,
      model: 'deepseek-flash',
      promptVersion: 'wsl-p1',
      temperature: 0.2,
      maxTokens: 4096,
      runId: 'run_x',
      mock: false,
      elapsedMs: 50,
      constraintKnown: true,
      rawContent: JSON.stringify({
        observations: [
          {
            dimension: 'rhythm',
            claim: '作者偏爱短句，句子都很短',
            evidence: [{ paragraphId: 'p1', quote: '他把伞收起来靠在门边' }],
          },
        ],
      }),
    });
    expect(analysis.status).toBe('ok');
    expect(analysis.stylometry?.sentenceMeanChars).toBeGreaterThan(20);
    expect(analysis.observations[0].limitations.join('')).toContain('程序统计与这条说法不一致');
    expect(analysis.stats.chars).toBe(computeTextStats(LONG_TEXT).chars);
  });
});

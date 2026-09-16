import { describe, expect, it } from 'vitest';
import { gateAnalysisOutput } from '../src/shared/verify';
import { computeTextStats } from '../src/shared/text';
import { makeSample } from './fixtures';
import type { Sample } from '../src/shared/schema';

const TEXT = '他把伞收起来，靠在门边。\n\n「你回来了。」她说。';

async function setup(over: { constraintKnown?: boolean } = {}) {
  const sample: Sample = await makeSample({ text: TEXT });
  return {
    sample,
    base: {
      sampleId: sample.id,
      sampleRevision: sample.revision,
      contentHash: sample.contentHash,
      taskConstraintsHash: null,
      paragraphs: sample.paragraphs,
      stats: computeTextStats(TEXT, sample.paragraphs),
      text: TEXT,
      model: 'deepseek-flash',
      promptVersion: 'wsl-p1',
      temperature: 0.2,
      maxTokens: 4096,
      runId: 'run_test',
      mock: false,
      elapsedMs: 100,
      constraintKnown: over.constraintKnown ?? true,
    },
  };
}

const goodJson = JSON.stringify({
  observations: [
    {
      dimension: 'detail',
      claim: '用具体动作代替情绪形容词',
      evidence: [{ paragraphId: 'p1', quote: '把伞收起来，靠在门边' }],
      constraintInfluence: 'author_choice',
      limitations: ['仅一篇'],
    },
  ],
});

describe('分析结果验收：不通过就不能存成有效分析', () => {
  it('引用真实存在时通过，并记录统计与 usage', async () => {
    const { base } = await setup();
    const analysis = gateAnalysisOutput({ ...base, rawContent: goodJson });
    expect(analysis.status).toBe('ok');
    expect(analysis.observations).toHaveLength(1);
    expect(analysis.observations[0].evidence[0].quote).toBe('把伞收起来，靠在门边');
    expect(analysis.observations[0].evidence[0].sampleRevision).toBe(base.sampleRevision);
    expect(analysis.errorCode).toBeNull();
    expect(analysis.stats.sentences).toBeGreaterThan(0);
  });

  it('引用不是原文子串 → 整篇拒绝（不自动改写原文去迁就模型）', async () => {
    const { base } = await setup();
    const bad = JSON.stringify({
      observations: [
        {
          dimension: 'rhythm',
          claim: '短句',
          evidence: [{ paragraphId: 'p1', quote: '他把雨伞收好了' }], // 原文没有这句
        },
      ],
    });
    const analysis = gateAnalysisOutput({ ...base, rawContent: bad });
    expect(analysis.status).toBe('rejected');
    expect(analysis.errorCode).toBe('EVIDENCE_INVALID');
    expect(analysis.observations).toHaveLength(0);
    expect(analysis.rejectedObservations).toHaveLength(1);
  });

  it('空白/标点不同也算不通过，但给出疑似原因提示', async () => {
    const { base } = await setup();
    const bad = JSON.stringify({
      observations: [
        {
          dimension: 'detail',
          claim: '动作细节',
          evidence: [{ paragraphId: 'p1', quote: '把伞收起来， 靠在门边' }], // 多了一个空格
        },
      ],
    });
    const analysis = gateAnalysisOutput({ ...base, rawContent: bad });
    expect(analysis.status).toBe('rejected');
    expect(analysis.rejectedObservations[0].reason).toContain('不是段落 p1 的真实子串');
    expect(analysis.rejectedObservations[0].reason).toContain('空白');
  });

  it('不存在的段落 id 被拒绝', async () => {
    const { base } = await setup();
    const bad = JSON.stringify({
      observations: [
        { dimension: 'detail', claim: 'x', evidence: [{ paragraphId: 'p99', quote: '把伞收起来' }] },
      ],
    });
    const analysis = gateAnalysisOutput({ ...base, rawContent: bad });
    expect(analysis.status).toBe('rejected');
    expect(analysis.rejectedObservations[0].reason).toContain('p99');
  });

  it('无效 JSON 被拒绝', async () => {
    const { base } = await setup();
    const analysis = gateAnalysisOutput({ ...base, rawContent: '{这不是 JSON' });
    expect(analysis.status).toBe('rejected');
    expect(analysis.errorCode).toBe('INVALID_JSON');
    expect(analysis.observations).toEqual([]);
  });

  it('schema 不符被拒绝', async () => {
    const { base } = await setup();
    const analysis = gateAnalysisOutput({
      ...base,
      rawContent: JSON.stringify({ observations: [{ dimension: '不存在的维度', claim: 'x', evidence: [] }] }),
    });
    expect(analysis.status).toBe('rejected');
    expect(analysis.errorCode).toBe('SCHEMA_MISMATCH');
  });

  it('空正文被拒绝', async () => {
    const { base } = await setup();
    const analysis = gateAnalysisOutput({ ...base, rawContent: '   ' });
    expect(analysis.status).toBe('rejected');
    expect(analysis.errorCode).toBe('EMPTY_RESPONSE');
  });

  it('截断（finish_reason=length）被拒绝', async () => {
    const { base } = await setup();
    const analysis = gateAnalysisOutput({ ...base, rawContent: goodJson, finishReason: 'length' });
    expect(analysis.status).toBe('rejected');
    expect(analysis.errorCode).toBe('TRUNCATED');
  });

  it('部分观察引用坏掉时只丢坏的，整体标为 partial，坏证据绝不进入 observations', async () => {
    const { base } = await setup();
    const mixed = JSON.stringify({
      observations: [
        { dimension: 'detail', claim: '好的一条', evidence: [{ paragraphId: 'p1', quote: '把伞收起来' }] },
        { dimension: 'rhythm', claim: '坏的一条', evidence: [{ paragraphId: 'p2', quote: '这句原文里没有' }] },
      ],
    });
    const analysis = gateAnalysisOutput({ ...base, rawContent: mixed });
    expect(analysis.status).toBe('partial');
    expect(analysis.observations).toHaveLength(1);
    expect(analysis.observations[0].claim).toBe('好的一条');
    expect(analysis.rejectedObservations).toHaveLength(1);
    expect(JSON.stringify(analysis.observations)).not.toContain('这句原文里没有');
  });

  it('无题目样本（直接采样）：约束影响被强制记为 unknown，而不是作者习惯', async () => {
    const { base } = await setup({ constraintKnown: false });
    const json = JSON.stringify({
      observations: [
        {
          dimension: 'rhythm',
          claim: '作者偏爱短句',
          evidence: [{ paragraphId: 'p1', quote: '他把伞收起来' }],
          constraintInfluence: 'author_choice', // 模型硬说成作者选择
        },
      ],
    });
    const analysis = gateAnalysisOutput({ ...base, rawContent: json });
    expect(analysis.status).toBe('ok');
    expect(analysis.observations[0].constraintInfluence).toBe('unknown');
    expect(analysis.observations[0].limitations.join('')).toContain('题目约束未知');
  });

  it('上游失败时直接给出错误码，不产出观察', async () => {
    const { base } = await setup();
    const analysis = gateAnalysisOutput({
      ...base,
      rawContent: null,
      upstreamError: { code: 'UPSTREAM_TIMEOUT', message: '上游超时' },
    });
    expect(analysis.status).toBe('rejected');
    expect(analysis.errorCode).toBe('UPSTREAM_TIMEOUT');
    expect(analysis.observations).toEqual([]);
  });

  it('把实际调用次数（含重试）写进分析记录', async () => {
    const { base } = await setup();
    expect(gateAnalysisOutput({ ...base, rawContent: goodJson, attempts: 3 }).attempts).toBe(3);
    expect(gateAnalysisOutput({ ...base, rawContent: goodJson }).attempts).toBe(1);
  });
});

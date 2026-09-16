import { afterEach, describe, expect, it } from 'vitest';
import {
  beginTask,
  consumeExtraRetry,
  endTask,
  extraRetriesUsed,
  inflightCount,
  isTaskInflight,
  resetTaskControl,
} from '../src/server/jobs';
import { parseRetryAfterMs, sumUsage } from '../src/server/deepseek';
import { apiKeyConfigured, configMissingKeyMessage, mockEnabled, readEnv, statusLimits } from '../src/server/env';
import { MOCK_NOTICE, mockAnalyzeContent } from '../src/server/mock';
import { DISTILL_SYSTEM_PROMPT, buildAnalyzeMessages } from '../src/server/prompts';
import { computeTextStats } from '../src/shared/text';
import { gateAnalysisOutput } from '../src/shared/verify';
import { MAX_CHARS_PER_SAMPLE, MAX_EXTRA_RETRIES_PER_BATCH, MAX_SAMPLES_PER_BATCH } from '../src/shared/limits';
import { UNKNOWN_USAGE, type AnalyzeSampleRequest } from '../src/shared/schema';
import { makeSample } from './fixtures';

const ENV_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'ALLOW_MOCK_ANALYSIS', 'DEEPSEEK_BASE_URL', 'PORT'] as const;
const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetTaskControl();
});

describe('重复点击不重复发起（验收第 9 条）', () => {
  it('同一任务键在飞行中被挡住，结束后可再次发起', () => {
    resetTaskControl();
    const ticket = beginTask('run1:s1');
    expect(ticket).not.toBeNull();
    expect(beginTask('run1:s1')).toBeNull();
    expect(isTaskInflight('run1:s1')).toBe(true);
    expect(inflightCount()).toBe(1);
    endTask(ticket);
    expect(isTaskInflight('run1:s1')).toBe(false);
    expect(beginTask('run1:s1')).not.toBeNull();
  });

  it('不同样本可以并行登记，不会互相误伤', () => {
    resetTaskControl();
    expect(beginTask('run1:s1')).not.toBeNull();
    expect(beginTask('run1:s2')).not.toBeNull();
    expect(inflightCount()).toBe(2);
  });

  it('没拿到票（null）时结束不会误删别人的登记', () => {
    resetTaskControl();
    const ticket = beginTask('run1:s1');
    endTask(null);
    expect(isTaskInflight('run1:s1')).toBe(true);
    endTask(ticket);
  });
});

describe('重试有上限且按批次记账（验收第 9 条）', () => {
  it('一个批次最多只有固定次数的额外重试', () => {
    resetTaskControl();
    for (let i = 0; i < MAX_EXTRA_RETRIES_PER_BATCH; i += 1) {
      expect(consumeExtraRetry('runA')).toBe(true);
    }
    expect(consumeExtraRetry('runA')).toBe(false);
    expect(extraRetriesUsed('runA')).toBe(MAX_EXTRA_RETRIES_PER_BATCH);
  });

  it('额度按 runId 隔离，新批次重新计数', () => {
    resetTaskControl();
    for (let i = 0; i < MAX_EXTRA_RETRIES_PER_BATCH; i += 1) consumeExtraRetry('runA');
    expect(consumeExtraRetry('runA')).toBe(false);
    expect(consumeExtraRetry('runB')).toBe(true);
  });
});

describe('Retry-After 与 usage 记录', () => {
  it('支持秒数与 HTTP 日期两种写法', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('稍后再试')).toBeNull();
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms as number).toBeGreaterThan(3000);
    expect(ms as number).toBeLessThanOrEqual(6000);
  });

  it('没有 usage 时保持“未知”，不会伪装成 0', () => {
    expect(sumUsage(UNKNOWN_USAGE, UNKNOWN_USAGE)).toEqual(UNKNOWN_USAGE);
    expect(sumUsage(UNKNOWN_USAGE, { promptTokens: 7, completionTokens: null, totalTokens: null })).toEqual({
      promptTokens: 7,
      completionTokens: null,
      totalTokens: null,
    });
    expect(
      sumUsage(
        { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      ),
    ).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
  });
});

describe('配置与上游地址：不做通用转发，不泄漏密钥', () => {
  it('未配置 Key 时状态为 false，说明里只讲怎么配置', () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(apiKeyConfigured()).toBe(false);
    const msg = configMissingKeyMessage();
    expect(msg).toContain('DEEPSEEK_API_KEY');
    expect(msg).toMatch(/未配置/);
  });

  it('配置了 Key 也不会把密钥放进环境对象之外的地方', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-placeholder-not-real';
    const env = readEnv();
    expect(env.apiKeyConfigured).toBe(true);
    expect(env.apiKey).toBe('sk-test-placeholder-not-real');
    // status 响应里的字段只有布尔，没有密钥本体
    expect(Object.keys(statusLimits()).sort()).toEqual(
      ['maxCharsPerSample', 'maxExtraRetriesPerBatch', 'maxSamplesPerBatch', 'maxTotalCharsPerBatch', 'targetMaxChars', 'targetMinChars'].sort(),
    );
  });

  it('把上游改成别家地址会被忽略并给出警告（不是通用转发代理）', () => {
    process.env.DEEPSEEK_BASE_URL = 'https://evil.example.com/v1';
    const env = readEnv();
    expect(env.endpoint).toBe('https://api.deepseek.com/chat/completions');
    expect(env.warnings.join('')).toContain('通用转发代理');
    delete process.env.DEEPSEEK_BASE_URL;
  });

  it('Mock 默认关闭，只有显式开关才打开', () => {
    delete process.env.ALLOW_MOCK_ANALYSIS;
    expect(mockEnabled()).toBe(false);
    process.env.ALLOW_MOCK_ANALYSIS = '1';
    expect(mockEnabled()).toBe(true);
    process.env.ALLOW_MOCK_ANALYSIS = '0';
    expect(mockEnabled()).toBe(false);
  });

  it('口述的上限与 shared/limits.ts 完全一致', () => {
    const limits = statusLimits();
    expect(limits.maxCharsPerSample).toBe(MAX_CHARS_PER_SAMPLE);
    expect(limits.maxSamplesPerBatch).toBe(MAX_SAMPLES_PER_BATCH);
    expect(limits.maxExtraRetriesPerBatch).toBe(MAX_EXTRA_RETRIES_PER_BATCH);
  });
});

describe('Mock 也要过验收关卡', () => {
  const TEXT = '他把伞收起来，靠在门边。\n\n屋子里没有开灯，也没有人应声。';

  it('Mock 的引用取自真实段落，能通过校验，并带 Mock 标记', async () => {
    const sample = await makeSample({ id: 'sm', text: TEXT });
    const raw = mockAnalyzeContent({
      sampleId: sample.id,
      sampleRevision: sample.revision,
      paragraphs: sample.paragraphs,
      stats: computeTextStats(TEXT, sample.paragraphs),
      constraintKnown: true,
    });
    const analysis = gateAnalysisOutput({
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
      runId: 'run_mock',
      mock: true,
      elapsedMs: 1,
      constraintKnown: true,
      rawContent: raw,
    });
    expect(analysis.status).toBe('ok');
    expect(analysis.observations.length).toBeGreaterThan(0);
    expect(analysis.mock).toBe(true);
    expect(analysis.observations[0].limitations.join('')).toContain(MOCK_NOTICE);
    // Mock 不区分作者选择与题目强制
    expect(analysis.observations.every((o) => o.constraintInfluence === 'unknown')).toBe(true);
  });
});

describe('提示词确实写了任务书要求的约束', () => {
  const TEXT = '他把伞收起来，靠在门边。\n\n屋子里没有开灯，也没有人应声。';

  async function messages(constraintKnown: boolean) {
    const sample = await makeSample({ id: 'sp', text: TEXT });
    const req: AnalyzeSampleRequest = {
      runId: 'run_p',
      taskId: null,
      sampleId: sample.id,
      sampleRevision: sample.revision,
      contentHash: sample.contentHash,
      text: TEXT,
      sourceType: 'self_current',
      sceneTags: ['测试'],
      backgroundContext: null,
      taskConstraints: constraintKnown ? ['全用短句'] : [],
      taskConstraintsHash: null,
      constraintKnown,
    };
    return { sample, msgs: buildAnalyzeMessages(req, sample.paragraphs) };
  }

  it('系统提示覆盖：防注入、区分约束来源、逐字引用、不猜人格、要 JSON 示例、不给空泛赞美', async () => {
    const { msgs } = await messages(true);
    const system = msgs.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toMatch(/命令|指令/);
    expect(system).toMatch(/题目\/框架强制|题目强制/);
    expect(system).toMatch(/逐字/);
    expect(system).toMatch(/人格|经历|心理/);
    expect(system).toContain('"observations"'); // JSON 示例
    expect(system).toMatch(/赞美|等级|分数/);
    expect(system).toContain('paragraphId');
  });

  it('无题目样本时明确要求 constraintInfluence 必须填 unknown', async () => {
    const { msgs } = await messages(false);
    const system = msgs.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('unknown');
    expect(system).toMatch(/不得|不要|禁止/);
    const user = msgs.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('未知');
  });

  it('正文以明确的边界包起来，避免正文里的命令被当成指令', async () => {
    const { msgs } = await messages(true);
    const user = msgs.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('<<<样本正文开始>>>');
    expect(user).toContain('<<<样本正文结束>>>');
    expect(user).toContain('[p1]');
  });

  it('归纳提示词明确禁止把题目强制的要求归纳成作者习惯（验收第 4 条的提示词侧）', () => {
    expect(DISTILL_SYSTEM_PROMPT).toMatch(/不要把被题目\/框架强制的要求归纳成作者习惯/);
    expect(DISTILL_SYSTEM_PROMPT).toContain('scenario_specific');
    expect(DISTILL_SYSTEM_PROMPT).toMatch(/unknown 约束影响|被标为 unknown/);
  });
});

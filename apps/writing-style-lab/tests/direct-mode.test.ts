/**
 * 静态直连模式（BYOK）的测试。
 *
 * 重点不是"能不能发出请求"，而是：
 * 1. 请求发到哪里、带什么头与参数（只在浏览器直连 api.deepseek.com，不经任何中转）；
 * 2. **校验关卡一条都不能少** —— 假引用、截断要照样被拒；
 * 3. Key 不进错误信息、不进 localStorage 之类的持久存储；
 * 4. 重试额度与"401 不重试"与服务端一致。
 *
 * 全程用打桩 fetch，不发真实网络请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  directAnalyzeSample,
  directDistill,
  directRetriesUsed,
  resetDirectRetryLedger,
  directMockAnalyzeSample,
  directMockDistill,
  directMockTryout,
} from '../src/web/directClient';
import {
  DEFAULT_BASE_URL,
  DIRECT_ENDPOINT,
  SESSION_STORAGE_KEY,
  clearCredentials,
  getCredentials,
  isCustomEndpoint,
  isRememberedForThisTab,
  maskKey,
  normalizeBaseUrl,
  saveCredentials,
} from '../src/web/directCredentials';
import { ApiClientError } from '../src/web/clientError';
import { computeTextStats } from '../src/shared/text';
import type { AnalyzeSampleRequest, SampleAnalysis } from '../src/shared/schema';
import { makeSample } from './fixtures';

const TEXT = '他把伞收起来，靠在门边。\n\n屋子里没有开灯，也没有人应声。';
const KEY = 'sk-test-direct-key-1234';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function chatEnvelope(content: string, finishReason = 'stop', usage: Record<string, number> | null = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }): Response {
  return jsonResponse({
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage,
  });
}

async function analyzeRequest(): Promise<{ request: AnalyzeSampleRequest; sample: Awaited<ReturnType<typeof makeSample>> }> {
  const sample = await makeSample({ id: 'sd', text: TEXT });
  return {
    sample,
    request: {
      runId: 'run_direct',
      taskId: null,
      sampleId: sample.id,
      sampleRevision: sample.revision,
      contentHash: sample.contentHash,
      text: TEXT,
      sourceType: 'self_current',
      sceneTags: ['测试'],
      backgroundContext: null,
      taskConstraints: [],
      taskConstraintsHash: null,
      constraintKnown: true,
    },
  };
}

beforeEach(() => {
  resetDirectRetryLedger();
  clearCredentials();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCredentials();
  resetDirectRetryLedger();
});

describe('凭据保管：只进内存，永不进持久存储', () => {
  it('没有凭据时直接说清楚，不发出任何请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(analyzeRequest().then(({ request }) => directAnalyzeSample(request))).rejects.toMatchObject({
      errorCode: 'NO_CREDENTIALS',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('保存与清除只动内存（Node 环境没有 sessionStorage 时也不能报错）', () => {
    expect(getCredentials()).toBeNull();
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: true });
    expect(getCredentials()?.apiKey).toBe(KEY);
    expect(getCredentials()?.model).toBe('deepseek-flash');
    clearCredentials();
    expect(getCredentials()).toBeNull();
  });

  it('界面只回显末 4 位，拿不到完整 Key', () => {
    expect(maskKey(KEY)).toBe('****1234');
    expect(maskKey('abc')).toBe('****');
  });

  it('localStorage 全程不被写入（Key 不进长期存储）', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: true });
    expect(store.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('勾选记住时也只写 sessionStorage，且键名固定、可被清除', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: true });
    expect(store.has(SESSION_STORAGE_KEY)).toBe(true);
    expect(isRememberedForThisTab()).toBe(true);
    clearCredentials();
    expect(store.has(SESSION_STORAGE_KEY)).toBe(false);
    vi.unstubAllGlobals();
  });
  it('端点可配置：换成别的 OpenAI 兼容地址后就发到那里（仍然只接受 https）', async () => {
    saveCredentials({
      apiKey: KEY,
      model: 'some-model',
      baseUrl: 'https://my-endpoint.example.com/v1/',
      rememberForThisTab: false,
    });
    const fetchMock = vi.fn().mockResolvedValue(chatEnvelope(JSON.stringify({ observations: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { request } = await analyzeRequest();
    await directAnalyzeSample(request);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // 结尾斜杠被去掉，自动拼上 /chat/completions，不会出现双斜杠
    expect(url).toBe('https://my-endpoint.example.com/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('some-model');
  });

  it('明文 http 端点不被接受（会把 Key 暴露在链路上）', () => {
    expect(normalizeBaseUrl('http://insecure.example.com')).toBeNull();
    expect(normalizeBaseUrl('not-a-url')).toBeNull();
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', baseUrl: 'http://insecure.example.com', rememberForThisTab: false });
    // 非法端点回落到默认，不会把 Key 发到明文地址
    expect(getCredentials()?.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('能识别"用了自定义端点"以便界面给出警告', () => {
    expect(isCustomEndpoint(DEFAULT_BASE_URL)).toBe(false);
    expect(isCustomEndpoint('https://api.deepseek.com')).toBe(false);
    expect(isCustomEndpoint('https://other.example.com')).toBe(true);
  });
});

describe('直连调用：端点、请求头与参数与服务端一致', () => {
  it('只发往 api.deepseek.com，带 Bearer 头、JSON 模式与关闭思考', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    const fetchMock = vi.fn().mockResolvedValue(
      chatEnvelope(
        JSON.stringify({
          observations: [
            {
              dimension: 'detail',
              claim: '用动作代替情绪词。程序统计显示平均句长 6.8 字',
              evidence: [{ paragraphId: 'p1', quote: '他把伞收起来，靠在门边' }],
              constraintInfluence: 'author_choice',
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { request } = await analyzeRequest();
    const res = await directAnalyzeSample(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DIRECT_ENDPOINT);
    expect(url.startsWith('https://api.deepseek.com/')).toBe(true);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-flash');
    expect(body.stream).toBe(false);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(4096);
    expect(init.credentials).toBe('omit');

    expect(res.ok).toBe(true);
    expect(res.analysis.status).toBe('ok');
    expect(res.analysis.mock).toBe(false);
    expect(res.analysis.attempts).toBe(1);
    expect(res.analysis.usage.totalTokens).toBe(33);
    expect(res.analysis.stylometry?.sentenceMeanChars).toBeGreaterThan(0);
  });

  it('提示词里带上了程序统计，模型被要求引用数字', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    const fetchMock = vi.fn().mockResolvedValue(chatEnvelope(JSON.stringify({ observations: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { request } = await analyzeRequest();
    await directAnalyzeSample(request);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      messages: { role: string; content: string }[];
    };
    const all = body.messages.map((m) => m.content).join('\n');
    expect(all).toContain('程序统计');
    expect(all).toContain('句长');
    expect(all).toContain('<<<样本正文开始>>>');
  });
});

describe('直连模式不绕过校验关卡', () => {
  it('假引用照样被拒（不会因为"没有服务端"就放行）', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chatEnvelope(
          JSON.stringify({
            observations: [
              { dimension: 'rhythm', claim: '短句多', evidence: [{ paragraphId: 'p1', quote: '原文里根本没有这句话' }] },
            ],
          }),
        ),
      ),
    );
    const { request } = await analyzeRequest();
    const res = await directAnalyzeSample(request);
    expect(res.analysis.status).toBe('rejected');
    expect(res.analysis.errorCode).toBe('EVIDENCE_INVALID');
    expect(res.analysis.observations).toHaveLength(0);
  });

  it('截断被拒', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatEnvelope('{"observations":[]}', 'length')));
    const { request } = await analyzeRequest();
    const res = await directAnalyzeSample(request);
    expect(res.analysis.status).toBe('rejected');
    expect(res.analysis.errorCode).toBe('TRUNCATED');
  });

  it('无效 JSON 被拒', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatEnvelope('这不是 JSON')));
    const { request } = await analyzeRequest();
    const res = await directAnalyzeSample(request);
    expect(res.analysis.errorCode).toBe('INVALID_JSON');
  });

  it('归纳的引用必须命中已校验的证据，否则拒绝该候选', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    const sample = await makeSample({ id: 's1', text: TEXT });
    const stats = computeTextStats(TEXT, sample.paragraphs);
    const analysis: SampleAnalysis = {
      id: 'an1',
      sampleId: 's1',
      sampleRevision: 1,
      contentHash: sample.contentHash,
      taskConstraintsHash: null,
      model: 'deepseek-flash',
      promptVersion: 'wsl-p1',
      temperature: 0.2,
      maxTokens: 4096,
      stats,
      observations: [
        {
          id: 'o1',
          dimension: 'detail',
          claim: '用动作代替情绪词',
          scope: 'sample_only',
          evidence: [{ sampleId: 's1', sampleRevision: 1, paragraphId: 'p1', quote: '他把伞收起来' }],
          constraintInfluence: 'author_choice',
          limitations: [],
        },
      ],
      rejectedObservations: [],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      status: 'ok',
      errorCode: null,
      errorMessage: null,
      elapsedMs: 10,
      mock: false,
      runId: 'run_direct',
      createdAt: new Date().toISOString(),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chatEnvelope(
          JSON.stringify({
            candidates: [
              {
                statement: '用动作代替情绪词',
                scope: 'general',
                origin: 'observed',
                // 这一条引用不在任何已校验分析里 → 必须被拒
                evidence: [{ sampleId: 's1', paragraphId: 'p2', quote: '屋子里没有开灯' }],
              },
            ],
          }),
        ),
      ),
    );

    const res = await directDistill({
      runId: 'run_direct',
      samples: [
        {
          sampleId: 's1',
          revision: 1,
          contentHash: sample.contentHash,
          entryMode: 'task',
          originDocumentId: null,
          sourceType: 'self_current',
          sceneTags: ['测试'],
          chars: stats.chars,
          authorNote: null,
          backgroundContext: null,
          textSample: TEXT.slice(0, 200),
          taskConstraints: [],
          constraintKnown: true,
          holdout: false,
          partial: false,
          analysis,
        },
      ],
      preferences: [],
      previousRules: [],
    });
    expect(res.candidates).toHaveLength(0);
    expect(res.rejectedCandidates[0].reason).toContain('不在已通过校验的分析中');
  });
});

describe('失败处理与服务端同一套策略', () => {
  it('401 不重试，且错误信息里不含 Key', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Authentication Fails' } }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { request } = await analyzeRequest();
    const res = await directAnalyzeSample(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.analysis.status).toBe('rejected');
    expect(res.analysis.errorCode).toBe('UPSTREAM_AUTH');
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(res.analysis.errorMessage ?? '').not.toContain(KEY);
  });

  it('429 按额度重试，用尽后报额度不足（额度按轮次隔离）', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'rate limited' } }, { status: 429, headers: { 'retry-after': '0' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { request } = await analyzeRequest();
    const res = await directAnalyzeSample(request);
    // 1 次首发 + 2 次额外重试（上限）
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(directRetriesUsed('run_direct')).toBe(2);
    expect(res.analysis.errorCode).toBe('QUOTA_EXCEEDED');
    expect(res.analysis.attempts).toBe(3);
  }, 20000);

  it('上游返回空正文时不报网络错，而是交验收关卡判为 EMPTY_RESPONSE', async () => {
    saveCredentials({ apiKey: KEY, model: 'deepseek-flash', rememberForThisTab: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatEnvelope('')));
    const { request } = await analyzeRequest();
    const res = await directAnalyzeSample(request);
    expect(res.analysis.status).toBe('rejected');
    expect(res.analysis.errorCode).toBe('EMPTY_RESPONSE');
  });

  it('没有凭据时抛的是可识别错误，界面能给出"去填 Key"的指引', async () => {
    const err = await directDistill({ runId: 'r', samples: [], preferences: [], previousRules: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).errorCode).toBe('NO_CREDENTIALS');
  });
});

describe('试玩模式：没有 Key 也能跑完整流程，且一个请求都不发', () => {
  it('分析：不联网、带 mock 标记、引用仍然是正文里的真子串', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { request } = await analyzeRequest();
    const res = await directMockAnalyzeSample(request);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.analysis.mock).toBe(true);
    expect(res.analysis.model).toContain('mock');
    expect(res.analysis.status).toBe('ok');
    expect(res.analysis.observations.length).toBeGreaterThan(0);
    expect(res.analysis.attempts).toBe(0);
    for (const obs of res.analysis.observations) {
      for (const ev of obs.evidence) {
        expect(ev.quote.length).toBeGreaterThan(0);
        expect(TEXT.includes(ev.quote)).toBe(true);
      }
    }
    expect(res.analysis.observations[0].limitations.join('')).toContain('Mock');
  });

  it('归纳：由试玩分析产出候选规则，并带上 Mock 局限', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { request, sample } = await analyzeRequest();
    const analyzed = await directMockAnalyzeSample(request);
    const res = await directMockDistill({
      runId: 'run_mock_distill',
      samples: [
        {
          sampleId: sample.id,
          revision: 1,
          contentHash: sample.contentHash,
          entryMode: 'task',
          originDocumentId: null,
          sourceType: 'self_current',
          sceneTags: ['测试'],
          chars: analyzed.analysis.stats.chars,
          authorNote: null,
          backgroundContext: null,
          textSample: TEXT,
          taskConstraints: [],
          constraintKnown: true,
          holdout: false,
          partial: false,
          analysis: analyzed.analysis,
        },
      ],
      preferences: [],
      previousRules: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.mock).toBe(true);
    expect(res.model).toContain('mock');
    if (res.candidates.length > 0) {
      expect(res.candidates[0].limitations.join('')).toContain('Mock');
    }
  });

  it('试写：两版都是本地占位文本，字数落在题目要求区间', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await directMockTryout({
      runId: 'run_mock_tryout',
      prompt: '写一段雨天等车的话',
      skillMarkdown: null,
      targetMinChars: 300,
      targetMaxChars: 500,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.mock).toBe(true);
    expect(res.base.chars).toBeGreaterThanOrEqual(300);
    expect(res.base.chars).toBeLessThanOrEqual(500);
    expect(res.withSkill.chars).toBeGreaterThanOrEqual(300);
    expect(res.base.text).not.toBe(res.withSkill.text);
  });
});

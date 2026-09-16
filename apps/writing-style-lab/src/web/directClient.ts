/**
 * 浏览器直连 DeepSeek（BYOK：访客自带 Key）。
 *
 * 用在只有静态托管的场景（GitHub Pages）。它与服务端**走同一套提示词与同一套校验关卡**：
 * - 提示词来自 src/server/prompts.ts（纯函数，只依赖 shared）
 * - 单篇结果一律过 shared/verify.ts 的 gateAnalysisOutput（假引用/截断/无效 JSON/schema 不符全部拒绝）
 * - 归纳一律过 shared/rules.ts 的 buildCandidates（引用必须命中已校验证据、通用规则降级、去伪重复）
 * - 长度上限沿用 shared/limits.ts，前后端同一套数字
 *
 * 因此「静态版」不是简化版：它只是把服务端那几百行编排搬到了浏览器里，校验一条都没少。
 * 差别只有两个：Key 由访客自己提供（只发给 api.deepseek.com），以及没有服务端日志。
 */
import { buildAnalyzeMessages, buildDistillMessages, buildTryoutMessages } from '../server/prompts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_CHARS_PER_SAMPLE,
  MAX_EXTRA_RETRIES_PER_BATCH,
  MAX_SAMPLES_PER_BATCH,
  MAX_TOTAL_CHARS_PER_BATCH,
  PROMPT_VERSION,
  REQUEST_TIMEOUT_MS,
} from '../shared/limits';
import { buildCandidates, type DistillContextSample } from '../shared/rules';
import {
  DistillOutputSchema,
  UNKNOWN_USAGE,
  type AnalyzeSampleRequest,
  type AnalyzeSampleResponse,
  type DistillRequest,
  type DistillResponse,
  type ErrorCode,
  type TryoutRequest,
  type TryoutResponse,
  type Usage,
} from '../shared/schema';
import { checkLengthLimits, computeTextStats, countChars, splitParagraphs } from '../shared/text';
import { sumUsage } from '../shared/usage';
import { gateAnalysisOutput } from '../shared/verify';
import { ApiClientError } from './clientError';
import { chatCompletionsUrl, getCredentials, type DirectCredentials } from './directCredentials';
import { DIRECT_MODEL_DEFAULT } from './directCredentials';

/** 与服务端一致：分析/归纳用 0.2 / 4096；试写用 1.0 / 2048（两版必须同参数）。 */
export const DIRECT_TRYOUT_TEMPERATURE = 1.0;
export const DIRECT_TRYOUT_MAX_TOKENS = 2048;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/* ------------------------------------------------------------ 重试账本（按轮次） */

const retryLedger = new Map<string, number>();

/** 仅供测试与「重新开始」使用。 */
export function resetDirectRetryLedger(): void {
  retryLedger.clear();
}

export function directRetriesUsed(runId: string): number {
  return retryLedger.get(runId) ?? 0;
}

function consumeRetry(runId: string): boolean {
  const used = retryLedger.get(runId) ?? 0;
  if (used >= MAX_EXTRA_RETRIES_PER_BATCH) return false;
  retryLedger.set(runId, used + 1);
  return true;
}

/* ---------------------------------------------------------------- 单次调用 */

interface CallInput {
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  jsonMode: boolean;
  disableThinking: boolean;
  runId: string;
}

type CallOutcome =
  | { ok: true; content: string; finishReason: string | null; usage: Usage; attempts: number; elapsedMs: number }
  | { ok: false; errorCode: ErrorCode; message: string; retryable: boolean; attempts: number; elapsedMs: number };

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function classify(status: number): { errorCode: ErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { errorCode: 'UPSTREAM_AUTH', retryable: false };
  if (status === 429) return { errorCode: 'UPSTREAM_ERROR', retryable: true };
  if (status >= 500) return { errorCode: 'UPSTREAM_ERROR', retryable: true };
  return { errorCode: 'UPSTREAM_ERROR', retryable: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOnce(credentials: DirectCredentials, input: CallInput): Promise<CallOutcome> {
  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    model: credentials.model || DIRECT_MODEL_DEFAULT,
    messages: input.messages,
    stream: false,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
  };
  if (input.jsonMode) body.response_format = { type: 'json_object' };
  if (input.disableThinking) body.thinking = { type: 'disabled' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // 端点可配置：默认 DeepSeek 官方；作者也可以填任何 OpenAI 兼容的 https 端点。
  const endpoint = chatCompletionsUrl(credentials.baseUrl);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify(body),
      credentials: 'omit',
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      const { errorCode, retryable } = classify(res.status);
      let detail = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        /* 上游没给 JSON，就用状态码说明 */
      }
      return {
        ok: false,
        errorCode,
        message: `${new URL(endpoint).host} 返回 ${res.status}：${detail}`,
        retryable,
        attempts: 1,
        elapsedMs: Date.now() - startedAt,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        errorCode: 'UPSTREAM_ERROR',
        message: 'DeepSeek 返回的不是合法 JSON',
        retryable: true,
        attempts: 1,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const parsed = payload as {
      choices?: { finish_reason?: string | null; message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = parsed.choices?.[0];
    const usageRaw = parsed.usage;
    const usage: Usage = usageRaw
      ? {
          promptTokens: typeof usageRaw.prompt_tokens === 'number' ? usageRaw.prompt_tokens : null,
          completionTokens: typeof usageRaw.completion_tokens === 'number' ? usageRaw.completion_tokens : null,
          totalTokens: typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : null,
        }
      : UNKNOWN_USAGE;
    if (!usageRaw) {
      return {
        ok: true,
        content: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? null,
        usage: UNKNOWN_USAGE,
        attempts: 1,
        elapsedMs: Date.now() - startedAt,
      };
    }
    return {
      ok: true,
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      usage,
      attempts: 1,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      errorCode: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      message: aborted
        ? `请求超过 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒未返回，已中断`
        : `连不上 ${(() => {
            try {
              return new URL(endpoint).host;
            } catch {
              return '上游端点';
            }
          })()}：${err instanceof Error ? err.message : '未知错误'}`,
      retryable: true,
      attempts: 1,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 带超时、退避与按轮次重试额度的调用（与服务端同一套策略）。 */
async function callDirect(credentials: DirectCredentials, input: CallInput): Promise<CallOutcome> {
  let attempts = 0;
  let elapsed = 0;
  for (;;) {
    const outcome = await callOnce(credentials, input);
    attempts += 1;
    elapsed += outcome.elapsedMs;
    if (outcome.ok) return { ...outcome, attempts, elapsedMs: elapsed };

    const canRetry = outcome.retryable && consumeRetry(input.runId);
    if (!canRetry) {
      return {
        ...outcome,
        attempts,
        elapsedMs: elapsed,
        message: outcome.retryable
          ? `${outcome.message}（本轮的额外重试额度已用尽，上限 ${MAX_EXTRA_RETRIES_PER_BATCH} 次）`
          : outcome.message,
        errorCode: outcome.retryable && !canRetry ? 'QUOTA_EXCEEDED' : outcome.errorCode,
        retryable: false,
      };
    }
    await sleep(800 * attempts);
  }
}

function requireCredentials(): DirectCredentials {
  const credentials = getCredentials();
  if (!credentials) {
    throw new ApiClientError(
      'NO_CREDENTIALS',
      '这个页面没有服务端，需要你自己的 DeepSeek API Key 才能分析。请在页面顶部填写（Key 只存在你的浏览器里，只发给 api.deepseek.com）。',
      { path: 'direct' },
    );
  }
  return credentials;
}

function assertLimits(samples: { chars: number }[]): void {
  const violations = checkLengthLimits(samples, {
    maxCharsPerSample: MAX_CHARS_PER_SAMPLE,
    maxSamplesPerBatch: MAX_SAMPLES_PER_BATCH,
    maxTotalCharsPerBatch: MAX_TOTAL_CHARS_PER_BATCH,
  });
  if (violations.length > 0) {
    throw new ApiClientError('LENGTH_LIMIT', violations.map((v) => v.message).join('；'), { path: 'direct' });
  }
}

/* ------------------------------------------------------------ 三个业务入口 */

export async function directAnalyzeSample(request: AnalyzeSampleRequest): Promise<AnalyzeSampleResponse> {
  const credentials = requireCredentials();
  const paragraphs = splitParagraphs(request.text);
  const stats = computeTextStats(request.text, paragraphs);
  assertLimits([{ chars: countChars(request.text) }]);

  const call = await callDirect(credentials, {
    messages: buildAnalyzeMessages(request, paragraphs),
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    jsonMode: true,
    disableThinking: true,
    runId: request.runId,
  });

  const analysis = gateAnalysisOutput({
    sampleId: request.sampleId,
    sampleRevision: request.sampleRevision,
    contentHash: request.contentHash,
    taskConstraintsHash: request.taskConstraintsHash,
    paragraphs,
    stats,
    text: request.text,
    model: credentials.model || DIRECT_MODEL_DEFAULT,
    promptVersion: PROMPT_VERSION,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    runId: request.runId,
    mock: false,
    elapsedMs: call.elapsedMs,
    usage: call.ok ? call.usage : UNKNOWN_USAGE,
    attempts: call.attempts,
    finishReason: call.ok ? call.finishReason : null,
    rawContent: call.ok ? call.content : null,
    upstreamError: call.ok ? null : { code: call.errorCode, message: call.message },
    constraintKnown: request.constraintKnown,
  });

  return { ok: true, analysis };
}

export async function directDistill(request: DistillRequest): Promise<DistillResponse> {
  const credentials = requireCredentials();
  assertLimits(request.samples.map((s) => ({ chars: Math.max(s.chars, s.analysis.stats.chars) })));

  const call = await callDirect(credentials, {
    messages: buildDistillMessages(request),
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    jsonMode: true,
    disableThinking: true,
    runId: request.runId,
  });
  if (!call.ok) {
    throw new ApiClientError(call.errorCode, call.message, { path: 'direct', retryable: call.retryable });
  }
  if (call.finishReason === 'length') {
    throw new ApiClientError('TRUNCATED', '模型输出被截断（finish_reason=length），归纳结果不可用：请减少样本数或缩短备注后重试。', {
      path: 'direct',
    });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(call.content);
  } catch (err) {
    throw new ApiClientError('INVALID_JSON', `模型返回不是合法 JSON：${(err as Error).message}`, { path: 'direct' });
  }
  const schema = DistillOutputSchema.safeParse(parsedJson);
  if (!schema.success) {
    throw new ApiClientError(
      'SCHEMA_MISMATCH',
      `模型返回不符合本项目 schema：${schema.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`,
      { path: 'direct' },
    );
  }

  const contextSamples: DistillContextSample[] = request.samples.map((sample) => ({
    sampleId: sample.sampleId,
    revision: sample.revision,
    contentHash: sample.contentHash,
    sourceDocumentId: sample.originDocumentId,
    sceneTags: sample.sceneTags,
    constraintKnown: sample.constraintKnown,
    taskConstraints: sample.taskConstraints,
    backgroundContext: sample.backgroundContext,
    textSample: sample.textSample ?? null,
    holdout: sample.holdout,
    useForAnalysis: true,
    sourceType: sample.sourceType,
    analysis: sample.analysis,
  }));

  const built = buildCandidates({
    rawRules: schema.data.candidates,
    samples: contextSamples,
    previousRules: request.previousRules,
  });

  return {
    ok: true,
    candidates: built.candidates,
    rejectedCandidates: built.rejected,
    usage: call.usage,
    model: credentials.model || DIRECT_MODEL_DEFAULT,
    promptVersion: PROMPT_VERSION,
    mock: false,
    elapsedMs: call.elapsedMs,
  };
}

export async function directTryout(request: TryoutRequest): Promise<TryoutResponse> {
  const credentials = requireCredentials();
  const { base, withSkill } = buildTryoutMessages({
    prompt: request.prompt,
    skillMarkdown: request.skillMarkdown,
    targetMinChars: request.targetMinChars,
    targetMaxChars: request.targetMaxChars,
  });

  const shared = {
    temperature: DIRECT_TRYOUT_TEMPERATURE,
    maxTokens: DIRECT_TRYOUT_MAX_TOKENS,
    jsonMode: false,
    disableThinking: false,
    runId: `${request.runId}:tryout`,
  } as const;

  // 顺序执行：同一模型、同一题目、相同参数，两版只差 system 提示。
  const baseCall = await callDirect(credentials, { ...shared, messages: base });
  if (!baseCall.ok) {
    throw new ApiClientError(baseCall.errorCode, baseCall.message, { path: 'direct', retryable: baseCall.retryable });
  }
  const skillCall = await callDirect(credentials, { ...shared, messages: withSkill });
  if (!skillCall.ok) {
    throw new ApiClientError(skillCall.errorCode, skillCall.message, { path: 'direct', retryable: skillCall.retryable });
  }

  return {
    ok: true,
    base: {
      text: baseCall.content,
      chars: countChars(baseCall.content),
      usage: baseCall.usage,
      finishReason: baseCall.finishReason,
    },
    withSkill: {
      text: skillCall.content,
      chars: countChars(skillCall.content),
      usage: skillCall.usage,
      finishReason: skillCall.finishReason,
    },
    model: credentials.model || DIRECT_MODEL_DEFAULT,
    params: { temperature: DIRECT_TRYOUT_TEMPERATURE, maxTokens: DIRECT_TRYOUT_MAX_TOKENS },
    elapsedMs: baseCall.elapsedMs + skillCall.elapsedMs,
    mock: false,
    usage: sumUsage(baseCall.usage, skillCall.usage),
  };
}

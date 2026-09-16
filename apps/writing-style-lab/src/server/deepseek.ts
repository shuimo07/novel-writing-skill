/**
 * DeepSeek 上游调用。
 *
 * 规范（与《文风采样器开发提示词》一致，不要在这里“顺手扩展”）：
 * - 端点固定为 https://api.deepseek.com/chat/completions，**不接受任何来自请求的目标地址**，
 *   不允许被改成通用转发代理；baseUrl 只允许用 DEEPSEEK_BASE_URL 覆盖且必须是 api.deepseek.com（见 env.ts）。
 * - 头固定：Authorization: Bearer ${DEEPSEEK_API_KEY}、Content-Type: application/json。
 * - 分析/归纳：stream:false、thinking disabled、response_format=json_object、max_tokens=4096、temperature=0.2
 *   （分别可用 DEEPSEEK_MAX_TOKENS / DEEPSEEK_TEMPERATURE 覆盖，并会写进响应里的 analysis.temperature/maxTokens）。
 * - 试写：**不带** response_format（要自由文本），max_tokens=2048、temperature 默认 1.0。
 * - 必须检查：HTTP 状态码、finish_reason（length 视为截断）、空正文、JSON 合法性；
 *   这些判定不在这里做结论 —— 分析交给 shared/verify.ts 的 gateAnalysisOutput，归纳/试写由路由显式报错。
 *   本模块只负责把「上游发生了什么」如实带回去，不改写、不修补模型输出。
 * - 超时：AbortController + REQUEST_TIMEOUT_MS。
 * - 重试：只对 429 / 5xx / 网络错误 / 超时重试，尊重 Retry-After；401/403/400 等配置或请求错误不重试。
 *   额外重试按 runId 记账，上限 MAX_EXTRA_RETRIES_PER_BATCH，超出返回 QUOTA_EXCEEDED，
 *   绝不循环重试直到“碰巧成功”。
 */
import { z } from 'zod';
import { MAX_EXTRA_RETRIES_PER_BATCH, REQUEST_TIMEOUT_MS } from '../shared/limits';
import { UNKNOWN_USAGE, type ErrorCode, type Usage } from '../shared/schema';
import {
  RETRY_AFTER_MAX_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  logMeta,
  readEnv,
  type ServerEnv,
} from './env';
import { consumeExtraRetry, extraRetriesUsed } from './jobs';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallParams {
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** true = response_format: { type: 'json_object' } + 关闭思考；试写必须为 false。 */
  jsonMode: boolean;
  /** 关闭思考模式（分析/归纳为 true）。 */
  disableThinking: boolean;
  /** 批次 id：额外重试额度按它计数。 */
  runId: string;
  purpose: 'analyze' | 'distill' | 'tryout';
}

export interface CallSuccess {
  ok: true;
  /** 模型输出正文（可能是空串，空正文的判定由调用方/gate 负责）。 */
  content: string;
  finishReason: string | null;
  usage: Usage;
  model: string;
  /** 上游请求次数（含重试）。 */
  attempts: number;
  /** 用掉的额外重试次数。 */
  extraRetries: number;
  elapsedMs: number;
}

export interface CallFailure {
  ok: false;
  errorCode: ErrorCode;
  message: string;
  retryable: boolean;
  /** 上游 HTTP 状态码；网络错误/超时/本地拦截为 null。 */
  httpStatus: number | null;
  attempts: number;
  extraRetries: number;
  elapsedMs: number;
  usage: Usage;
}

export type CallResult = CallSuccess | CallFailure;

/** 上游返回信封（OpenAI 兼容）；只声明我们要用到的字段，容错用 nullish。 */
const UpstreamResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish() }).nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
    })
    .nullish(),
});

function toTokenCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** 缺字段就是未知：界面显示“未知”，绝不猜一个数字填上。 */
function toUsage(raw: z.infer<typeof UpstreamResponseSchema>['usage']): Usage {
  if (!raw) return UNKNOWN_USAGE;
  const promptTokens = toTokenCount(raw.prompt_tokens);
  const completionTokens = toTokenCount(raw.completion_tokens);
  const totalTokens = toTokenCount(raw.total_tokens);
  if (promptTokens === null && completionTokens === null && totalTokens === null) return UNKNOWN_USAGE;
  return { promptTokens, completionTokens, totalTokens };
}

/** 合并两次调用的 usage（试写 A/B 各一次）；两边都未知时保持未知。 */
export function sumUsage(a: Usage, b: Usage): Usage {
  const add = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    promptTokens: add(a.promptTokens, b.promptTokens),
    completionTokens: add(a.completionTokens, b.completionTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
  };
}

function delay(ms: number): Promise<void> {
  // 刻意不 unref：退避等待必须真的等完，否则「进程没有其它句柄时」会在重试前退出。
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function backoffMs(extraRetryIndex: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, extraRetryIndex);
  return Math.min(RETRY_MAX_DELAY_MS, base);
}

/** 尊重 Retry-After：支持秒数与 HTTP 日期两种写法。 */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

interface AttemptResult {
  ok: boolean;
  content?: string;
  finishReason?: string | null;
  usage?: Usage;
  errorCode?: ErrorCode;
  message?: string;
  retryable?: boolean;
  httpStatus?: number | null;
  retryAfterMs?: number | null;
}

function httpHint(status: number): string {
  if (status === 401 || status === 403) return '请检查 DEEPSEEK_API_KEY 是否正确、是否有额度权限。';
  if (status === 400 || status === 422) return '上游认为请求本身不合法，请检查输入长度与参数。';
  if (status === 429) return '上游限流，将按 Retry-After 退避后重试。';
  if (status >= 500) return '上游服务端错误，稍后可重试。';
  return '请稍后重试。';
}

/** 单次请求（不含重试）。 */
async function requestOnce(env: ServerEnv, params: CallParams): Promise<AttemptResult> {
  if (!env.apiKey) {
    // 路由层已经拦过一次；这里是纵深防御，绝不伪造结果。
    return {
      ok: false,
      errorCode: 'CONFIG_MISSING_KEY',
      message: '未配置 DEEPSEEK_API_KEY，无法调用上游。',
      retryable: false,
      httpStatus: null,
    };
  }

  const body: Record<string, unknown> = {
    model: env.model,
    messages: params.messages,
    stream: false,
    max_tokens: params.maxTokens,
    temperature: params.temperature,
  };
  if (params.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  if (params.disableThinking) {
    body.thinking = { type: 'disabled' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(env.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const status = res.status;
      const retryable = status === 429 || status >= 500;
      const isAuth = status === 401 || status === 403;
      return {
        ok: false,
        errorCode: isAuth ? 'UPSTREAM_AUTH' : 'UPSTREAM_ERROR',
        // 只描述状态与处置建议：不回显上游正文，也不回显请求内容。
        message: `上游返回 HTTP ${status}${isAuth ? '（鉴权失败）' : ''}：${httpHint(status)}`,
        retryable,
        httpStatus: status,
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
      };
    }

    const text = await res.text();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return {
        ok: false,
        errorCode: 'UPSTREAM_ERROR',
        message: '上游返回的响应不是合法 JSON（协议层错误，非模型输出问题）。',
        retryable: true,
        httpStatus: res.status,
      };
    }
    const parsed = UpstreamResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: 'UPSTREAM_ERROR',
        message: '上游响应结构不符合预期（缺少 choices/message）。',
        retryable: true,
        httpStatus: res.status,
      };
    }
    const choice = parsed.data.choices[0];
    return {
      ok: true,
      // 空正文不在这里下结论：分析交给 gateAnalysisOutput，归纳/试写由路由显式报错。
      content: choice.message?.content ?? '',
      finishReason: choice.finish_reason ?? null,
      usage: toUsage(parsed.data.usage),
    };
  } catch (err) {
    const error = err as { name?: string; message?: string };
    if (error?.name === 'AbortError') {
      return {
        ok: false,
        errorCode: 'UPSTREAM_TIMEOUT',
        message: `上游请求超过 ${REQUEST_TIMEOUT_MS} 毫秒未返回，已中止。`,
        retryable: true,
        httpStatus: null,
      };
    }
    return {
      ok: false,
      errorCode: 'UPSTREAM_ERROR',
      message: '无法连接上游（网络错误）。',
      retryable: true,
      httpStatus: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function failure(
  base: { errorCode: ErrorCode; message: string; retryable: boolean; httpStatus: number | null; usage: Usage },
  extra: { attempts: number; extraRetries: number; elapsedMs: number },
): CallFailure {
  return {
    ok: false,
    errorCode: base.errorCode,
    message: base.message,
    retryable: base.retryable,
    httpStatus: base.httpStatus,
    usage: base.usage,
    ...extra,
  };
}

/**
 * 带重试与超时的上游调用。
 * 失败一律返回 CallFailure（不抛异常），让路由层决定映射成哪个 HTTP 状态与错误码。
 */
export async function callDeepSeek(params: CallParams, env: ServerEnv = readEnv()): Promise<CallResult> {
  const startedAt = Date.now();
  let attempts = 0;
  let extraRetries = 0;

  for (;;) {
    const result = await requestOnce(env, params);
    attempts += 1;
    if (result.ok) {
      return {
        ok: true,
        content: result.content ?? '',
        finishReason: result.finishReason ?? null,
        usage: result.usage ?? UNKNOWN_USAGE,
        model: env.model,
        attempts,
        extraRetries,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const base = {
      errorCode: result.errorCode ?? 'UPSTREAM_ERROR',
      message: result.message ?? '上游调用失败。',
      retryable: result.retryable === true,
      httpStatus: result.httpStatus ?? null,
      usage: UNKNOWN_USAGE,
    };

    // 配置/请求类错误（401/403/400 等）绝不重试。
    if (!base.retryable || base.errorCode === 'UPSTREAM_AUTH' || base.errorCode === 'CONFIG_MISSING_KEY') {
      logMeta({
        route: 'deepseek.call',
        status: base.httpStatus ?? 0,
        model: env.model,
        elapsedMs: Date.now() - startedAt,
        errorCode: base.errorCode,
        attempts,
        extraRetries,
        taskKey: params.runId,
        note: `fail:${params.purpose}`,
      });
      return failure(base, { attempts, extraRetries, elapsedMs: Date.now() - startedAt });
    }

    // 额度：本批次额外重试总量有上限。
    if (extraRetries >= MAX_EXTRA_RETRIES_PER_BATCH) {
      logMeta({
        route: 'deepseek.call',
        status: 429,
        model: env.model,
        elapsedMs: Date.now() - startedAt,
        errorCode: 'QUOTA_EXCEEDED',
        attempts,
        extraRetries,
        taskKey: params.runId,
        note: 'quota:batch_retry_exhausted',
      });
      return failure(
        {
          ...base,
          errorCode: 'QUOTA_EXCEEDED',
          message: `同一批次（runId=${params.runId}）的额外重试额度已用尽（上限 ${MAX_EXTRA_RETRIES_PER_BATCH} 次）：${base.message}`,
          retryable: false,
        },
        { attempts, extraRetries, elapsedMs: Date.now() - startedAt },
      );
    }

    // Retry-After 太长就不干等：直接如实说明，交给作者手动重试。
    const retryAfterMs = result.retryAfterMs ?? null;
    if (retryAfterMs !== null && retryAfterMs > RETRY_AFTER_MAX_MS) {
      logMeta({
        route: 'deepseek.call',
        status: base.httpStatus ?? 429,
        model: env.model,
        elapsedMs: Date.now() - startedAt,
        errorCode: 'QUOTA_EXCEEDED',
        attempts,
        extraRetries,
        taskKey: params.runId,
        note: 'quota:retry_after_too_long',
      });
      return failure(
        {
          ...base,
          errorCode: 'QUOTA_EXCEEDED',
          message: `上游要求等待约 ${Math.round(retryAfterMs / 1000)} 秒（超过本地 ${Math.round(RETRY_AFTER_MAX_MS / 1000)} 秒上限），未继续重试：${base.message}`,
          retryable: false,
        },
        { attempts, extraRetries, elapsedMs: Date.now() - startedAt },
      );
    }

    // 记账后才等待：额度按 runId 跨请求共享。
    if (!consumeExtraRetry(params.runId)) {
      logMeta({
        route: 'deepseek.call',
        status: 429,
        model: env.model,
        elapsedMs: Date.now() - startedAt,
        errorCode: 'QUOTA_EXCEEDED',
        attempts,
        extraRetries: extraRetriesUsed(params.runId),
        taskKey: params.runId,
        note: 'quota:batch_ledger_exhausted',
      });
      return failure(
        {
          ...base,
          errorCode: 'QUOTA_EXCEEDED',
          message: `本批次（runId=${params.runId}）的额外重试额度已用尽（上限 ${MAX_EXTRA_RETRIES_PER_BATCH} 次），未继续重试：${base.message}`,
          retryable: false,
        },
        { attempts, extraRetries: extraRetriesUsed(params.runId), elapsedMs: Date.now() - startedAt },
      );
    }

    const waitMs = retryAfterMs ?? backoffMs(extraRetries);
    extraRetries += 1;
    logMeta({
      route: 'deepseek.call',
      status: base.httpStatus ?? 0,
      model: env.model,
      elapsedMs: Date.now() - startedAt,
      errorCode: base.errorCode,
      attempts,
      extraRetries,
      taskKey: params.runId,
      note: `retry:${params.purpose}:wait_${waitMs}ms`,
    });
    await delay(waitMs);
  }
}

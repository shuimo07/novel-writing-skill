/**
 * 后端接口封装。
 *
 * 两种运行模式：
 * 1. **本地模式**（默认，`npm run dev` / `npm start`）：只调本机 `/api/*`，Key 只存在服务端进程里，前端不接收、不保存、不转发。
 * 2. **静态直连模式**（`VITE_STATIC_DEMO=1`，用于只有静态托管的 GitHub Pages）：没有服务端，
 *    由访客填自己的 Key，浏览器直连 `api.deepseek.com`（BYOK）。Key 只存在内存（可选本标签页），
 *    不写 localStorage / IndexedDB / 备份 / 导出 / 日志，只发给 DeepSeek 一个域名。
 *
 * 两种模式都走同一套提示词与同一套校验关卡（见 directClient.ts 顶部说明）。
 */
import {
  AnalyzeSampleResponseSchema,
  ApiErrorSchema,
  DistillResponseSchema,
  StatusResponseSchema,
  TryoutResponseSchema,
  type AnalyzeSampleRequest,
  type AnalyzeSampleResponse,
  type DistillRequest,
  type DistillResponse,
  type StatusResponse,
  type TryoutRequest,
  type TryoutResponse,
} from '../shared/schema';
import {
  MAX_CHARS_PER_SAMPLE,
  MAX_EXTRA_RETRIES_PER_BATCH,
  MAX_SAMPLES_PER_BATCH,
  MAX_TOTAL_CHARS_PER_BATCH,
  PROMPT_VERSION,
  TRYOUT_TARGET_MAX,
  TRYOUT_TARGET_MIN,
} from '../shared/limits';
import { ApiClientError } from './clientError';
import { directAnalyzeSample, directDistill, directTryout } from './directClient';
import { getCredentials } from './directCredentials';
import type { z } from 'zod';

export { ApiClientError } from './clientError';
export type { ClientErrorCode } from './clientError';

/** 静态直连模式（构建时由 VITE_STATIC_DEMO=1 打开）。 */
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1';

export const STATIC_DEMO_NO_KEY_NOTICE =
  '这是托管在 GitHub Pages 上的静态版：没有服务端，所以模型调用需要你自己的 DeepSeek API Key。' +
  '在页面顶部「模型凭据」里填一次即可（只发给 api.deepseek.com，不经过任何中转，也不会花别人的额度）。' +
  '不填 Key 也能用：写作、样本库、直接采样与本地统计、备份与恢复、规则确认、SKILL.md 与 style-profile.json 预览导出。';

export const STATIC_DEMO_NOTICE =
  '静态直连模式：本页只有前端，没有服务端。模型调用由你自己填的 DeepSeek API Key 直连完成，' +
  'Key 只存在你的浏览器内存里（勾选后也只存到本标签页），不进 localStorage、不进备份、不进导出文件。' +
  '所有校验（引用必须是原文子串、通用规则至少两篇、题目强制特征不许当成个人习惯）与本地版完全一致。';

function message(err: unknown): string {
  return err instanceof Error ? err.message : '未知错误';
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __raw: text };
  }
}

async function send<S extends z.ZodTypeAny>(path: string, init: RequestInit, schema: S): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
    });
  } catch (err) {
    throw new ApiClientError('NETWORK_ERROR', `连不上本地服务（${path}）：${message(err)}。请确认本地服务已启动。`, {
      path,
      retryable: true,
    });
  }

  const payload = await readJson(res);
  const apiError = ApiErrorSchema.safeParse(payload);
  if (apiError.success) {
    throw new ApiClientError(apiError.data.errorCode, apiError.data.message, {
      path,
      retryable: apiError.data.retryable,
      httpStatus: res.status,
    });
  }
  if (!res.ok) {
    throw new ApiClientError(res.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR', `请求 ${path} 失败：HTTP ${res.status}`, {
      path,
      httpStatus: res.status,
      retryable: res.status >= 500,
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
      .join('；');
    throw new ApiClientError('CLIENT_SCHEMA_MISMATCH', `服务端返回与本项目 schema 不一致（${path}）：${detail}`, {
      path,
      httpStatus: res.status,
    });
  }
  return parsed.data;
}

function postJson<S extends z.ZodTypeAny>(path: string, schema: S, body: unknown): Promise<z.infer<S>> {
  return send(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    schema,
  );
}

/** 只有显式要求时才往请求体里加 mock 标记，绝不“没配 Key 就自动变成 Mock”。 */
function withMockFlag<T extends object>(body: T, mock: boolean): T | (T & { mock: true }) {
  return mock ? { ...body, mock: true } : body;
}

export async function fetchStatus(): Promise<StatusResponse> {
  if (STATIC_DEMO) {
    // 静态版没有服务端：返回一份本地状态。填了 Key 就显示已配置（Key 本身绝不回传）。
    const credentials = getCredentials();
    return {
      ok: true,
      apiKeyConfigured: credentials !== null,
      mockEnabled: false,
      model: credentials?.model ?? 'deepseek-flash（未填 Key）',
      promptVersion: PROMPT_VERSION,
      limits: {
        maxCharsPerSample: MAX_CHARS_PER_SAMPLE,
        maxSamplesPerBatch: MAX_SAMPLES_PER_BATCH,
        maxTotalCharsPerBatch: MAX_TOTAL_CHARS_PER_BATCH,
        maxExtraRetriesPerBatch: MAX_EXTRA_RETRIES_PER_BATCH,
        targetMinChars: TRYOUT_TARGET_MIN,
        targetMaxChars: TRYOUT_TARGET_MAX,
      },
      priceNote: null,
    };
  }
  return send('/api/status', { method: 'GET' }, StatusResponseSchema);
}

export async function analyzeSample(req: AnalyzeSampleRequest, mock = false): Promise<AnalyzeSampleResponse> {
  if (STATIC_DEMO) return directAnalyzeSample(req);
  return postJson('/api/analyze-sample', AnalyzeSampleResponseSchema, withMockFlag(req, mock));
}

export async function distill(req: DistillRequest, mock = false): Promise<DistillResponse> {
  if (STATIC_DEMO) return directDistill(req);
  return postJson('/api/distill', DistillResponseSchema, withMockFlag(req, mock));
}

export async function tryout(req: TryoutRequest, mock = false): Promise<TryoutResponse> {
  if (STATIC_DEMO) return directTryout(req);
  return postJson('/api/tryout', TryoutResponseSchema, withMockFlag(req, mock));
}

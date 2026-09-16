/**
 * 后端接口封装。
 *
 * 三条线：
 * 1. 只调本机 `/api/*`，没有“任意目标地址”的入口；
 * 2. API Key 只存在服务端，前端不接收、不保存、不转发；
 * 3. 响应一律过 shared/schema.ts 的 Zod 校验：对不上就报错，不猜、不修补。
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
  type ErrorCode,
  type StatusResponse,
  type TryoutRequest,
  type TryoutResponse,
} from '../shared/schema';
import type { z } from 'zod';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'CLIENT_SCHEMA_MISMATCH';

export class ApiClientError extends Error {
  readonly errorCode: ClientErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly path: string;

  constructor(
    errorCode: ClientErrorCode,
    message: string,
    options: { path: string; retryable?: boolean; httpStatus?: number | null },
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.errorCode = errorCode;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
    this.path = options.path;
  }
}

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

async function send<S extends z.ZodTypeAny>(
  path: string,
  init: RequestInit,
  schema: S,
): Promise<z.infer<S>> {
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
  return send('/api/status', { method: 'GET' }, StatusResponseSchema);
}

/**
 * 单篇分析（服务端路由：POST /api/analyze-sample）。
 * mock=true 时在请求体里显式带 `mock: true`：服务端只有在 ALLOW_MOCK_ANALYSIS=1 时才会接受，
 * 否则回 MOCK_DISABLED。请求体的 mock 字段不在接口 schema 里（schema 只描述业务数据），
 * 但服务端就是这么判定 Mock 的（见 src/server/routes.ts 的 resolveMockMode）。
 */
export async function analyzeSample(req: AnalyzeSampleRequest, mock = false): Promise<AnalyzeSampleResponse> {
  return postJson('/api/analyze-sample', AnalyzeSampleResponseSchema, withMockFlag(req, mock));
}

export async function distill(req: DistillRequest, mock = false): Promise<DistillResponse> {
  return postJson('/api/distill', DistillResponseSchema, withMockFlag(req, mock));
}

export async function tryout(req: TryoutRequest, mock = false): Promise<TryoutResponse> {
  return postJson('/api/tryout', TryoutResponseSchema, withMockFlag(req, mock));
}

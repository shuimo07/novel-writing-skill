/**
 * HTTP 路由层。
 *
 * 职责边界（刻意划得很死）：
 * - 本文件只做「协议 + 编排 + 安全检查」：解析校验请求、限流/限长、去重、调用上游、把结果交给
 *   shared/verify.ts 与 shared/rules.ts 做验收与后处理、再按接口协议返回。
 * - 文风相关的判断一律不在路由里发明：单篇出证据由 gateAnalysisOutput 说了算，
 *   归纳候选由 buildCandidates 说了算（降级、拒绝都在那边）。
 *
 * 安全与调用控制（硬要求，逐条对照实现）：
 * - 只服务本机：Host 头必须是 127.0.0.1 / localhost / [::1]（任意端口），防 DNS rebinding；
 *   带 Origin 的请求其 host 也必须在同一白名单里，否则 403 NOT_ALLOWED_ORIGIN。
 * - POST 必须 Content-Type: application/json，否则 415 BAD_CONTENT_TYPE；请求体上限 1mb。
 * - 长度必须以服务端为准再验一次（checkLengthLimits），违反返回 400 LENGTH_LIMIT。
 * - analyze-sample / tryout 用 `${runId}:${sampleId}`、`${runId}:tryout` 做在飞去重，重复即 409 DUPLICATE_TASK。
 * - 缺 Key 一律 400 CONFIG_MISSING_KEY，绝不伪造分析结果；Mock 只在 ALLOW_MOCK_ANALYSIS=1 且请求显式带 mock:true 时启用。
 * - 日志只走 env.ts 的 logMeta：路由、状态码、模型、token、耗时、错误码；不含正文与密钥。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';

import { ALLOWED_ORIGIN_HOSTS, PROMPT_VERSION } from '../shared/limits';
import { buildCandidates, type DistillContextSample } from '../shared/rules';
import {
  AnalyzeSampleRequestSchema,
  AnalyzeSampleResponseSchema,
  DistillOutputSchema,
  DistillRequestSchema,
  DistillResponseSchema,
  StatusResponseSchema,
  TryoutRequestSchema,
  TryoutResponseSchema,
  UNKNOWN_USAGE,
  type ApiError,
  type DistillRequest,
  type DistillResponse,
  type ErrorCode,
  type ModelRule,
  type StatusResponse,
  type TryoutOutput,
  type TryoutResponse,
  type Usage,
} from '../shared/schema';
import { checkLengthLimits, computeTextStats, countChars, splitParagraphs } from '../shared/text';
import { gateAnalysisOutput } from '../shared/verify';
import { callDeepSeek, sumUsage, type CallFailure, type CallResult, type CallSuccess } from './deepseek';
import {
  HINT_WITHOUT_WEB_BUILD,
  JSON_BODY_LIMIT,
  configMissingKeyMessage,
  logMeta,
  readEnv,
  statusLimits,
  type ServerEnv,
} from './env';
import { beginTask, endTask } from './jobs';
import { mockAnalyzeContent, mockDistillRawRules, mockTryoutText } from './mock';
import { buildAnalyzeMessages, buildDistillMessages, buildTryoutMessages } from './prompts';

/* ------------------------------------------------------------- 错误与映射 */

/** 内部错误载体：所有路由都抛它，由统一错误中间件翻译成 ApiError 响应。 */
class ApiFailure extends Error {
  readonly errorCode: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(errorCode: ErrorCode, message: string, httpStatus: number, retryable: boolean, details?: unknown) {
    super(message);
    this.name = 'ApiFailure';
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.details = details;
  }
}

/** 错误码 → HTTP 状态码：只用 400/401/403/404/409/413/415/429/500/504 这几档。 */
function httpStatusForErrorCode(code: ErrorCode): number {
  switch (code) {
    case 'CONFIG_MISSING_KEY':
    case 'MOCK_DISABLED':
    case 'BAD_REQUEST':
    case 'LENGTH_LIMIT':
      return 400;
    case 'UPSTREAM_AUTH':
      return 401;
    case 'NOT_ALLOWED_ORIGIN':
    case 'EXPORT_BLOCKED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'DUPLICATE_TASK':
    case 'STALE_SAMPLE':
      return 409;
    case 'BAD_CONTENT_TYPE':
      return 415;
    case 'QUOTA_EXCEEDED':
      return 429;
    case 'UPSTREAM_TIMEOUT':
      return 504;
    default:
      // 模型输出的内容级问题（截断/非 JSON/schema 不符/证据不通过）与上游 5xx 都归 500。
      return 500;
  }
}

/** 默认是否值得作者手动重试。 */
function defaultRetryable(code: ErrorCode): boolean {
  switch (code) {
    case 'INVALID_JSON':
    case 'SCHEMA_MISMATCH':
    case 'EMPTY_RESPONSE':
    case 'TRUNCATED':
    case 'EVIDENCE_INVALID':
    case 'UPSTREAM_ERROR':
    case 'UPSTREAM_TIMEOUT':
      return true;
    default:
      return false;
  }
}

function sendApiError(
  res: Response,
  errorCode: ErrorCode,
  message: string,
  retryable: boolean,
  httpStatus: number,
  details?: unknown,
): void {
  const body: ApiError =
    details === undefined
      ? { ok: false, errorCode, message, retryable }
      : { ok: false, errorCode, message, retryable, details };
  res.status(httpStatus).json(body);
}

/**
 * Zod 问题清单 → 可回给同源客户端的 details。
 * 刻意丢掉 zod 的 `received` 内容，只留路径、码与说明，避免把用户正文回显出去。
 */
function zodDetails(error: ZodError): unknown {
  return error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.join('.') || '(root)',
    code: issue.code,
    message:
      issue.code === 'invalid_enum_value' || issue.code === 'invalid_union' || issue.code === 'invalid_literal'
        ? '取值不在允许范围内'
        : issue.message,
  }));
}

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/** Express 4 不会自动捕获 async 异常，统一包一层。 */
function handle(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/* --------------------------------------------------------------- 安全校验 */

/** Host 头必须是回环地址（任意端口），否则拒绝：防 DNS rebinding。 */
function hostAllowed(hostHeader: string | undefined): boolean {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false;
  const host = hostHeader.trim().toLowerCase();
  const matched = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host);
  const name = matched ? matched[1] : host;
  return ALLOWED_ORIGIN_HOSTS.includes(name);
}

/** 带 Origin 的请求：其 host 必须在回环白名单里（任意端口）；没有 Origin 的同源导航请求放行。 */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin.toLowerCase() === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return ALLOWED_ORIGIN_HOSTS.includes(url.hostname.toLowerCase());
}

function loopbackGuard(req: Request, res: Response, next: NextFunction): void {
  if (hostAllowed(req.headers.host)) {
    next();
    return;
  }
  sendApiError(
    res,
    'NOT_ALLOWED_ORIGIN',
    'Host 头不是本机回环地址：本服务只服务本机的同源页面（127.0.0.1 / localhost / [::1]）。',
    false,
    403,
    { allowedHosts: ALLOWED_ORIGIN_HOSTS },
  );
}

function originGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (originAllowed(origin)) {
    next();
    return;
  }
  sendApiError(
    res,
    'NOT_ALLOWED_ORIGIN',
    '请求来源不在本机白名单：Origin 的 host 必须是 127.0.0.1 / localhost / [::1]（端口不限）。',
    false,
    403,
    { allowedHosts: ALLOWED_ORIGIN_HOSTS },
  );
}

/** POST 必须声明 application/json（允许带 charset 参数）。 */
function assertJsonContentType(req: Request): void {
  const raw = req.headers['content-type'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const mime = (header ?? '').split(';')[0].trim().toLowerCase();
  if (mime !== 'application/json') {
    throw new ApiFailure(
      'BAD_CONTENT_TYPE',
      'POST 请求必须使用 Content-Type: application/json。',
      httpStatusForErrorCode('BAD_CONTENT_TYPE'),
      false,
    );
  }
}

/** 解析并校验请求体；不通过一律 400 BAD_REQUEST（不猜、不修补）。 */
function parseJsonBody<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  assertJsonContentType(req);
  const body: unknown = req.body ?? {};
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiFailure('BAD_REQUEST', '请求体不符合接口协议，详见 details。', 400, false, zodDetails(parsed.error));
  }
  return parsed.data;
}

/** 只有显式带了 mock:true 才算请求 Mock。 */
function mockRequested(rawBody: unknown): boolean {
  return typeof rawBody === 'object' && rawBody !== null && (rawBody as { mock?: unknown }).mock === true;
}

/**
 * Mock 开关判定。
 * 只有在 ALLOW_MOCK_ANALYSIS=1（或以 true 显式开启）时才允许；未开开关就来请求 Mock 返回 MOCK_DISABLED。
 * 开关打开但请求没带 mock:true 时，仍然走真实调用（避免“没配 Key 就自动变 Mock”这种伪造行为）。
 */
function resolveMockMode(rawBody: unknown, env: ServerEnv): boolean {
  if (!mockRequested(rawBody)) return false;
  if (!env.mockEnabled) {
    throw new ApiFailure(
      'MOCK_DISABLED',
      'Mock 分析未启用：需要以 ALLOW_MOCK_ANALYSIS=1 启动服务后，再在请求体里带 "mock": true。Mock 结果不能作为正式文风结论，也不能导出为 Skill。',
      httpStatusForErrorCode('MOCK_DISABLED'),
      false,
    );
  }
  return true;
}

function assertApiKey(env: ServerEnv, useMock: boolean): void {
  if (useMock) return;
  if (!env.apiKeyConfigured) {
    throw new ApiFailure('CONFIG_MISSING_KEY', configMissingKeyMessage(), 400, false);
  }
}

/** 长度必须服务端再验一次：不信前端。 */
function assertLengthLimits(samples: { chars?: number; text?: string }[]): void {
  const violations = checkLengthLimits(samples, statusLimits());
  if (violations.length > 0) {
    throw new ApiFailure('LENGTH_LIMIT', violations[0].message, 400, false, violations);
  }
}

/* --------------------------------------------------------- 上游结果的翻译 */

function upstreamFailure(failure: CallFailure, taskKey: string, route: string, env: ServerEnv, elapsedMs: number): ApiFailure {
  logMeta({
    route,
    status: httpStatusForErrorCode(failure.errorCode),
    model: env.model,
    elapsedMs,
    usage: failure.usage,
    errorCode: failure.errorCode,
    attempts: failure.attempts,
    extraRetries: failure.extraRetries,
    taskKey,
    note: 'upstream_failed',
  });
  return new ApiFailure(
    failure.errorCode,
    failure.message,
    httpStatusForErrorCode(failure.errorCode),
    failure.retryable,
    { attempts: failure.attempts, httpStatus: failure.httpStatus },
  );
}

/** 归纳：模型输出必须自己过一遍解析与 schema（分析那条路交给 gateAnalysisOutput）。 */
function parseDistillCandidates(call: CallSuccess): ModelRule[] {
  if (call.finishReason === 'length') {
    throw new ApiFailure('TRUNCATED', '模型输出被截断（finish_reason=length），归纳结果不可用：请减少样本数或缩短备注后重试。', 500, true);
  }
  if (call.content.trim() === '') {
    throw new ApiFailure('EMPTY_RESPONSE', '模型返回空正文，没有产生任何候选规则。', 500, true);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(call.content);
  } catch {
    // 不回显模型正文（哪怕只是片段），只报告事实。
    throw new ApiFailure('INVALID_JSON', '模型返回不是合法 JSON，已拒绝保存本轮归纳结果。', 500, true);
  }
  const parsed = DistillOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ApiFailure(
      'SCHEMA_MISMATCH',
      '模型返回不符合本项目的归纳 schema，已拒绝保存本轮归纳结果。',
      500,
      true,
      zodDetails(parsed.error),
    );
  }
  return parsed.data.candidates;
}

/** 试写：不解析 JSON（自由文本），只检查截断与空正文。 */
function assertTryoutOutput(call: CallSuccess, label: string): string {
  if (call.finishReason === 'length') {
    throw new ApiFailure('TRUNCATED', `${label}输出被截断（finish_reason=length），结果不可用：请缩短题目后重试。`, 500, true);
  }
  if (call.content.trim() === '') {
    throw new ApiFailure('EMPTY_RESPONSE', `${label}返回空正文，未保存为有效试写。`, 500, true);
  }
  return call.content;
}

/* --------------------------------------------------------- 归纳上下文映射 */

/**
 * 请求里的 samples → buildCandidates 需要的 DistillContextSample。
 * originDocumentId 直接当 sourceDocumentId：同篇切分出的片段算一份支持，
 * useForAnalysis 由 holdout 反推（保留样本不参与本轮提炼）。
 * textSample（正文开头约 200 字）原样透传：buildCandidates 只在拿到它时才做近似重复聚类，
 * 否则只能退回按文稿计数 —— 少传就等于放宽“独立支持”的门槛，所以这里不做任何裁剪或改写。
 */
function toContextSamples(samples: DistillRequest['samples']): DistillContextSample[] {
  return samples.map((sample) => ({
    sampleId: sample.sampleId,
    revision: sample.revision,
    contentHash: sample.contentHash,
    sourceDocumentId: sample.originDocumentId,
    sceneTags: sample.sceneTags,
    constraintKnown: sample.constraintKnown,
    taskConstraints: sample.taskConstraints,
    backgroundContext: sample.backgroundContext,
    // schema 里 default(null)，这里再兜一次，兼容未带该字段的旧客户端。
    textSample: sample.textSample ?? null,
    holdout: sample.holdout,
    useForAnalysis: !sample.holdout,
    sourceType: sample.sourceType,
    analysis: sample.analysis,
  }));
}

/* --------------------------------------------------------------- 具体路由 */

function analyzeSampleHandler(): RequestHandler {
  return handle(async (req, res) => {
    const env = readEnv();
    const request = parseJsonBody(req, AnalyzeSampleRequestSchema);
    const useMock = resolveMockMode(req.body, env);

    assertLengthLimits([{ text: request.text }]);
    if (countChars(request.text) === 0) {
      throw new ApiFailure('BAD_REQUEST', '正文为空或只有空白字符，无法分析。', 400, false);
    }
    assertApiKey(env, useMock);

    const taskKey = `${request.runId}:${request.sampleId}`;
    const ticket = beginTask(taskKey);
    if (!ticket) {
      // 同键已在飞行中：不重复调用上游，直接如实告知。
      throw new ApiFailure('DUPLICATE_TASK', '相同任务正在运行，未重复发起。', 409, false, { taskKey });
    }

    const startedAt = Date.now();
    try {
      const paragraphs = splitParagraphs(request.text);
      const stats = computeTextStats(request.text, paragraphs);

      let call: CallResult | null = null;
      let rawContent: string;
      if (useMock) {
        rawContent = mockAnalyzeContent({
          sampleId: request.sampleId,
          sampleRevision: request.sampleRevision,
          paragraphs,
          stats,
          constraintKnown: request.constraintKnown,
        });
      } else {
        call = await callDeepSeek(
          {
            messages: buildAnalyzeMessages(request, paragraphs),
            temperature: env.analyzeTemperature,
            maxTokens: env.analyzeMaxTokens,
            jsonMode: true,
            disableThinking: true,
            runId: request.runId,
            purpose: 'analyze',
          },
          env,
        );
        if (!call.ok) {
          throw upstreamFailure(call, taskKey, 'POST /api/analyze-sample', env, Date.now() - startedAt);
        }
        rawContent = call.content;
      }

      const elapsedMs = Date.now() - startedAt;
      // 空正文 / 截断 / JSON 不合法 / schema 不符 / 引用不是原文子串 —— 全部由 gate 判定，
      // 判不通过就落成 status='rejected' 的分析（带 errorCode），绝不悄悄改成“有效分析”。
      const analysis = gateAnalysisOutput({
        sampleId: request.sampleId,
        sampleRevision: request.sampleRevision,
        contentHash: request.contentHash,
        taskConstraintsHash: request.taskConstraintsHash,
        paragraphs,
        stats,
        text: request.text,
        model: env.model,
        promptVersion: PROMPT_VERSION,
        temperature: env.analyzeTemperature,
        maxTokens: env.analyzeMaxTokens,
        runId: request.runId,
        mock: useMock,
        elapsedMs,
        usage: call?.usage ?? UNKNOWN_USAGE,
        // 任务书要求保存调用次数：这里把实际调用次数（含重试）写进分析记录。
        attempts: call?.attempts ?? 1,
        finishReason: call?.finishReason ?? null,
        rawContent,
        upstreamError: null,
        constraintKnown: request.constraintKnown,
      });

      logMeta({
        route: 'POST /api/analyze-sample',
        status: 200,
        model: env.model,
        mock: useMock,
        elapsedMs,
        usage: analysis.usage,
        errorCode: analysis.errorCode,
        attempts: call?.attempts ?? 1,
        extraRetries: call?.extraRetries ?? 0,
        taskKey,
        note: analysis.status === 'rejected' ? 'gate_rejected' : `gate_${analysis.status}`,
      });

      res.json(AnalyzeSampleResponseSchema.parse({ ok: true, analysis }));
    } finally {
      endTask(ticket);
    }
  });
}

function distillHandler(): RequestHandler {
  return handle(async (req, res) => {
    const env = readEnv();
    const request = parseJsonBody(req, DistillRequestSchema);
    const useMock = resolveMockMode(req.body, env);

    // 归纳请求里没有原文可比对，只能拿样本自报字数与已保存的 stats 里较大的那个当口径（宁可更严）。
    assertLengthLimits(request.samples.map((s) => ({ chars: Math.max(s.chars, s.analysis.stats.chars) })));
    assertApiKey(env, useMock);

    const contextSamples = toContextSamples(request.samples);
    const startedAt = Date.now();
    let rawRules: ModelRule[];
    let usage: Usage = UNKNOWN_USAGE;
    let call: CallResult | null = null;
    let extraRetries = 0;

    if (useMock) {
      rawRules = mockDistillRawRules(request.samples);
    } else {
      // 归纳同样防重复点击：同一批次的归纳在飞行中时直接 409，不重复调用上游（Mock 不占额度）。
      const distillTaskKey = `${request.runId}:distill`;
      const distillTicket = beginTask(distillTaskKey);
      if (!distillTicket) {
        throw new ApiFailure('DUPLICATE_TASK', '相同任务正在运行，未重复发起。', 409, false, { taskKey: distillTaskKey });
      }
      try {
        call = await callDeepSeek(
          {
            messages: buildDistillMessages(request),
            temperature: env.analyzeTemperature,
            maxTokens: env.analyzeMaxTokens,
            jsonMode: true,
            disableThinking: true,
            runId: request.runId,
            purpose: 'distill',
          },
          env,
        );
        if (!call.ok) {
          throw upstreamFailure(call, request.runId, 'POST /api/distill', env, Date.now() - startedAt);
        }
        usage = call.usage;
        extraRetries = call.extraRetries;
        rawRules = parseDistillCandidates(call);
      } finally {
        endTask(distillTicket);
      }
    }

    // 服务端再校验与降级（引用必须命中已通过校验的分析、通用习惯至少两篇、题目强制的说法不许当作者习惯）。
    const built = buildCandidates({
      rawRules,
      samples: contextSamples,
      previousRules: request.previousRules,
    });

    const elapsedMs = Date.now() - startedAt;
    const response: DistillResponse = {
      ok: true,
      candidates: built.candidates,
      rejectedCandidates: built.rejected,
      usage,
      model: env.model,
      promptVersion: PROMPT_VERSION,
      mock: useMock,
      elapsedMs,
    };

    logMeta({
      route: 'POST /api/distill',
      status: 200,
      model: env.model,
      mock: useMock,
      elapsedMs,
      usage,
      attempts: call?.attempts ?? 1,
      extraRetries,
      taskKey: request.runId,
      note: `candidates:${built.candidates.length},rejected:${built.rejected.length}`,
    });

    res.json(DistillResponseSchema.parse(response));
  });
}

function tryoutHandler(): RequestHandler {
  return handle(async (req, res) => {
    const env = readEnv();
    const request = parseJsonBody(req, TryoutRequestSchema);
    const useMock = resolveMockMode(req.body, env);
    assertApiKey(env, useMock);

    const taskKey = `${request.runId}:tryout`;
    const ticket = beginTask(taskKey);
    if (!ticket) {
      throw new ApiFailure('DUPLICATE_TASK', '相同任务正在运行，未重复发起。', 409, false, { taskKey });
    }

    const startedAt = Date.now();
    try {
      // 同一题目、同一模型、完全相同参数；唯一差别是系统提示里有没有 SKILL.md。
      const messages = buildTryoutMessages({
        prompt: request.prompt,
        targetMinChars: request.targetMinChars,
        targetMaxChars: request.targetMaxChars,
        skillMarkdown: request.skillMarkdown,
      });
      const params = { temperature: env.tryoutTemperature, maxTokens: env.tryoutMaxTokens };

      let base: TryoutOutput;
      let withSkill: TryoutOutput;
      let usage: Usage = UNKNOWN_USAGE;
      let attempts = 1;
      let extraRetries = 0;

      if (useMock) {
        const baseStartedAt = Date.now();
        const baseText = mockTryoutText({
          prompt: request.prompt,
          targetMinChars: request.targetMinChars,
          targetMaxChars: request.targetMaxChars,
          withSkill: false,
        });
        base = { text: baseText, chars: countChars(baseText), usage: UNKNOWN_USAGE, finishReason: null };
        const baseElapsed = Date.now() - baseStartedAt;

        const skillStartedAt = Date.now();
        const skillText = mockTryoutText({
          prompt: request.prompt,
          targetMinChars: request.targetMinChars,
          targetMaxChars: request.targetMaxChars,
          withSkill: true,
        });
        withSkill = { text: skillText, chars: countChars(skillText), usage: UNKNOWN_USAGE, finishReason: null };
        logMeta({
          route: 'POST /api/tryout',
          status: 200,
          model: env.model,
          mock: true,
          elapsedMs: baseElapsed,
          taskKey,
          note: 'mock_base',
        });
        logMeta({
          route: 'POST /api/tryout',
          status: 200,
          model: env.model,
          mock: true,
          elapsedMs: Date.now() - skillStartedAt,
          taskKey,
          note: 'mock_with_skill',
        });
      } else {
        const baseCall = await callDeepSeek(
          {
            messages: messages.base,
            ...params,
            // 试写要自由文本：不带 response_format，也不带思考开关。
            jsonMode: false,
            disableThinking: false,
            runId: request.runId,
            purpose: 'tryout',
          },
          env,
        );
        if (!baseCall.ok) {
          throw upstreamFailure(baseCall, taskKey, 'POST /api/tryout', env, Date.now() - startedAt);
        }
        const baseText = assertTryoutOutput(baseCall, '基础版');
        base = { text: baseText, chars: countChars(baseText), usage: baseCall.usage, finishReason: baseCall.finishReason };
        logMeta({
          route: 'POST /api/tryout',
          status: 200,
          model: env.model,
          mock: false,
          elapsedMs: baseCall.elapsedMs,
          usage: baseCall.usage,
          attempts: baseCall.attempts,
          extraRetries: baseCall.extraRetries,
          taskKey,
          note: `tryout_base:${base.chars}chars`,
        });

        const skillCall = await callDeepSeek(
          {
            messages: messages.withSkill,
            ...params,
            jsonMode: false,
            disableThinking: false,
            runId: request.runId,
            purpose: 'tryout',
          },
          env,
        );
        if (!skillCall.ok) {
          throw upstreamFailure(skillCall, taskKey, 'POST /api/tryout', env, Date.now() - startedAt);
        }
        const skillText = assertTryoutOutput(skillCall, '加 Skill 版');
        withSkill = {
          text: skillText,
          chars: countChars(skillText),
          usage: skillCall.usage,
          finishReason: skillCall.finishReason,
        };
        usage = sumUsage(baseCall.usage, skillCall.usage);
        attempts = baseCall.attempts + skillCall.attempts;
        extraRetries = baseCall.extraRetries + skillCall.extraRetries;
        logMeta({
          route: 'POST /api/tryout',
          status: 200,
          model: env.model,
          mock: false,
          elapsedMs: skillCall.elapsedMs,
          usage: skillCall.usage,
          attempts: skillCall.attempts,
          extraRetries: skillCall.extraRetries,
          taskKey,
          note: `tryout_with_skill:${withSkill.chars}chars`,
        });
      }

      const elapsedMs = Date.now() - startedAt;
      const response: TryoutResponse = {
        ok: true,
        base,
        withSkill,
        model: env.model,
        params,
        elapsedMs,
        mock: useMock,
        usage,
      };
      logMeta({
        route: 'POST /api/tryout',
        status: 200,
        model: env.model,
        mock: useMock,
        elapsedMs,
        usage,
        attempts,
        extraRetries,
        taskKey,
        note: `tryout_done:base=${base.chars},skill=${withSkill.chars}`,
      });
      res.json(TryoutResponseSchema.parse(response));
    } finally {
      endTask(ticket);
    }
  });
}

function statusHandler(): RequestHandler {
  return (_req, res) => {
    const env = readEnv();
    const body: StatusResponse = {
      ok: true,
      // 只返回布尔：绝不返回密钥、密钥片段或长度。
      apiKeyConfigured: env.apiKeyConfigured,
      mockEnabled: env.mockEnabled,
      model: env.model,
      promptVersion: PROMPT_VERSION,
      limits: statusLimits(),
      // 未配置估价时必须是 null（界面显示“未知”）。
      priceNote: env.priceNote,
    };
    res.json(StatusResponseSchema.parse(body));
  };
}

/* ------------------------------------------------------------- 应用装配 */

export function createApiRouter(): express.Router {
  const router = express.Router();
  // 所有 /api 请求先过同源校验（含未知路径，避免探测）。
  router.use(originGuard);
  router.get('/status', statusHandler());
  router.post('/analyze-sample', analyzeSampleHandler());
  router.post('/distill', distillHandler());
  router.post('/tryout', tryoutHandler());
  router.use((_req, res) => {
    sendApiError(res, 'NOT_FOUND', '接口不存在。可用接口：GET /api/status、POST /api/analyze-sample、POST /api/distill、POST /api/tryout。', false, 404);
  });
  return router;
}

/** 服务端的项目根：src/server/ → 项目根。 */
function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function mountWebApp(app: express.Express): void {
  const webDir = resolve(projectRoot(), 'dist', 'web');
  const indexHtml = join(webDir, 'index.html');
  const staticMiddleware = express.static(webDir, { index: 'index.html', fallthrough: true, dotfiles: 'ignore' });

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    // 构建产物不存在时给一句人话提示，而不是 404 空白页。
    if (!existsSync(indexHtml)) {
      res.status(200).type('text/plain; charset=utf-8').send(HINT_WITHOUT_WEB_BUILD);
      return;
    }
    staticMiddleware(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      // 单页应用回落：未知路径（例如刷新 /run/xxx）一律返回 index.html。
      res.sendFile(indexHtml, (sendErr) => {
        if (sendErr) next(sendErr);
      });
    });
  });
}

/** 请求元信息日志：只有方法、路径、状态码、耗时。 */
function requestMetaLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  // 用 originalUrl：被 app.use('/api', ...) 挂载后 req.path 会变成挂载点相对路径，日志里会看不清路由。
  // 去掉查询串，只留路径本身。
  const route = `${req.method} ${req.originalUrl.split('?')[0]}`;
  res.on('finish', () => {
    logMeta({ route, status: res.statusCode, elapsedMs: Date.now() - startedAt });
  });
  next();
}

function errorMiddleware(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ApiFailure) {
    logMeta({ route: 'error', status: err.httpStatus, errorCode: err.errorCode, note: 'apifailure' });
    sendApiError(res, err.errorCode, err.message, err.retryable, err.httpStatus, err.details);
    return;
  }
  if (err instanceof ZodError) {
    sendApiError(res, 'BAD_REQUEST', '请求体不符合接口协议，详见 details。', false, 400, zodDetails(err));
    return;
  }

  const anyErr = err as { type?: string; status?: number; statusCode?: number; name?: string };
  const status = anyErr?.status ?? anyErr?.statusCode;
  if (anyErr?.type === 'entity.too.large' || status === 413) {
    sendApiError(res, 'LENGTH_LIMIT', '请求体超过 1MB 上限，请分批发送。', false, 413);
    return;
  }
  if (anyErr?.type === 'entity.parse.failed') {
    // 注意：不记录 body-parser 的 message，它在语法错误时会带上请求正文片段。
    sendApiError(res, 'BAD_REQUEST', '请求体不是合法 JSON。', false, 400);
    return;
  }

  // 兜底：只记录错误类型与（非语法错误的）短消息，绝不记录正文。
  const safeMessage =
    err instanceof SyntaxError ? undefined : (err as { message?: string })?.message?.slice(0, 200) ?? undefined;
  logMeta({ route: 'error', status: 500, errorCode: 'INTERNAL', note: `${anyErr?.name ?? 'Error'}:${safeMessage ?? ''}` });
  sendApiError(res, 'INTERNAL', '服务端内部错误。', false, 500);
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestMetaLogger);
  app.use(loopbackGuard);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use('/api', createApiRouter());
  mountWebApp(app);
  app.use((req: Request, res: Response) => {
    sendApiError(res, 'NOT_FOUND', '路径不存在或方法不被支持。', false, 404, { method: req.method });
  });
  app.use(errorMiddleware);
  return app;
}

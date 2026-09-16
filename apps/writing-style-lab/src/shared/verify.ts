/**
 * 证据与模型输出的验收关卡。
 *
 * 原则：**不通过就拒绝，绝不为了迁就模型去改写原文**。
 * 这里只做程序能确定性判断的事：JSON 能不能解析、schema 对不对、引用是不是原文的连续子串、
 * 版本/hash 有没有对上、有没有被截断。语义好不好由作者判断，程序不代替作者打分。
 */
import {
  type AnalysisStatus,
  type ErrorCode,
  type ModelObservation,
  type Observation,
  type RejectedObservation,
  type SampleAnalysis,
  type TextStats,
  type Usage,
  SampleAnalysisOutputSchema,
  UNKNOWN_USAGE,
} from './schema';
import type { Paragraph } from './text';
import { computeStylometry, crossCheckClaims, type Stylometry } from './stylometry';

export interface EvidenceContext {
  sampleId: string;
  sampleRevision: number;
  paragraphs: Paragraph[];
}

export interface EvidenceCheckOk {
  ok: true;
}
export interface EvidenceCheckFail {
  ok: false;
  code: ErrorCode;
  reason: string;
  /** 面向作者的提示，例如“空白字符不同”，但结论仍是拒绝。 */
  hint?: string;
}
export type EvidenceCheck = EvidenceCheckOk | EvidenceCheckFail;

const collapse = (s: string) => s.replace(/\s+/gu, '');

/**
 * 校验一条引用：段落必须存在，quote 必须是对应段落文本的真实连续子串（逐字，不做 trim）。
 * 第一次不通过时给一个“疑似原因”提示，但**不会**据此通过。
 */
export function checkEvidence(
  ev: { paragraphId: string; quote: string },
  ctx: EvidenceContext,
): EvidenceCheck {
  const paragraph = ctx.paragraphs.find((p) => p.id === ev.paragraphId);
  if (!paragraph) {
    return {
      ok: false,
      code: 'EVIDENCE_INVALID',
      reason: `段落 ${ev.paragraphId} 不存在（样本 ${ctx.sampleId} r${ctx.sampleRevision} 共 ${ctx.paragraphs.length} 段）`,
    };
  }
  if (ev.quote.length === 0) {
    return { ok: false, code: 'EVIDENCE_INVALID', reason: `段落 ${ev.paragraphId} 的引用为空` };
  }
  if (paragraph.text.includes(ev.quote)) return { ok: true };
  const hint = collapse(paragraph.text).includes(collapse(ev.quote))
    ? '引用去掉空白后能在该段落中找到，但逐字比对失败（可能改动了标点、空白或字词）'
    : '该段落中找不到这段文字';
  return {
    ok: false,
    code: 'EVIDENCE_INVALID',
    reason: `引用不是段落 ${ev.paragraphId} 的真实子串`,
    hint,
  };
}

export interface ObservationVerifyResult {
  ok: true;
  observation: Observation;
}
export interface ObservationRejected {
  ok: false;
  rejected: RejectedObservation;
}

let observationSeq = 0;
function nextObservationId(sampleId: string, revision: number): string {
  observationSeq += 1;
  return `${sampleId}-r${revision}-o${observationSeq}`;
}

/**
 * 单条观察的验收：证据逐条校验，全部通过才收下。
 * `constraintKnown === false`（直接采样无题目）时，约束影响一律强制记为 unknown，
 * 不允许模型把它当成“无约束”，否则短句类特征会被误当成作者习惯。
 */
export function verifyObservation(
  raw: ModelObservation,
  ctx: EvidenceContext,
  options: { constraintKnown: boolean },
): ObservationVerifyResult | ObservationRejected {
  const checked = raw.evidence.map((e) => ({ e, r: checkEvidence(e, ctx) }));
  const bad = checked.find((c) => !c.r.ok);
  if (bad && !bad.r.ok) {
    return {
      ok: false,
      rejected: {
        reason: bad.r.reason + (bad.r.hint ? `（${bad.r.hint}）` : ''),
        raw,
      },
    };
  }
  const limitations = [...(raw.limitations ?? [])];
  let influence = raw.constraintInfluence ?? 'unknown';
  if (!options.constraintKnown) {
    if (influence !== 'unknown') {
      limitations.push(`题目约束未知，模型原判为“${influence}”，已按“未知”处理`);
    }
    influence = 'unknown';
  }
  if (limitations.length === 0) {
    limitations.push('仅基于本篇文本，未覆盖其他场景');
  }
  return {
    ok: true,
    observation: {
      id: nextObservationId(ctx.sampleId, ctx.sampleRevision),
      dimension: raw.dimension,
      claim: raw.claim,
      scope: raw.scope ?? 'sample_only',
      evidence: raw.evidence.map((e) => ({
        sampleId: ctx.sampleId,
        sampleRevision: ctx.sampleRevision,
        paragraphId: e.paragraphId,
        quote: e.quote,
      })),
      constraintInfluence: influence,
      limitations,
    },
  };
}

export interface GateInput {
  sampleId: string;
  sampleRevision: number;
  contentHash: string;
  taskConstraintsHash: string | null;
  paragraphs: Paragraph[];
  stats: TextStats;
  text: string;
  model: string;
  promptVersion: string;
  temperature: number;
  maxTokens: number;
  runId: string | null;
  mock: boolean;
  elapsedMs: number;
  usage?: Usage | null;
  /** 本分析实际调用上游的次数（含重试）。 */
  attempts?: number;
  finishReason?: string | null;
  /** 上游返回的正文；上游失败时为 null。 */
  rawContent: string | null;
  /** 上游已经失败时直接给出错误码与说明，跳过解析。 */
  upstreamError?: { code: ErrorCode; message: string } | null;
  constraintKnown: boolean;
  now?: () => Date;
  idFactory?: () => string;
}

/** 空正文、截断、无效 JSON、schema 不符、证据不通过 —— 一律不能存成“有效分析”。 */
export function gateAnalysisOutput(input: GateInput): SampleAnalysis {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const stylometry: Stylometry = computeStylometry(input.text, input.paragraphs);
  const base = {
    id: input.idFactory ? input.idFactory() : `an_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    sampleId: input.sampleId,
    sampleRevision: input.sampleRevision,
    contentHash: input.contentHash,
    taskConstraintsHash: input.taskConstraintsHash,
    model: input.model,
    promptVersion: input.promptVersion,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    stats: input.stats,
    stylometry,
    observations: [] as Observation[],
    rejectedObservations: [] as RejectedObservation[],
    usage: input.usage ?? UNKNOWN_USAGE,
    attempts: input.attempts ?? 1,
    status: 'rejected' as AnalysisStatus,
    errorCode: null as ErrorCode | null,
    errorMessage: null as string | null,
    elapsedMs: input.elapsedMs,
    mock: input.mock,
    runId: input.runId,
    createdAt: now,
  };

  const fail = (code: ErrorCode, message: string): SampleAnalysis => ({
    ...base,
    status: 'rejected',
    errorCode: code,
    errorMessage: message,
  });

  if (input.upstreamError) return fail(input.upstreamError.code, input.upstreamError.message);
  if (input.finishReason === 'length') {
    return fail('TRUNCATED', '模型输出被截断（finish_reason=length），结果不可用，请缩短输入或调整参数后重试');
  }
  if (!input.rawContent || input.rawContent.trim() === '') {
    return fail('EMPTY_RESPONSE', '模型返回空正文，未保存为有效分析');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawContent);
  } catch (err) {
    return fail('INVALID_JSON', `模型返回不是合法 JSON：${(err as Error).message}`);
  }
  const schema = SampleAnalysisOutputSchema.safeParse(parsed);
  if (!schema.success) {
    return fail('SCHEMA_MISMATCH', `模型返回不符合本项目 schema：${schema.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`);
  }

  const ctx: EvidenceContext = {
    sampleId: input.sampleId,
    sampleRevision: input.sampleRevision,
    paragraphs: input.paragraphs,
  };
  const observations: Observation[] = [];
  const rejected: RejectedObservation[] = [];
  for (const raw of schema.data.observations) {
    const res = verifyObservation(raw, ctx, { constraintKnown: input.constraintKnown });
    if (res.ok) observations.push(res.observation);
    else rejected.push(res.rejected);
  }

  // 拿本地实测值核对模型的说法：只加局限提示，不删观察、不替作者下结论。
  const crossChecked = observations.map((o) => {
    const notes = crossCheckClaims(o.claim, o.dimension, stylometry);
    return notes.length === 0 ? o : { ...o, limitations: Array.from(new Set([...o.limitations, ...notes])) };
  });

  if (crossChecked.length === 0) {
    return {
      ...base,
      rejectedObservations: rejected,
      status: 'rejected',
      errorCode: 'EVIDENCE_INVALID',
      errorMessage: rejected.length
        ? `全部 ${rejected.length} 条观察的引用未通过校验，已拒绝保存为有效分析`
        : '模型没有给出任何观察',
    };
  }
  return {
    ...base,
    observations: crossChecked,
    rejectedObservations: rejected,
    status: rejected.length > 0 ? 'partial' : 'ok',
    errorCode: null,
    errorMessage: rejected.length ? `${rejected.length} 条观察因引用未通过校验被丢弃` : null,
  };
}

/** 一条分析是否还能作为规则依据（版本、hash、状态三重检查）。 */
export function isAnalysisUsable(a: SampleAnalysis): boolean {
  return (a.status === 'ok' || a.status === 'partial') && a.observations.length > 0;
}

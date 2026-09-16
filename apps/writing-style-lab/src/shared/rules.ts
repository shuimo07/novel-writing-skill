/**
 * 规则层：来源门禁、证据有效性重算、归纳后处理。
 *
 * 三条不许破的线：
 * 1. 默认只有“本人本次写作 / 本人旧文”且未被排除、非 holdout 的样本才能进提炼；
 * 2. 正文版本、来源、是否入选、holdout 任何一项变了，关联分析与规则依据立刻重验，缓存不能让已排除样本继续支撑新导出；
 * 3. 被框架强制的特征不许当成作者习惯 —— 这一条在这里用确定性规则拦，不指望模型自觉。
 */
import { MAX_CANDIDATE_RULES, MIN_GENERAL_SUPPORT } from './limits';
import {
  type DistillCandidate,
  type Evidence,
  type ModelRule,
  type PreferenceMark,
  type RejectedObservation,
  type RuleDecision,
  type RuleScope,
  type Sample,
  type SampleAnalysis,
  type SourceType,
  type StyleRule,
  ELIGIBLE_SOURCE_TYPES,
  SOURCE_TYPE_LABEL,
} from './schema';
import { isAnalysisUsable } from './verify';
import { countIndependentSupports } from './stylometry';

/* --------------------------------------------------------- 来源门禁与选择 */

export function isEligibleSource(sourceType: SourceType): boolean {
  return ELIGIBLE_SOURCE_TYPES.includes(sourceType);
}

/** 是否能进入本轮提炼。 */
export function isSampleEligible(sample: Sample): boolean {
  return isEligibleSource(sample.sourceType) && sample.useForAnalysis && !sample.holdout;
}

/** 默认发送清单：AI 生成、人机混合、未确认来源、holdout、已移出的一律不发。 */
export function selectSendableSamples(samples: Sample[]): Sample[] {
  return samples.filter(isSampleEligible);
}

/** 界面提示：这篇为什么不在清单里。 */
export function describeExclusion(sample: Sample): string | null {
  if (sample.holdout) return '保留样本（holdout）：不发送到本轮提炼，留给你事后人工对照';
  if (!sample.useForAnalysis) return '已移出本轮样本集';
  if (!isEligibleSource(sample.sourceType)) return `来源是“${SOURCE_TYPE_LABEL[sample.sourceType]}”，默认不参与提炼`;
  return null;
}

/* ------------------------------------------------------------- 证据有效性 */

export interface EvidenceValidity {
  evidence: Evidence;
  valid: boolean;
  reason: string;
}

export interface RuleStoreContext {
  samples: Sample[];
  analyses: SampleAnalysis[];
  preferences: PreferenceMark[];
}

/** 单条引用在当前数据状态下是否仍然成立。 */
export function checkEvidenceAgainstStore(ev: Evidence, ctx: RuleStoreContext): EvidenceValidity {
  const invalid = (reason: string): EvidenceValidity => ({ evidence: ev, valid: false, reason });
  const sample = ctx.samples.find((s) => s.id === ev.sampleId);
  if (!sample) return invalid('样本已删除');
  if (sample.revision !== ev.sampleRevision) return invalid(`正文版本已变（现在是 r${sample.revision}，引用的是 r${ev.sampleRevision}）`);
  const paragraph = sample.paragraphs.find((p) => p.id === ev.paragraphId);
  if (!paragraph) return invalid('段落已不存在');
  if (!paragraph.text.includes(ev.quote)) return invalid('引用已不在当前正文中');
  if (sample.holdout) return invalid('样本已改为保留样本');
  if (!sample.useForAnalysis) return invalid('样本已移出本轮样本集');
  if (!isEligibleSource(sample.sourceType)) return invalid(`样本来源已改为“${SOURCE_TYPE_LABEL[sample.sourceType]}”`);
  const analysis = ctx.analyses.find((a) => a.sampleId === sample.id && a.sampleRevision === sample.revision);
  if (!analysis) return invalid('缺少对应的有效分析');
  if (analysis.contentHash !== sample.contentHash) return invalid('分析基于的正文 hash 与当前正文不一致');
  if (!isAnalysisUsable(analysis)) return invalid(`关联分析状态为“${analysis.status}”，不能作为依据`);
  const hosted = analysis.observations.some((o) =>
    o.evidence.some((e) => e.paragraphId === ev.paragraphId && e.quote === ev.quote),
  );
  if (!hosted) return invalid('该引用不在已通过校验的分析中');
  return { evidence: ev, valid: true, reason: '有效' };
}

/**
 * 独立支持数：同一篇文稿切出的片段算一份；**近似重复（相似度 ≥ 0.85）也算一份** ——
 * 否则把同一段文字复制两份就能凑出“两篇支持”。（借鉴 perfectly-replicate-writing-skills 的去重思路）
 */
function distinctDocumentCount(evidence: Evidence[], ctx: RuleStoreContext): number {
  const items: { id: string; text: string; sourceDocumentId: string | null }[] = [];
  for (const ev of evidence) {
    const sample = ctx.samples.find((s) => s.id === ev.sampleId);
    items.push({
      id: ev.sampleId,
      text: sample?.text ?? ev.quote,
      sourceDocumentId: sample?.sourceDocumentId ?? null,
    });
  }
  return countIndependentSupports(items);
}

/**
 * 归纳阶段的“独立支持”计数。
 * 注意：**不能拿证据摘录当指纹** —— 两篇不同样本引用同一句话，恰恰是我们要找的跨篇信号，
 * 若当成重复会误杀。所以这里只在拿到正文样本（textSample，通常是开头一段）时才做近似重复聚类，
 * 否则退回按文稿计数。真正的严格去重在 recomputeRuleValidity（那里有完整正文）。
 */
function countSupports(supportSamples: DistillContextSample[]): number {
  const hasTextSamples = supportSamples.every((s) => (s.textSample ?? '').length >= 40);
  if (hasTextSamples) {
    return countIndependentSupports(
      supportSamples.map((h) => ({
        id: h.sampleId,
        sourceDocumentId: h.sourceDocumentId,
        text: h.textSample ?? '',
      })),
    );
  }
  return new Set(supportSamples.map((h) => h.sourceDocumentId ?? h.sampleId)).size;
}

/**
 * 重算一条规则的有效性。
 * - observed 规则：证据全部失效 → stale；支持文档数不满足当前 scope 的门槛 → stale 并降级为初步观察。
 * - preference 规则：允许没有原文证据（作者自己指定的），但一旦它带的证据全部失效也要提示。
 */
export function recomputeRuleValidity(rule: StyleRule, ctx: RuleStoreContext): StyleRule {
  const checks = rule.evidence.map((e) => checkEvidenceAgainstStore(e, ctx));
  const validEvidence = checks.filter((c) => c.valid).map((c) => c.evidence);
  const invalidReasons = checks.filter((c) => !c.valid).map((c) => c.reason);

  if (rule.origin === 'preference') {
    const markGone =
      rule.evidence.length > 0 &&
      validEvidence.length === 0 &&
      rule.evidence.every((e) => !ctx.samples.some((s) => s.id === e.sampleId));
    return {
      ...rule,
      evidence: validEvidence,
      stale: markGone,
      staleReason: markGone
        ? '它引用的样本已被删除，请确认这条偏好是否还要保留'
        : invalidReasons.length
          ? `部分原文依据已失效：${invalidReasons[0]}（偏好本身按你的声明保留）`
          : null,
      updatedAt: rule.updatedAt,
    };
  }

  if (validEvidence.length === 0) {
    return {
      ...rule,
      evidence: [],
      stale: true,
      staleReason: invalidReasons.length ? `规则依据已失效：${invalidReasons[0]}` : '规则已没有有效证据',
      updatedAt: rule.updatedAt,
    };
  }

  const docs = distinctDocumentCount(validEvidence, ctx);
  const required = rule.scope === 'general' ? MIN_GENERAL_SUPPORT : 1;
  if (docs < required) {
    return {
      ...rule,
      evidence: validEvidence,
      scope: 'preliminary' as RuleScope,
      stale: true,
      staleReason:
        (invalidReasons.length ? `规则依据已失效：${invalidReasons[0]}；` : '') +
        `有效支持样本只剩 ${docs} 篇，已不满足“${rule.scope === 'general' ? '通用习惯' : '该范围'}”的条件，需重新确认`,
      updatedAt: rule.updatedAt,
    };
  }

  return {
    ...rule,
    evidence: validEvidence,
    stale: false,
    staleReason: invalidReasons.length ? `有 ${invalidReasons.length} 条证据已失效并被移除：${invalidReasons[0]}` : null,
    updatedAt: rule.updatedAt,
  };
}

export function recomputeAllRules(rules: StyleRule[], ctx: RuleStoreContext): StyleRule[] {
  return rules.map((r) => recomputeRuleValidity(r, ctx));
}

/** 删除样本时：清掉引用该样本的证据并标失效，避免历史版本悄悄指向已删除的正文。 */
export function stripEvidenceForSamples(rules: StyleRule[], removedSampleIds: string[]): StyleRule[] {
  const removed = new Set(removedSampleIds);
  return rules.map((rule) => {
    const kept = rule.evidence.filter((e) => !removed.has(e.sampleId));
    const dropped = rule.evidence.length - kept.length;
    if (dropped === 0) return rule;
    return {
      ...rule,
      evidence: kept,
      stale: true,
      staleReason: `${dropped} 条引用来自已删除的样本，规则需要重新确认`,
      updatedAt: rule.updatedAt,
    };
  });
}

/* --------------------------------------------------- 归纳后处理（确定性） */

export interface DistillContextSample {
  sampleId: string;
  revision: number;
  contentHash: string;
  sourceDocumentId: string | null;
  sceneTags: string[];
  constraintKnown: boolean;
  taskConstraints: string[];
  backgroundContext: string | null;
  /** 可选：正文开头一段（约 200 字），用于归纳阶段的近似重复判定。没有就按文稿计数。 */
  textSample?: string | null;
  holdout: boolean;
  useForAnalysis: boolean;
  sourceType: SourceType;
  analysis: SampleAnalysis;
}

export function evidenceKey(ev: { sampleId: string; sampleRevision: number; paragraphId: string; quote: string }): string {
  return `${ev.sampleId}|r${ev.sampleRevision}|${ev.paragraphId}|${ev.quote}`;
}

/** 已通过校验、可用于规则引用的证据集合（只来自有效分析）。 */
export function collectVerifiedEvidenceKeys(samples: DistillContextSample[]): Set<string> {
  const keys = new Set<string>();
  for (const s of samples) {
    if (!isSampleEligible(s as unknown as Sample)) continue;
    if (!isAnalysisUsable(s.analysis)) continue;
    for (const o of s.analysis.observations) {
      for (const e of o.evidence) keys.add(evidenceKey(e));
    }
  }
  return keys;
}

/** 约束关键词重合检测：“全用短句”这类强制要求不能被当成作者习惯。 */
export function constraintOverlap(statement: string, constraints: string[]): string | null {
  const text = statement.replace(/\s+/gu, '');
  for (const c of constraints) {
    const token = c.replace(/\s+/gu, '');
    if (token.length === 0) continue;
    if (text.includes(token)) return c;
    const grams = new Set<string>();
    for (let i = 0; i + 2 <= token.length; i += 1) {
      const g = token.slice(i, i + 2);
      if (/^[\p{Script=Han}]{2}$/u.test(g)) grams.add(g);
    }
    const words = token.match(/[A-Za-z0-9]{3,}/g) ?? [];
    for (const w of words) grams.add(w.toLowerCase());
    for (const g of grams) {
      if (text.includes(g)) return c;
    }
  }
  return null;
}

function normalizeForCompare(s: string): string {
  return s.replace(/[\s，。、；：！？""''（）()《》【】\-—…]/gu, '');
}

function bigrams(s: string): Set<string> {
  const t = normalizeForCompare(s);
  const out = new Set<string>();
  if (t.length <= 1) {
    if (t) out.add(t);
    return out;
  }
  for (let i = 0; i + 2 <= t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** 与上一轮作者已决定的规则是否讲的是同一件事（只提示差异，绝不覆盖作者决定）。 */
export function findPreviousConflicts(
  statement: string,
  previous: { id: string; statement: string; decision: RuleDecision }[],
): { ruleId: string; statement: string; decision: RuleDecision }[] {
  const a = bigrams(statement);
  if (a.size === 0) return [];
  const out: { ruleId: string; statement: string; decision: RuleDecision }[] = [];
  for (const p of previous) {
    const b = bigrams(p.statement);
    if (b.size === 0) continue;
    let inter = 0;
    for (const g of a) if (b.has(g)) inter += 1;
    const jaccard = inter / (a.size + b.size - inter);
    if (jaccard >= 0.5) out.push({ ruleId: p.id, statement: p.statement, decision: p.decision });
  }
  return out;
}

export interface BuildCandidatesInput {
  rawRules: ModelRule[];
  samples: DistillContextSample[];
  previousRules: { id: string; statement: string; decision: RuleDecision }[];
}

export interface BuildCandidatesResult {
  candidates: DistillCandidate[];
  rejected: RejectedObservation[];
}

/**
 * 模型给的候选规则 → 项目候选规则（程序说了算的部分）。
 * - 引用必须命中已经过校验的证据，否则拒绝；
 * - 同篇切分出来的片段只算一份证据；
 * - 通用习惯要有至少两篇非重复样本，否则降级为初步观察；
 * - 语句与题目强制要求重合、或支持样本全部没有约束信息时，降级为“特定场景”并写明局限。
 */
export function buildCandidates(input: BuildCandidatesInput): BuildCandidatesResult {
  const verified = collectVerifiedEvidenceKeys(input.samples);
  const bySample = new Map(input.samples.map((s) => [s.sampleId, s]));
  const candidates: DistillCandidate[] = [];
  const rejected: RejectedObservation[] = [];

  input.rawRules.slice(0, MAX_CANDIDATE_RULES).forEach((raw, index) => {
    const resolvedEvidence: Evidence[] = [];
    for (const e of raw.evidence) {
      const candidatesForQuote = input.samples.filter((s) => {
        const para = s.analysis.observations
          .flatMap((o) => o.evidence)
          .find((x) => x.paragraphId === e.paragraphId && x.quote === e.quote);
        if (!para) return false;
        if (e.sampleId && e.sampleId !== s.sampleId) return false;
        return true;
      });
      if (candidatesForQuote.length === 0) {
        rejected.push({ reason: `引用不在已通过校验的分析中（段落 ${e.paragraphId}）`, raw: e });
        continue;
      }
      if (candidatesForQuote.length > 1 && !e.sampleId) {
        rejected.push({ reason: `引用在多个样本中都能找到，模型未给 sampleId，无法定位（段落 ${e.paragraphId}）`, raw: e });
        continue;
      }
      const host = candidatesForQuote[0];
      const ev: Evidence = {
        sampleId: host.sampleId,
        sampleRevision: host.revision,
        paragraphId: e.paragraphId,
        quote: e.quote,
      };
      if (!verified.has(evidenceKey(ev))) {
        rejected.push({ reason: `引用未通过服务端校验（样本 ${host.sampleId} 段落 ${e.paragraphId}）`, raw: e });
        continue;
      }
      resolvedEvidence.push(ev);
    }

    const counterEvidence: Evidence[] = [];
    for (const e of raw.counterEvidence ?? []) {
      const hit = input.samples.find((s) =>
        s.analysis.observations.some((o) => o.evidence.some((x) => x.paragraphId === e.paragraphId && x.quote === e.quote)),
      );
      if (hit) {
        counterEvidence.push({
          sampleId: hit.sampleId,
          sampleRevision: hit.revision,
          paragraphId: e.paragraphId,
          quote: e.quote,
        });
      }
    }

    if (raw.origin !== 'preference' && resolvedEvidence.length === 0) {
      rejected.push({ reason: '这条候选规则没有任何经校验的原文依据，已拒绝', raw });
      return;
    }

    const supportSamples: DistillContextSample[] = [];
    const seenHosts = new Set<string>();
    let unknownConstraintSupport = 0;
    const overlapNotes: string[] = [];
    for (const ev of resolvedEvidence) {
      const host = bySample.get(ev.sampleId);
      if (!host || seenHosts.has(host.sampleId)) continue;
      seenHosts.add(host.sampleId);
      supportSamples.push(host);
      if (!host.constraintKnown && !host.backgroundContext) unknownConstraintSupport += 1;
      const overlap = constraintOverlap(raw.statement, host.taskConstraints);
      if (overlap) overlapNotes.push(`与题目/框架要求“${overlap}”重合（样本 ${host.sampleId.slice(0, 6)}）`);
    }
    const docs = countSupports(supportSamples);
    const limitations = [...(raw.limitations ?? [])];
    let scope: RuleScope = raw.scope;

    const forcedOnly =
      supportSamples.length > 0 &&
      supportSamples.every((s) => {
        const obs = s.analysis.observations.filter((o) =>
          resolvedEvidence.some((e) => e.sampleId === s.sampleId && o.evidence.some((x) => x.paragraphId === e.paragraphId && x.quote === e.quote)),
        );
        return obs.length > 0 && obs.every((o) => o.constraintInfluence === 'forced_by_task');
      });

    if (docs < MIN_GENERAL_SUPPORT && scope === 'general') {
      scope = 'preliminary';
      limitations.push(`只有 ${docs} 篇非重复样本支持，先按初步观察处理（工程门槛：通用习惯需要至少 ${MIN_GENERAL_SUPPORT} 篇）`);
    }
    if (overlapNotes.length > 0 && scope !== 'preliminary') {
      scope = 'scenario_specific';
      limitations.push(`该说法与题目/框架的强制要求重合，不能当作作者的通用习惯：${overlapNotes[0]}`);
    }
    if (forcedOnly && scope === 'general') {
      scope = 'scenario_specific';
      limitations.push('支持它的观察全部被判定为“题目强制”，因此只在同类框架下成立');
    }
    if (unknownConstraintSupport > 0) {
      if (unknownConstraintSupport >= docs && scope === 'general') {
        scope = 'scenario_specific';
        limitations.push('支持它的样本都没有题目/体裁约束信息（多为直接丢入的成稿），无法区分是作者习惯还是文本体裁的要求');
      } else {
        limitations.push(`${unknownConstraintSupport} 条支持的样本没有约束信息，结论强度相应降低`);
      }
    }
    if (counterEvidence.length > 0) {
      limitations.push(`另有 ${counterEvidence.length} 处文本与该说法不完全一致，已作为反例保留`);
    }

    const scenes = Array.from(new Set(supportSamples.flatMap((s) => s.sceneTags)));
    const supportDescription =
      `由 ${docs} 篇非重复样本支持（${supportSamples.map((s) => s.sampleId.slice(0, 6)).join('、') || '无'}）` +
      `，共 ${resolvedEvidence.length} 条原文依据` +
      (scenes.length ? `；涉及场景：${scenes.join('、')}` : '；未标注场景');

    candidates.push({
      candidateIndex: index,
      statement: raw.statement.trim(),
      scope,
      origin: raw.origin ?? 'observed',
      evidence: resolvedEvidence,
      counterEvidence,
      supportDescription,
      limitations: Array.from(new Set(limitations)),
      constraintInfluence: raw.constraintInfluence ?? (forcedOnly ? 'forced_by_task' : 'unknown'),
      conflictsWithPrevious: findPreviousConflicts(raw.statement, input.previousRules),
    });
  });

  candidates.sort((a, b) => b.evidence.length - a.evidence.length);
  return { candidates: candidates.slice(0, MAX_CANDIDATE_RULES), rejected };
}

/** 能进正式 Skill 的规则：作者接受 + 未失效 + 非 Mock。 */
export function selectExportableRules(rules: StyleRule[]): StyleRule[] {
  return rules.filter((r) => r.decision === 'accepted' && !r.stale && !r.mock);
}

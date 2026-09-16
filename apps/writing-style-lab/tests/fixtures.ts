/**
 * 测试夹具：构造合法的 Sample / SampleAnalysis / StyleRule。
 * 只服务于测试，不参与应用运行。
 */
import { computeTextStats, contentHash, splitParagraphs } from '../src/shared/text';
import type {
  Observation,
  PreferenceMark,
  Sample,
  SampleAnalysis,
  StyleRule,
  WritingTask,
} from '../src/shared/schema';
import type { DistillContextSample } from '../src/shared/rules';

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

export async function makeSample(input: Partial<Sample> & { text: string }): Promise<Sample> {
  const now = new Date().toISOString();
  const paragraphs = splitParagraphs(input.text);
  const hash = await contentHash(input.text);
  return {
    id: input.id ?? nextId('s'),
    revision: input.revision ?? 1,
    entryMode: input.entryMode ?? 'task',
    taskId: input.taskId ?? null,
    taskVersion: input.taskVersion ?? null,
    taskConstraintsHash: input.taskConstraintsHash ?? null,
    sourceDocumentId: input.sourceDocumentId ?? null,
    fragment: input.fragment ?? null,
    sourceType: input.sourceType ?? 'self_current',
    text: input.text,
    contentHash: input.contentHash ?? hash,
    paragraphs: input.paragraphs ?? paragraphs,
    sceneTags: input.sceneTags ?? ['测试场景'],
    useForAnalysis: input.useForAnalysis ?? true,
    holdout: input.holdout ?? false,
    partial: input.partial ?? false,
    partialNote: input.partialNote ?? null,
    backgroundContext: input.backgroundContext ?? null,
    authorNote: input.authorNote ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

export function makeObservation(sample: Sample, paragraphIndex: number, quote: string, over: Partial<Observation> = {}): Observation {
  const paragraph = sample.paragraphs[paragraphIndex - 1];
  if (!paragraph) throw new Error(`样本只有 ${sample.paragraphs.length} 段，取不到第 ${paragraphIndex} 段`);
  return {
    id: over.id ?? nextId('o'),
    dimension: over.dimension ?? 'rhythm',
    claim: over.claim ?? '句子偏短，停顿密',
    scope: over.scope ?? 'sample_only',
    evidence:
      over.evidence ??
      [{ sampleId: sample.id, sampleRevision: sample.revision, paragraphId: paragraph.id, quote }],
    constraintInfluence: over.constraintInfluence ?? 'author_choice',
    limitations: over.limitations ?? [],
  };
}

export function makeAnalysis(sample: Sample, observations: Observation[], over: Partial<SampleAnalysis> = {}): SampleAnalysis {
  return {
    id: over.id ?? nextId('an'),
    sampleId: sample.id,
    sampleRevision: sample.revision,
    contentHash: sample.contentHash,
    taskConstraintsHash: sample.taskConstraintsHash,
    model: 'deepseek-flash',
    promptVersion: 'wsl-p1',
    temperature: 0.2,
    maxTokens: 4096,
    stats: computeTextStats(sample.text, sample.paragraphs),
    observations,
    rejectedObservations: [],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    status: observations.length > 0 ? 'ok' : 'rejected',
    errorCode: null,
    errorMessage: null,
    elapsedMs: 120,
    mock: false,
    runId: 'run_test',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

export function ctxSample(
  sample: Sample,
  analysis: SampleAnalysis,
  over: Partial<DistillContextSample> = {},
): DistillContextSample {
  return {
    sampleId: sample.id,
    revision: sample.revision,
    contentHash: sample.contentHash,
    sourceDocumentId: sample.sourceDocumentId,
    sceneTags: sample.sceneTags,
    constraintKnown: over.constraintKnown ?? sample.entryMode === 'task',
    taskConstraints: over.taskConstraints ?? [],
    backgroundContext: sample.backgroundContext,
    holdout: sample.holdout,
    useForAnalysis: sample.useForAnalysis,
    sourceType: sample.sourceType,
    analysis,
    ...over,
  };
}

export function makeRule(over: Partial<StyleRule> & { statement: string }): StyleRule {
  const now = new Date().toISOString();
  return {
    id: over.id ?? nextId('r'),
    statement: over.statement,
    scope: over.scope ?? 'general',
    origin: over.origin ?? 'observed',
    evidence: over.evidence ?? [],
    counterEvidence: over.counterEvidence ?? [],
    supportDescription: over.supportDescription ?? '由 2 篇非重复样本支持',
    limitations: over.limitations ?? [],
    constraintInfluence: over.constraintInfluence ?? 'author_choice',
    decision: over.decision ?? 'pending',
    statementOriginal: over.statementOriginal ?? null,
    userEditReason: over.userEditReason ?? null,
    decidedAt: over.decidedAt ?? null,
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    derivedFrom: over.derivedFrom ?? { model: 'deepseek-flash', promptVersion: 'wsl-p1', runId: 'run_test', candidateIndex: 0 },
    stale: over.stale ?? false,
    staleReason: over.staleReason ?? null,
    mock: over.mock ?? false,
  };
}

export function makePreference(over: Partial<PreferenceMark> & { sampleId: string }): PreferenceMark {
  return {
    id: over.id ?? nextId('pref'),
    sampleId: over.sampleId,
    sampleRevision: over.sampleRevision ?? 1,
    paragraphId: over.paragraphId ?? 'p1',
    quote: over.quote ?? '',
    kind: over.kind ?? 'keep',
    note: over.note ?? null,
    createdAt: over.createdAt ?? new Date().toISOString(),
  };
}

export function makeTask(over: Partial<WritingTask> = {}): WritingTask {
  const now = new Date().toISOString();
  return {
    id: over.id ?? nextId('t'),
    version: over.version ?? 1,
    title: over.title ?? '测试任务',
    prompt: over.prompt ?? '写一段熟悉的场景',
    constraints: over.constraints ?? [],
    targetMinChars: over.targetMinChars ?? 300,
    targetMaxChars: over.targetMaxChars ?? 600,
    sceneTags: over.sceneTags ?? ['测试场景'],
    builtIn: over.builtIn ?? false,
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
  };
}

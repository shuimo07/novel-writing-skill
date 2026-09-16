/**
 * 实体、模型输出与接口协议的唯一 schema 来源。
 * 客户端输入、备份导入、模型返回都要过这里的 Zod 校验；不通过就拒绝，不猜、不修补。
 */
import { z } from 'zod';
import { PROMPT_VERSION, SCHEMA_VERSION } from './limits';

/* ------------------------------------------------------------------ 枚举 */

export const SourceTypeSchema = z.enum([
  'self_current', // 本人本次写作
  'self_old', // 本人旧文
  'ai_generated', // AI 生成
  'mixed', // 人机混合
  'unconfirmed', // 未确认来源
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  self_current: '本人本次写作',
  self_old: '本人旧文',
  ai_generated: 'AI 生成',
  mixed: '人机混合',
  unconfirmed: '未确认来源',
};

/** 默认只有前两类可被选入作者样本集。 */
export const ELIGIBLE_SOURCE_TYPES: SourceType[] = ['self_current', 'self_old'];

export const EntryModeSchema = z.enum(['task', 'direct']);
export type EntryMode = z.infer<typeof EntryModeSchema>;

export const ObservationDimensionSchema = z.enum([
  'narrative_perspective',
  'rhythm',
  'diction_imagery',
  'dialogue',
  'emotion',
  'detail',
  'transition',
  'ending',
  'other',
]);
export type ObservationDimension = z.infer<typeof ObservationDimensionSchema>;

export const DIMENSION_LABEL: Record<ObservationDimension, string> = {
  narrative_perspective: '叙述视角',
  rhythm: '句段节奏',
  diction_imagery: '用词意象',
  dialogue: '对话',
  emotion: '情绪表达',
  detail: '细节',
  transition: '转场',
  ending: '收束',
  other: '其他',
};

export const ConstraintInfluenceSchema = z.enum([
  'author_choice', // 像是作者自己的选择
  'forced_by_task', // 题目/框架强制
  'persona_voice', // 人物口吻
  'genre_vocabulary', // 题材词汇
  'unknown', // 约束未知（直接采样无题目时必须是这个）
]);
export type ConstraintInfluence = z.infer<typeof ConstraintInfluenceSchema>;

export const CONSTRAINT_INFLUENCE_LABEL: Record<ConstraintInfluence, string> = {
  author_choice: '作者选择',
  forced_by_task: '题目强制',
  persona_voice: '人物口吻',
  genre_vocabulary: '题材词汇',
  unknown: '未知',
};

export const ObservationScopeSchema = z.enum(['sample_only', 'scenario', 'cross_sample']);

export const RuleScopeSchema = z.enum(['general', 'scenario_specific', 'preliminary']);
export type RuleScope = z.infer<typeof RuleScopeSchema>;
export const RULE_SCOPE_LABEL: Record<RuleScope, string> = {
  general: '通用习惯',
  scenario_specific: '特定场景',
  preliminary: '初步观察',
};

export const RuleOriginSchema = z.enum(['observed', 'preference']);
export const RuleDecisionSchema = z.enum(['pending', 'accepted', 'rejected']);
export type RuleDecision = z.infer<typeof RuleDecisionSchema>;

export const AnalysisStatusSchema = z.enum(['ok', 'partial', 'rejected']);

export const ErrorCodeSchema = z.enum([
  'CONFIG_MISSING_KEY',
  'MOCK_DISABLED',
  'INVALID_JSON',
  'SCHEMA_MISMATCH',
  'EMPTY_RESPONSE',
  'TRUNCATED',
  'EVIDENCE_INVALID',
  'STALE_SAMPLE',
  'LENGTH_LIMIT',
  'DUPLICATE_TASK',
  'QUOTA_EXCEEDED',
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_AUTH',
  'NOT_ALLOWED_ORIGIN',
  'BAD_CONTENT_TYPE',
  'BAD_REQUEST',
  'NOT_FOUND',
  'EXPORT_BLOCKED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/* ------------------------------------------------------------------ 基础 */

export const ParagraphSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
});

export const TextStatsSchema = z.object({
  chars: z.number().int().nonnegative(),
  codePoints: z.number().int().nonnegative(),
  paragraphs: z.number().int().nonnegative(),
  sentences: z.number().int().nonnegative(),
  longestSentenceChars: z.number().int().nonnegative(),
  avgSentenceChars: z.number().nonnegative(),
  dialogueParagraphs: z.number().int().nonnegative(),
  dialogueCharRatio: z.number().nonnegative(),
  avgParagraphChars: z.number().nonnegative(),
});

export const TopItemSchema = z.object({
  key: z.string(),
  count: z.number().int().nonnegative(),
});

/**
 * 本地风格学统计（确定性、归一化、可复现）。
 * 口径说明见 src/shared/stylometry.ts 顶部注释：不假装是精确语言学测量。
 */
export const StylometrySchema = z.object({
  sentenceCount: z.number().int().nonnegative(),
  sentenceMeanChars: z.number().nonnegative(),
  sentenceMedianChars: z.number().nonnegative(),
  sentenceStdDev: z.number().nonnegative(),
  sentenceMinChars: z.number().int().nonnegative(),
  sentenceMaxChars: z.number().int().nonnegative(),
  shortSentenceRatio: z.number().nonnegative(),
  longSentenceRatio: z.number().nonnegative(),
  sentenceLengthCV: z.number().nonnegative(),
  paragraphCount: z.number().int().nonnegative(),
  paragraphMeanChars: z.number().nonnegative(),
  paragraphStdDev: z.number().nonnegative(),
  paragraphLengthCV: z.number().nonnegative(),
  punctuationPer100: z.record(z.number().nonnegative()),
  punctuationTotalPer100: z.number().nonnegative(),
  charTypes: z.number().int().nonnegative(),
  charTokens: z.number().int().nonnegative(),
  typeTokenRatio: z.number().nonnegative(),
  topChars: z.array(TopItemSchema),
  topBigrams: z.array(TopItemSchema),
  functionWordPer100: z.number().nonnegative(),
  pronounPer100: z.number().nonnegative(),
  pronounShare: z.object({
    first: z.number().nonnegative(),
    second: z.number().nonnegative(),
    third: z.number().nonnegative(),
  }),
  dialogueParagraphRatio: z.number().nonnegative(),
  quotedRatio: z.number().nonnegative(),
});

export const ReceiptFeaturesSchema = z.object({
  lineEnding: z.enum(['lf', 'crlf', 'cr', 'mixed', 'none']),
  hasBom: z.boolean(),
  hasZeroWidth: z.boolean(),
  hasTab: z.boolean(),
  codePoints: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
  utf16Length: z.number().int().nonnegative(),
});

export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const UNKNOWN_USAGE: Usage = { promptTokens: null, completionTokens: null, totalTokens: null };

/* ------------------------------------------------------------------ 实体 */

export const WritingTaskSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().min(1),
  /** 题目正文：主要限定人物、目标、事件和长度。 */
  prompt: z.string(),
  /** 框架约束：作者自己加的额外要求，例如“全用短句”。分析时必须识别其影响。 */
  constraints: z.array(z.string()),
  targetMinChars: z.number().int().positive(),
  targetMaxChars: z.number().int().positive(),
  sceneTags: z.array(z.string()),
  builtIn: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WritingTask = z.infer<typeof WritingTaskSchema>;

export const SourceDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  importMethod: z.enum(['paste', 'file', 'task']),
  sourceFileName: z.string().nullable(),
  /** 原样正文：程序不做任何规范化，逐字保存。 */
  text: z.string(),
  contentHash: z.string().min(1),
  receipt: ReceiptFeaturesSchema,
  declaredSourceType: SourceTypeSchema,
  backgroundContext: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const SampleFragmentInfoSchema = z.object({
  fragmentIndex: z.number().int().positive(),
  fragmentCount: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  splitInsideParagraph: z.boolean(),
});

export const SampleSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  entryMode: EntryModeSchema,
  taskId: z.string().nullable(),
  taskVersion: z.number().int().positive().nullable(),
  taskConstraintsHash: z.string().nullable(),
  sourceDocumentId: z.string().nullable(),
  fragment: SampleFragmentInfoSchema.nullable(),
  sourceType: SourceTypeSchema,
  /** 该 revision 的正文快照（只读；改字＝新 revision）。 */
  text: z.string(),
  contentHash: z.string().min(1),
  paragraphs: z.array(ParagraphSchema),
  sceneTags: z.array(z.string()),
  /** 是否入选本轮提炼。 */
  useForAnalysis: z.boolean(),
  /** 保留样本：不发送到本轮提炼，供作者事后人工对照规则。 */
  holdout: z.boolean(),
  /** 部分样本：只有前 X 字参与分析。 */
  partial: z.boolean(),
  partialNote: z.string().nullable(),
  backgroundContext: z.string().nullable(),
  authorNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Sample = z.infer<typeof SampleSchema>;

export const EvidenceSchema = z.object({
  sampleId: z.string().min(1),
  sampleRevision: z.number().int().positive(),
  paragraphId: z.string().min(1),
  quote: z.string().min(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ObservationSchema = z.object({
  id: z.string().min(1),
  dimension: ObservationDimensionSchema,
  claim: z.string().min(1),
  scope: ObservationScopeSchema,
  evidence: z.array(EvidenceSchema),
  constraintInfluence: ConstraintInfluenceSchema,
  limitations: z.array(z.string()),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const RejectedObservationSchema = z.object({
  reason: z.string(),
  raw: z.unknown(),
});

export const SampleAnalysisSchema = z.object({
  id: z.string().min(1),
  sampleId: z.string().min(1),
  sampleRevision: z.number().int().positive(),
  contentHash: z.string().min(1),
  taskConstraintsHash: z.string().nullable(),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  temperature: z.number(),
  maxTokens: z.number().int().positive(),
  stats: TextStatsSchema,
  /** 本地算出的风格学统计；用于给作者看数字，也用于交叉核对模型的说法。 */
  stylometry: StylometrySchema.nullable().optional(),
  observations: z.array(ObservationSchema),
  rejectedObservations: z.array(RejectedObservationSchema),
  usage: UsageSchema,
  /** 本分析实际调用上游的次数（含重试）。任务书要求保存调用次数；旧数据可能没有该字段。 */
  attempts: z.number().int().nonnegative().optional(),
  status: AnalysisStatusSchema,
  errorCode: ErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  elapsedMs: z.number().int().nonnegative(),
  /** Mock 结果不能导出为正式作者 Skill。 */
  mock: z.boolean(),
  runId: z.string().nullable(),
  createdAt: z.string(),
});
export type SampleAnalysis = z.infer<typeof SampleAnalysisSchema>;

export const RuleDerivationSchema = z.object({
  model: z.string(),
  promptVersion: z.string(),
  runId: z.string().nullable(),
  candidateIndex: z.number().int().nonnegative(),
});

export const StyleRuleSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  scope: RuleScopeSchema,
  origin: RuleOriginSchema,
  evidence: z.array(EvidenceSchema),
  counterEvidence: z.array(EvidenceSchema),
  supportDescription: z.string(),
  limitations: z.array(z.string()),
  constraintInfluence: ConstraintInfluenceSchema,
  decision: RuleDecisionSchema,
  /** 作者改过的说法；原始说法保留在 statementOriginal，不伪造支持它的证据。 */
  statementOriginal: z.string().nullable(),
  userEditReason: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  derivedFrom: RuleDerivationSchema,
  /** 证据/版本失效时为 true，必须重新确认后才能进入导出。 */
  stale: z.boolean(),
  staleReason: z.string().nullable(),
  mock: z.boolean(),
});
export type StyleRule = z.infer<typeof StyleRuleSchema>;

export const ProfileSampleRefSchema = z.object({
  sampleId: z.string().min(1),
  revision: z.number().int().positive(),
  contentHash: z.string().min(1),
  sceneTags: z.array(z.string()),
  entryMode: EntryModeSchema,
  sourceType: SourceTypeSchema,
  chars: z.number().int().nonnegative(),
  fragmentIndex: z.number().int().positive().nullable(),
});

export const StyleProfileSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  model: z.string(),
  promptVersion: z.string(),
  sampleSnapshot: z.array(ProfileSampleRefSchema),
  rules: z.array(StyleRuleSchema),
  coveredScenes: z.array(z.string()),
  limitations: z.array(z.string()),
  mock: z.boolean(),
  createdAt: z.string(),
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

export const TryoutOutputSchema = z.object({
  text: z.string(),
  chars: z.number().int().nonnegative(),
  usage: UsageSchema,
  finishReason: z.string().nullable(),
});

export const EvaluationSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  skillProfileId: z.string().nullable(),
  skillVersion: z.number().int().nullable(),
  base: TryoutOutputSchema,
  withSkill: TryoutOutputSchema,
  /** 评价前隐藏条件；评价后才允许揭示。 */
  abOrder: z.object({ A: z.enum(['base', 'skill']), B: z.enum(['base', 'skill']) }),
  revealed: z.boolean(),
  feedback: z
    .object({
      closer: z.enum(['A', 'B', 'both', 'neither', 'similar']),
      tone: z.enum(['A', 'B', 'both', 'neither', 'similar']).nullable(),
      rhythm: z.enum(['A', 'B', 'both', 'neither', 'similar']).nullable(),
      detail: z.enum(['A', 'B', 'both', 'neither', 'similar']).nullable(),
      reason: z.string(),
    })
    .nullable(),
  model: z.string(),
  params: z.object({ temperature: z.number(), maxTokens: z.number().int().positive() }),
  usage: UsageSchema,
  elapsedMs: z.number().int().nonnegative(),
  mock: z.boolean(),
  createdAt: z.string(),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export const PreferenceMarkSchema = z.object({
  id: z.string().min(1),
  sampleId: z.string().min(1),
  sampleRevision: z.number().int().positive(),
  paragraphId: z.string().min(1),
  quote: z.string(),
  kind: z.enum(['keep', 'avoid']),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type PreferenceMark = z.infer<typeof PreferenceMarkSchema>;

/* ------------------------------------------------------- 模型输出（角色 1/2） */

export const ModelEvidenceSchema = z.object({
  /** 角色 1（单篇）不需要；角色 2（多篇）必须给，否则服务端按 quote+paragraphId 唯一匹配，匹配不上就拒绝。 */
  sampleId: z.string().min(1).optional(),
  paragraphId: z.string().min(1),
  quote: z.string().min(1),
});

export const ModelObservationSchema = z.object({
  dimension: ObservationDimensionSchema,
  claim: z.string().min(1),
  scope: ObservationScopeSchema.optional(),
  evidence: z.array(ModelEvidenceSchema).min(1),
  constraintInfluence: ConstraintInfluenceSchema.optional(),
  limitations: z.array(z.string()).optional(),
});

export const SampleAnalysisOutputSchema = z.object({
  observations: z.array(ModelObservationSchema).max(20),
});
export type SampleAnalysisOutput = z.infer<typeof SampleAnalysisOutputSchema>;

export const ModelRuleSchema = z.object({
  statement: z.string().min(1),
  scope: RuleScopeSchema,
  origin: RuleOriginSchema.default('observed'),
  evidence: z.array(ModelEvidenceSchema).default([]),
  counterEvidence: z.array(ModelEvidenceSchema).default([]),
  supportDescription: z.string().default(''),
  limitations: z.array(z.string()).default([]),
  constraintInfluence: ConstraintInfluenceSchema.optional(),
});

export const DistillOutputSchema = z.object({
  candidates: z.array(ModelRuleSchema).max(20),
});
export type DistillOutput = z.infer<typeof DistillOutputSchema>;

/* --------------------------------------------------------------- 接口协议 */

export const StatusResponseSchema = z.object({
  ok: z.literal(true),
  apiKeyConfigured: z.boolean(),
  mockEnabled: z.boolean(),
  model: z.string(),
  promptVersion: z.string(),
  limits: z.object({
    maxCharsPerSample: z.number().int().positive(),
    maxSamplesPerBatch: z.number().int().positive(),
    maxTotalCharsPerBatch: z.number().int().positive(),
    maxExtraRetriesPerBatch: z.number().int().nonnegative(),
    targetMinChars: z.number().int().positive(),
    targetMaxChars: z.number().int().positive(),
  }),
  /** 未配置价格时为 null，界面显示“未知”。 */
  priceNote: z.string().nullable(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export const AnalyzeSampleRequestSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().nullable(),
  sampleId: z.string().min(1),
  sampleRevision: z.number().int().positive(),
  contentHash: z.string().min(1),
  text: z.string().min(1),
  sourceType: SourceTypeSchema,
  sceneTags: z.array(z.string()).default([]),
  backgroundContext: z.string().nullable().default(null),
  taskConstraints: z.array(z.string()).default([]),
  taskConstraintsHash: z.string().nullable().default(null),
  /** 直接采样无题目时为 true，服务端据此要求模型把约束影响记为 unknown。 */
  constraintKnown: z.boolean(),
});
export type AnalyzeSampleRequest = z.infer<typeof AnalyzeSampleRequestSchema>;

export const AnalyzeSampleResponseSchema = z.object({
  ok: z.literal(true),
  analysis: SampleAnalysisSchema,
});
export type AnalyzeSampleResponse = z.infer<typeof AnalyzeSampleResponseSchema>;

export const DistillSampleInputSchema = z.object({
  sampleId: z.string().min(1),
  revision: z.number().int().positive(),
  contentHash: z.string().min(1),
  entryMode: EntryModeSchema,
  originDocumentId: z.string().nullable(),
  sourceType: SourceTypeSchema,
  sceneTags: z.array(z.string()),
  chars: z.number().int().nonnegative(),
  authorNote: z.string().nullable(),
  backgroundContext: z.string().nullable(),
  /** 正文开头一段（约 200 字），只用于归纳阶段判断样本是否近似重复；不传就按文稿计数。 */
  textSample: z.string().nullable().default(null),
  taskConstraints: z.array(z.string()),
  constraintKnown: z.boolean(),
  holdout: z.boolean(),
  partial: z.boolean(),
  analysis: SampleAnalysisSchema,
});

export const DistillPreferenceSchema = z.object({
  id: z.string().min(1),
  sampleId: z.string().min(1),
  paragraphId: z.string().min(1),
  kind: z.enum(['keep', 'avoid']),
  quote: z.string(),
  note: z.string().nullable(),
});

export const DistillRequestSchema = z.object({
  runId: z.string().min(1),
  samples: z.array(DistillSampleInputSchema).min(1),
  preferences: z.array(DistillPreferenceSchema).default([]),
  /** 上一轮作者已经改过/拒绝过的规则，用来提示差异，不覆盖作者决定。 */
  previousRules: z
    .array(
      z.object({
        id: z.string(),
        statement: z.string(),
        decision: RuleDecisionSchema,
      }),
    )
    .default([]),
});
export type DistillRequest = z.infer<typeof DistillRequestSchema>;

export const DistillCandidateSchema = z.object({
  candidateIndex: z.number().int().nonnegative(),
  statement: z.string(),
  scope: RuleScopeSchema,
  origin: RuleOriginSchema,
  evidence: z.array(EvidenceSchema),
  counterEvidence: z.array(EvidenceSchema),
  supportDescription: z.string(),
  limitations: z.array(z.string()),
  constraintInfluence: ConstraintInfluenceSchema,
  /** 与上一轮作者决定的差异提示。 */
  conflictsWithPrevious: z.array(z.object({ ruleId: z.string(), statement: z.string(), decision: RuleDecisionSchema })),
});

export const DistillResponseSchema = z.object({
  ok: z.literal(true),
  candidates: z.array(DistillCandidateSchema),
  rejectedCandidates: z.array(RejectedObservationSchema),
  usage: UsageSchema,
  model: z.string(),
  promptVersion: z.string(),
  mock: z.boolean(),
  elapsedMs: z.number().int().nonnegative(),
});
export type DistillResponse = z.infer<typeof DistillResponseSchema>;

export const TryoutRequestSchema = z.object({
  runId: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  skillMarkdown: z.string().max(60000).nullable().default(null),
  targetMinChars: z.number().int().positive().default(300),
  targetMaxChars: z.number().int().positive().default(500),
});
export type TryoutRequest = z.infer<typeof TryoutRequestSchema>;

export const TryoutResponseSchema = z.object({
  ok: z.literal(true),
  base: TryoutOutputSchema,
  withSkill: TryoutOutputSchema,
  model: z.string(),
  params: z.object({ temperature: z.number(), maxTokens: z.number().int().positive() }),
  elapsedMs: z.number().int().nonnegative(),
  mock: z.boolean(),
  usage: UsageSchema,
});
export type TryoutResponse = z.infer<typeof TryoutResponseSchema>;

export const ApiErrorSchema = z.object({
  ok: z.literal(false),
  errorCode: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* ------------------------------------------------------------------ 备份 */

export const BackupSchema = z.object({
  schemaVersion: z.number().int().positive(),
  app: z.literal('writing-style-lab'),
  exportedAt: z.string(),
  /** 备份可能含私人正文，界面与导出 Skill 区分。 */
  containsFullText: z.literal(true),
  tasks: z.array(WritingTaskSchema),
  sourceDocuments: z.array(SourceDocumentSchema),
  samples: z.array(SampleSchema),
  analyses: z.array(SampleAnalysisSchema),
  rules: z.array(StyleRuleSchema),
  profiles: z.array(StyleProfileSchema),
  evaluations: z.array(EvaluationSchema),
  preferences: z.array(PreferenceMarkSchema),
});
export type Backup = z.infer<typeof BackupSchema>;

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;
export const CURRENT_PROMPT_VERSION = PROMPT_VERSION;

/* ------------------------------------------------------------ 类型别名导出 */

export type Paragraph = z.infer<typeof ParagraphSchema>;
export type TextStats = z.infer<typeof TextStatsSchema>;
export type StylometryStats = z.infer<typeof StylometrySchema>;
export type TopItemStats = z.infer<typeof TopItemSchema>;
export type ReceiptFeatures = z.infer<typeof ReceiptFeaturesSchema>;
export type RejectedObservation = z.infer<typeof RejectedObservationSchema>;
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;
export type ModelEvidence = z.infer<typeof ModelEvidenceSchema>;
export type ModelObservation = z.infer<typeof ModelObservationSchema>;
export type ModelRule = z.infer<typeof ModelRuleSchema>;
export type DistillCandidate = z.infer<typeof DistillCandidateSchema>;
export type DistillSampleInput = z.infer<typeof DistillSampleInputSchema>;
export type DistillPreference = z.infer<typeof DistillPreferenceSchema>;
export type RuleDerivation = z.infer<typeof RuleDerivationSchema>;
export type SampleFragmentInfo = z.infer<typeof SampleFragmentInfoSchema>;
export type ProfileSampleRef = z.infer<typeof ProfileSampleRefSchema>;
export type TryoutOutput = z.infer<typeof TryoutOutputSchema>;
export type ImportConflictKind = CollectionNameForExport;

/** 备份集合名（供界面预览冲突用）。 */
export type CollectionNameForExport =
  | 'tasks'
  | 'sourceDocuments'
  | 'samples'
  | 'analyses'
  | 'rules'
  | 'profiles'
  | 'evaluations'
  | 'preferences';

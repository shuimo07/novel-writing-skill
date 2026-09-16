/**
 * Mock 自检数据（只有 ALLOW_MOCK_ANALYSIS=1 且请求里带 mock:true 时才会被用到）。
 *
 * 三条自我约束：
 * 1. **确定性**：同样的输入永远得到同样的输出，不用随机数、不读当前时间，便于对照与排查。
 * 2. **引用必须取自传入正文的原文**：quote 一律用 `paragraph.text` 的连续切片，
 *    这样才可能通过 shared/verify.ts 的 checkEvidence（逐字子串校验）；绝不改写、不拼接、不加省略号。
 * 3. **不伪造结论**：所有 claim/statement 都自报是占位文本，并写明不能作为正式文风结论，
 *    下游一律带 mock:true，导出正式 Skill 时会被 selectExportableRules 挡掉。
 */
import { DIMENSION_LABEL, type DistillRequest, type ModelRule, type ObservationDimension } from '../shared/schema';
import { countChars, type Paragraph, type TextStats } from '../shared/text';

/** 固定说明文案：出现在每一条 Mock 观察/规则的 limitations 里。 */
export const MOCK_NOTICE = 'Mock 结果：由本地占位数据生成，不是对文风的真实判断，禁止用于导出正式 Skill。';

/** Mock 观察使用的维度顺序（固定，保证确定性）。 */
const MOCK_DIMENSIONS: ObservationDimension[] = [
  'narrative_perspective',
  'rhythm',
  'diction_imagery',
  'dialogue',
  'emotion',
];

/** 单段引用长度上限（UTF-16 单元）：短到能一眼核对，长到足以支撑一条观察。 */
const QUOTE_MAX_UNITS = 24;

/**
 * 从段落原文里逐字截一段作为 quote。
 * 只做切分，不做任何清洗：一旦 trim / 替换标点，就不再是原文的连续子串，checkEvidence 会拒绝。
 */
function quoteFromParagraph(text: string): string {
  if (text.length === 0) return '';
  let end = Math.min(QUOTE_MAX_UNITS, text.length);
  // 不要在代理对中间切断（会得到孤立代理单元）。
  const code = text.charCodeAt(end - 1);
  if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
  if (end <= 0) end = Math.min(1, text.length);
  return text.slice(0, end);
}

export interface MockAnalyzeInput {
  sampleId: string;
  sampleRevision: number;
  paragraphs: Paragraph[];
  stats: TextStats;
  constraintKnown: boolean;
}

/**
 * 生成角色 1 的 Mock 输出（JSON 字符串，形状与 SampleAnalysisOutputSchema 一致）。
 * 返回值仍然要过 gateAnalysisOutput：Mock 只是跳过网络，不跳过验收。
 */
export function mockAnalyzeContent(input: MockAnalyzeInput): string {
  const usable = input.paragraphs.filter((p) => quoteFromParagraph(p.text).length > 0);
  const observations = MOCK_DIMENSIONS.map((dimension, i) => {
    const paragraph = usable[Math.min(i, usable.length - 1)];
    const quote = quoteFromParagraph(paragraph.text);
    return {
      dimension,
      claim: `（Mock 占位观察）维度「${DIMENSION_LABEL[dimension]}」：本条由本地占位数据生成，用于验证接口与引用校验链路；本篇共 ${input.stats.chars} 字（含标点）、${input.stats.paragraphs} 段、平均句长 ${input.stats.avgSentenceChars} 字。`,
      scope: 'sample_only' as const,
      evidence: [{ sampleId: input.sampleId, paragraphId: paragraph.id, quote }],
      // Mock 不判断约束归属：已知约束时也如实记 unknown，避免把体裁特征说成作者习惯。
      constraintInfluence: 'unknown' as const,
      limitations: [MOCK_NOTICE, input.constraintKnown ? 'Mock 不区分作者选择与题目强制。' : '本篇没有题目/约束信息，无法区分作者习惯与文本自身要求。'],
    };
  });
  return JSON.stringify({ observations });
}

/**
 * 生成角色 2 的 Mock 原始候选规则。
 * 引用一律从已通过校验的单篇分析里搬过来（原样复制 sampleId/paragraphId/quote），
 * 之后仍要过 buildCandidates 做服务端再校验与降级。
 */
export function mockDistillRawRules(samples: DistillRequest['samples']): ModelRule[] {
  const rules: ModelRule[] = [];
  for (const sample of samples) {
    const host = sample.analysis.observations.find((o) => o.evidence.length > 0);
    if (!host) continue;
    const evidence = host.evidence[0];
    rules.push({
      statement: `（Mock 占位候选）${DIMENSION_LABEL[host.dimension]}：本条为本地占位规则，仅用于验证归纳链路，不是对文风的真实归纳。`,
      // 单篇来源只能算初步观察；通用习惯的门槛交给 buildCandidates 判定，这里不抢先声明。
      scope: 'preliminary',
      origin: 'observed',
      evidence: [
        {
          sampleId: evidence.sampleId,
          paragraphId: evidence.paragraphId,
          quote: evidence.quote,
        },
      ],
      counterEvidence: [],
      supportDescription: `（Mock）来自样本 ${evidence.sampleId.slice(0, 6)} 的一条已通过校验的原文引用`,
      limitations: [MOCK_NOTICE, '只有一篇样本支持，按初步观察处理。'],
      constraintInfluence: 'unknown',
    });
  }
  return rules;
}

/* --------------------------------------------------------------- 试写 Mock */

const TRYOUT_SENTENCES = [
  '雨停在凌晨，屋檐还在滴水。',
  '她把灯关了一半，剩下那一半照在桌角。',
  '对面的人没有坐下，只是把伞靠在门边。',
  '“你来得比说好的早。”',
  '他没有回答，抬手把窗户推开一条缝。',
  '楼下的车过了一辆，又过了一辆。',
  '桌上的水痕慢慢扩开，像一句没说完的话。',
  '她忽然想起小时候在河边数过的石头，一共七块。',
  '“明天再谈。”',
  '门合上的声音很轻，轻得像谁在道歉。',
  '走廊尽头的灯闪了两下，然后彻底暗下去。',
  '他站在黑暗里，把外套的扣子一颗一颗扣好。',
];

/** 简单确定性哈希（djb2 变体）：只用来挑起始句，不用于任何安全用途。 */
function seedOf(text: string): number {
  let h = 5381;
  for (const ch of text) {
    h = (h * 33 + ch.codePointAt(0)!) % 2_147_483_647;
  }
  return h;
}

export interface MockTryoutInput {
  prompt: string;
  targetMinChars: number;
  targetMaxChars: number;
  withSkill: boolean;
}

/**
 * 试写 Mock：确定性生成一段占位中文文本，字数落在题目要求的区间内。
 * 开头明确标注 Mock 与版本，便于作者一眼看出这不是真实产出。
 */
export function mockTryoutText(input: MockTryoutInput): string {
  const min = Math.max(1, Math.floor(input.targetMinChars));
  const max = Math.max(min, Math.floor(input.targetMaxChars));
  let text = input.withSkill ? '（Mock 试写：加 Skill 版）' : '（Mock 试写：基础版）';
  let i = seedOf(`${input.prompt}|${input.withSkill ? 'skill' : 'base'}`) % TRYOUT_SENTENCES.length;
  // 到 min 为止；上限由长度护栏兜底（下面统一裁剪），保证不会无限增长。
  const hardStop = max + 200;
  while (countChars(text) < min && text.length < hardStop) {
    text += TRYOUT_SENTENCES[i % TRYOUT_SENTENCES.length];
    i += 1;
  }
  if (countChars(text) > max) {
    const codePoints = Array.from(text);
    let counted = 0;
    let cut = codePoints.length;
    for (let k = 0; k < codePoints.length; k += 1) {
      if (!/\s/u.test(codePoints[k])) counted += 1;
      if (counted > max) {
        cut = k;
        break;
      }
    }
    text = codePoints.slice(0, cut).join('');
  }
  return text;
}

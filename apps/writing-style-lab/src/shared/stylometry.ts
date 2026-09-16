/**
 * 本地风格学统计（确定性、归一化、可复现）。
 *
 * 借鉴（只借鉴方法与指标口径，不复制代码）：
 * - StyloMetrix（NASK，Python）：指标要「可解释 / 归一化 / 可复现」——所以这里一律给密度（每 100 字）
 *   与比值，不用绝对次数，且无随机因素。
 * - perfectly-replicate-writing-skills（MIT）的品味原则：「要具体不要空泛」——
 *   "平均句长 12 字、30% 的句子少于 8 字" 有用，"喜欢用短句" 没用。所以这里把句长分布真正算出来，
 *   并在 crossCheckClaims 里拿模型的说法跟实测值对照。
 * - text_para（汉语文本参数）：字频、用字数（去重）、平均/最长句长。中文不分词也能做，
 *   这里用「字种数 / 字次」和「高频二字组合」代替词频，避免引入分词依赖，也不假装是词频。
 *
 * 口径声明（界面与文档都要照此说明，不假装是精确语言学测量）：
 * - 句长：按终止标点 `。！？!?…`（可连续）断句，长度用「字数（含标点、码点、排除空白）」；
 * - 字次：正文里的汉字与字母数字，不含标点与空白；字种：去重后的字数；
 * - 标点密度：每 100 字（含标点）出现次数；
 * - 高频二字组合：从连续汉字串里取相邻二字，含常用词也含无意义组合，只作线索，不是词频。
 */
import { countChars, splitParagraphs, splitSentences, type Paragraph } from './text';

export interface TopItem {
  key: string;
  count: number;
}

export interface PronounShare {
  first: number;
  second: number;
  third: number;
}

export interface Stylometry {
  /** 句长（字数口径） */
  sentenceCount: number;
  sentenceMeanChars: number;
  sentenceMedianChars: number;
  sentenceStdDev: number;
  sentenceMinChars: number;
  sentenceMaxChars: number;
  /** ≤8 字的句子占比 */
  shortSentenceRatio: number;
  /** ≥30 字的句子占比 */
  longSentenceRatio: number;
  /** 句长变异系数 = 标准差 / 均值，节奏波动（越大越参差） */
  sentenceLengthCV: number;

  /** 段落节奏 */
  paragraphCount: number;
  paragraphMeanChars: number;
  paragraphStdDev: number;
  paragraphLengthCV: number;

  /** 标点指纹：每 100 字出现次数 */
  punctuationPer100: Record<string, number>;
  punctuationTotalPer100: number;

  /** 用字（去重）与字次，中文不需要分词 */
  charTypes: number;
  charTokens: number;
  typeTokenRatio: number;
  topChars: TopItem[];
  topBigrams: TopItem[];

  /** 功能字与代词密度（每 100 字） */
  functionWordPer100: number;
  pronounPer100: number;
  pronounShare: PronounShare;

  /** 对话相关 */
  dialogueParagraphRatio: number;
  quotedRatio: number;
}

const PUNCT_KEYS: { key: string; re: RegExp }[] = [
  { key: '逗号', re: /[，,]/gu },
  { key: '句号', re: /[。．.]/gu },
  { key: '问号', re: /[？?]/gu },
  { key: '感叹号', re: /[！!]/gu },
  { key: '省略号', re: /…|\.{3,}/gu },
  { key: '破折号', re: /—{1,}|--/gu },
  { key: '分号', re: /[；;]/gu },
  { key: '冒号', re: /[：:]/gu },
  { key: '顿号', re: /、/gu },
  { key: '引号', re: /[「」『』“”‘’"]/gu },
  { key: '括号', re: /[（）()]/gu },
];

/** 常见功能字（虚词），按字统计，密度用每 100 字。 */
const FUNCTION_CHARS = new Set(
  Array.from('的了着过是在有不没也就都还很太又能会要把被让给对从和与及或但如果因为所以虽然然而不过而且并且以及等呢吧啊嘛哦呀之其则于并且即使无论因此于是'),
);

const PRONOUN_RE = /(我们|你们|他们|她们|咱们|自己|大家|我|你|他|她|它)/gu;
const FIRST = new Set(['我', '我们', '咱们']);
const SECOND = new Set(['你', '你们']);
const THIRD = new Set(['他', '她', '它', '他们', '她们', '自己', '大家']);

const CJK_OR_ALNUM_RE = /[\p{Script=Han}A-Za-z0-9]/u;
const CJK_RUN_RE = /\p{Script=Han}+/gu;
const QUOTED_RE = /[「『“]([^」』”]*)[」』”]/gu;

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function density(count: number, totalChars: number): number {
  if (totalChars <= 0) return 0;
  return round((count / totalChars) * 100, 3);
}

export function computeStylometry(text: string, paragraphs?: Paragraph[], sentences?: string[]): Stylometry {
  const totalChars = countChars(text);
  const paras = paragraphs ?? splitParagraphs(text);
  const sents = sentences ?? splitSentences(text);
  const sentenceLens = sents.map((s) => countChars(s)).filter((n) => n > 0);
  const paragraphLens = paras.map((p) => countChars(p.text));

  const sMean = mean(sentenceLens);
  const sStd = stdDev(sentenceLens);

  const punctuationPer100: Record<string, number> = {};
  let punctTotal = 0;
  for (const { key, re } of PUNCT_KEYS) {
    re.lastIndex = 0;
    const count = (text.match(re) ?? []).length;
    punctuationPer100[key] = density(count, totalChars);
    punctTotal += count;
  }

  // 用字与字次：汉字与字母数字，不含标点与空白
  const charCounts = new Map<string, number>();
  let charTokens = 0;
  for (const ch of text) {
    if (CJK_OR_ALNUM_RE.test(ch)) {
      charTokens += 1;
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }
  }
  const topChars: TopItem[] = [...charCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 10);

  // 高频二字组合：只作线索，不是词频（中文不分词）
  const bigramCounts = new Map<string, number>();
  for (const run of text.match(CJK_RUN_RE) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      bigramCounts.set(gram, (bigramCounts.get(gram) ?? 0) + 1);
    }
  }
  const topBigrams: TopItem[] = [...bigramCounts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 10);

  let functionWordCount = 0;
  for (const ch of text) if (FUNCTION_CHARS.has(ch)) functionWordCount += 1;

  let pronounCount = 0;
  const share: PronounShare = { first: 0, second: 0, third: 0 };
  PRONOUN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRONOUN_RE.exec(text)) !== null) {
    pronounCount += 1;
    if (FIRST.has(m[1])) share.first += 1;
    else if (SECOND.has(m[1])) share.second += 1;
    else if (THIRD.has(m[1])) share.third += 1;
  }
  const pronounTotal = share.first + share.second + share.third;

  let quotedChars = 0;
  QUOTED_RE.lastIndex = 0;
  while ((m = QUOTED_RE.exec(text)) !== null) quotedChars += countChars(m[1]);

  const dialogueParagraphs = paras.filter((p) => /[「『][^」』]*[」』]|“[^”]*”/u.test(p.text)).length;

  return {
    sentenceCount: sentenceLens.length,
    sentenceMeanChars: round(sMean, 1),
    sentenceMedianChars: round(median(sentenceLens), 1),
    sentenceStdDev: round(sStd, 1),
    sentenceMinChars: sentenceLens.length ? Math.min(...sentenceLens) : 0,
    sentenceMaxChars: sentenceLens.length ? Math.max(...sentenceLens) : 0,
    shortSentenceRatio: sentenceLens.length ? round(sentenceLens.filter((n) => n <= 8).length / sentenceLens.length, 3) : 0,
    longSentenceRatio: sentenceLens.length ? round(sentenceLens.filter((n) => n >= 30).length / sentenceLens.length, 3) : 0,
    sentenceLengthCV: sMean > 0 ? round(sStd / sMean, 3) : 0,

    paragraphCount: paragraphLens.length,
    paragraphMeanChars: round(mean(paragraphLens), 1),
    paragraphStdDev: round(stdDev(paragraphLens), 1),
    paragraphLengthCV: mean(paragraphLens) > 0 ? round(stdDev(paragraphLens) / mean(paragraphLens), 3) : 0,

    punctuationPer100,
    punctuationTotalPer100: density(punctTotal, totalChars),

    charTypes: charCounts.size,
    charTokens,
    typeTokenRatio: charTokens > 0 ? round(charCounts.size / charTokens, 3) : 0,
    topChars,
    topBigrams,

    functionWordPer100: density(functionWordCount, totalChars),
    pronounPer100: density(pronounCount, totalChars),
    pronounShare: {
      first: pronounTotal ? round(share.first / pronounTotal, 3) : 0,
      second: pronounTotal ? round(share.second / pronounTotal, 3) : 0,
      third: pronounTotal ? round(share.third / pronounTotal, 3) : 0,
    },

    dialogueParagraphRatio: paras.length ? round(dialogueParagraphs / paras.length, 3) : 0,
    quotedRatio: totalChars ? round(quotedChars / totalChars, 3) : 0,
  };
}

/** 给界面/提示词用的可读摘要（一行一条，全部带数字）。 */
export function stylometryLines(s: Stylometry): string[] {
  const lines: string[] = [];
  lines.push(`句长：${s.sentenceCount} 句，平均 ${s.sentenceMeanChars} 字，中位 ${s.sentenceMedianChars} 字，标准差 ${s.sentenceStdDev}，变异系数 ${s.sentenceLengthCV}`);
  lines.push(`句长分布：≤8 字占 ${(s.shortSentenceRatio * 100).toFixed(1)}%，≥30 字占 ${(s.longSentenceRatio * 100).toFixed(1)}%，最短 ${s.sentenceMinChars} 字，最长 ${s.sentenceMaxChars} 字`);
  lines.push(`段落：${s.paragraphCount} 段，平均 ${s.paragraphMeanChars} 字，变异系数 ${s.paragraphLengthCV}`);
  const punct = Object.entries(s.punctuationPer100)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k} ${v}/100字`)
    .join('，');
  lines.push(`标点指纹：${punct || '无标点'}（合计 ${s.punctuationTotalPer100}/100字）`);
  lines.push(`用字：字种 ${s.charTypes}，字次 ${s.charTokens}，字种/字次 ${s.typeTokenRatio}`);
  if (s.topChars.length) lines.push(`高频字：${s.topChars.slice(0, 8).map((t) => `${t.key}(${t.count})`).join('、')}`);
  if (s.topBigrams.length) lines.push(`高频二字组合（仅线索，非词频）：${s.topBigrams.slice(0, 8).map((t) => `${t.key}(${t.count})`).join('、')}`);
  lines.push(`功能字密度 ${s.functionWordPer100}/100字；代词密度 ${s.pronounPer100}/100字；人称占比 第一${(s.pronounShare.first * 100).toFixed(0)}% / 第二${(s.pronounShare.second * 100).toFixed(0)}% / 第三${(s.pronounShare.third * 100).toFixed(0)}%`);
  lines.push(`对白段落占 ${(s.dialogueParagraphRatio * 100).toFixed(1)}%；引号内文字占 ${(s.quotedRatio * 100).toFixed(1)}%`);
  return lines;
}

/**
 * 拿模型的说法跟本地实测值对照，只做程序能确定性判断的几项。
 * 返回一句句可读的“不一致提示”；调用方把它并进该观察的 limitations —— **不删观察、不替作者下结论**。
 */
export function crossCheckClaims(
  claim: string,
  dimension: string,
  s: Stylometry,
): string[] {
  const notes: string[] = [];
  const text = claim.replace(/\s+/gu, '');
  const talksAboutLength = /短句|句短|句子短|简短|长句|句子长|句长|节奏|停顿|断裂/.test(text) || dimension === 'rhythm';

  if (talksAboutLength) {
    if (/短句|句短|句子短|简短/.test(text) && s.sentenceMeanChars > 20 && s.shortSentenceRatio < 0.25) {
      notes.push(
        `程序统计与这条说法不一致：本篇平均句长 ${s.sentenceMeanChars} 字，≤8 字的句子只占 ${(s.shortSentenceRatio * 100).toFixed(1)}%，请核对或改成带数字的说法`,
      );
    }
    if (/长句|句子长|绵长|长句多/.test(text) && s.sentenceMeanChars < 15) {
      notes.push(`程序统计与这条说法不一致：本篇平均句长只有 ${s.sentenceMeanChars} 字`);
    }
    if (/参差|波动|忽长忽短|长短交错/.test(text) && s.sentenceLengthCV < 0.35) {
      notes.push(`程序统计与这条说法不一致：句长变异系数 ${s.sentenceLengthCV}，句长其实相当整齐`);
    }
    if (/整齐|均匀|节奏一致|主要都是短句/.test(text) && s.sentenceLengthCV > 0.9) {
      notes.push(`程序统计与这条说法不一致：句长变异系数 ${s.sentenceLengthCV}，长短差异其实很大`);
    }
  }

  const punctClaims: { key: string; re: RegExp }[] = [
    { key: '感叹号', re: /感叹号|感叹/ },
    { key: '问号', re: /问号|设问|反问/ },
    { key: '省略号', re: /省略号|省略/ },
    { key: '破折号', re: /破折号|插入语/ },
    { key: '分号', re: /分号/ },
  ];
  for (const { key, re } of punctClaims) {
    if (re.test(text) && (s.punctuationPer100[key] ?? 0) === 0) {
      notes.push(`程序统计与这条说法不一致：本篇没有出现${key}`);
    }
  }

  if (/对白|对话|引号/.test(text) && s.quotedRatio === 0 && s.dialogueParagraphRatio === 0) {
    notes.push('程序统计与这条说法不一致：本篇没有引号内文字，也没有对白段落');
  }
  return notes;
}

/* ---------------------------------------------------- 近似重复样本的判定 */

/** 字符二字组 Jaccard 相似度（0—1）。用于判断两篇样本是不是“同一批文字”。 */
export function contentSimilarity(a: string, b: string, sampleLimit = 4000): number {
  const norm = (s: string) =>
    Array.from(s.slice(0, sampleLimit))
      .filter((ch) => CJK_OR_ALNUM_RE.test(ch))
      .join('');
  const x = norm(a);
  const y = norm(b);
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  // 长度差太大直接判不相似，省时间
  const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
  if (ratio < 0.5) return 0;
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= x.length; i += 1) grams.add(x.slice(i, i + 2));
  let inter = 0;
  const seen = new Set<string>();
  for (let i = 0; i + 2 <= y.length; i += 1) {
    const g = y.slice(i, i + 2);
    if (!grams.has(g) || seen.has(g)) continue;
    seen.add(g);
    inter += 1;
  }
  const union = grams.size + countBigrams(y) - inter;
  return union > 0 ? round(inter / union, 3) : 0;
}

function countBigrams(s: string): number {
  const set = new Set<string>();
  for (let i = 0; i + 2 <= s.length; i += 1) set.add(s.slice(i, i + 2));
  return set.size;
}

export const NEAR_DUPLICATE_THRESHOLD = 0.85;

/**
 * 多篇非重复样本的“独立支持”计数。
 * 同一篇文稿切出的片段算一份；近似重复（相似度 ≥ 0.85）也算一份 —— 否则把同一段文字
 * 复制两份就能凑出“两篇支持”。
 */
export function countIndependentSupports<T extends { text: string; sourceDocumentId?: string | null; id: string }>(
  samples: T[],
): number {
  const groups: { docKey: string; texts: string[] }[] = [];
  for (const s of samples) {
    const docKey = s.sourceDocumentId ?? s.id;
    const existing = groups.find((g) => g.docKey === docKey);
    if (existing) {
      existing.texts.push(s.text);
      continue;
    }
    const near = groups.find((g) => g.texts.some((t) => contentSimilarity(t, s.text) >= NEAR_DUPLICATE_THRESHOLD));
    if (near) {
      near.texts.push(s.text);
      continue;
    }
    groups.push({ docKey, texts: [s.text] });
  }
  return groups.length;
}

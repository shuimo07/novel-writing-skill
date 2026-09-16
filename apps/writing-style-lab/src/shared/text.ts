/**
 * 文本口径工具。
 *
 * 一条硬规则贯穿本文件：**绝不修改正文**。
 * 统计、段落切分、片段规划全部返回“派生数据 + 原始偏移”，原文一律原样保留。
 * 直接采样（把已经写好的文字丢进来）依赖这条规则：任何 trim / 换行归一化 / 全角半角转换，
 * 都会让引用校验（quote 必须是原文的连续子串）失效，也会违背“不能更改原文”。
 *
 * 两套单位，别混：
 * - 偏移量（start/end）单位是 **UTF-16 下标**，与 String.prototype.slice 一致；
 * - 字数（chars）单位是 **Unicode 码点，排除空白，包含标点**，即界面上的“字数（含标点）”。
 */

/** start/end 的计量单位。 */
export const OFFSET_UNIT = 'utf16-index';
/** 字数的计量单位。 */
export const COUNT_UNIT = 'unicode-code-point';

export interface Paragraph {
  /** 同一 revision 内稳定：p1、p2…… 模型必须引用这个 id。 */
  id: string;
  /** 1 起的序号。 */
  index: number;
  /** 原文 UTF-16 起始下标（含）。 */
  start: number;
  /** 原文 UTF-16 结束下标（不含）。 */
  end: number;
  /** 恒等于 text.slice(start, end)，逐字一致。 */
  text: string;
}

export const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/u;
const WHITESPACE_RE = /\s/u;
const PARAGRAPH_SEPARATOR_RE = /\r?\n[ \t\r]*\n+/g;
const TERMINAL_PUNCT_RE = /[。！？!?…]+/gu;

/** 码点数组。for..of 会按码点迭代，不会把扩展字符劈成两半。 */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** 字数（含标点）口径：按 Unicode 码点排除空白计数。界面与校验都用这个。 */
export function countChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!WHITESPACE_RE.test(ch)) n += 1;
  }
  return n;
}

/** 全部码点数（含空白），仅用于诊断展示。 */
export function countCodePoints(text: string): number {
  let n = 0;
  for (const _ch of text) n += 1;
  return n;
}

/**
 * UTF-16 长度。**不是**本项目的字数口径，只用于诊断，别拿它算字数。
 */
export function utf16Length(text: string): number {
  return text.length;
}

/**
 * 段落切分：以一个及以上空行（`\r?\n[ \t\r]*\n+`）作为分隔。
 * 段内单换行保留在段落文本里；纯空白段跳过，但偏移仍精确指向原文。
 */
export function splitParagraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  let index = 0;
  let cursor = 0;
  PARAGRAPH_SEPARATOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushGap = (start: number, end: number) => {
    if (end <= start) return;
    const slice = text.slice(start, end);
    if (slice.trim() === '') return;
    index += 1;
    out.push({ id: `p${index}`, index, start, end, text: slice });
  };
  while ((m = PARAGRAPH_SEPARATOR_RE.exec(text)) !== null) {
    pushGap(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  pushGap(cursor, text.length);
  return out;
}

export interface ReceiptFeatures {
  lineEnding: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
  hasBom: boolean;
  hasZeroWidth: boolean;
  hasTab: boolean;
  codePoints: number;
  chars: number;
  utf16Length: number;
}

/** 接收时的原样特征：用于说明“程序没有帮你规范化”。 */
export function receiptFeatures(text: string): ReceiptFeatures {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const loneCr = (text.match(/\r(?!\n)/g) ?? []).length;
  let lineEnding: ReceiptFeatures['lineEnding'] = 'none';
  const kinds = [crlf > 0, loneLf > 0, loneCr > 0].filter(Boolean).length;
  if (kinds === 0) lineEnding = 'none';
  else if (kinds > 1) lineEnding = 'mixed';
  else if (crlf > 0) lineEnding = 'crlf';
  else if (loneLf > 0) lineEnding = 'lf';
  else lineEnding = 'cr';
  return {
    lineEnding,
    hasBom: text.charCodeAt(0) === 0xfeff,
    hasZeroWidth: ZERO_WIDTH_RE.test(text),
    hasTab: text.includes('\t'),
    codePoints: countCodePoints(text),
    chars: countChars(text),
    utf16Length: text.length,
  };
}

export interface TextStats {
  /** 字数（含标点）：码点、排除空白。 */
  chars: number;
  /** 全部码点（含空白）。 */
  codePoints: number;
  paragraphs: number;
  /** 句数：口径见 countSentences。 */
  sentences: number;
  /** 单句最长字数（码点、排除空白）。 */
  longestSentenceChars: number;
  /** 平均句长（字数口径，保留 1 位小数）。 */
  avgSentenceChars: number;
  /** 含引号对白的段落数。 */
  dialogueParagraphs: number;
  /** 含引号对白的字数占比（0—1，保留 3 位小数）。 */
  dialogueCharRatio: number;
  /** 段均字数。 */
  avgParagraphChars: number;
}

/**
 * 句子切分口径（写进界面说明，不假装是精确语言学测量）：
 * 以终止标点 `。！？!?…`（可连续）为界断句；无终止标点的段落残余算 1 句；
 * 分号、逗号、破折号不断句；不处理引号内嵌套与省略号兼作停顿的情况。
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const p of splitParagraphs(text)) {
    TERMINAL_PUNCT_RE.lastIndex = 0;
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = TERMINAL_PUNCT_RE.exec(p.text)) !== null) {
      const end = m.index + m[0].length;
      const seg = p.text.slice(cursor, end);
      if (countChars(seg) > 0) out.push(seg);
      cursor = end;
    }
    const tail = p.text.slice(cursor);
    if (countChars(tail) > 0) out.push(tail);
  }
  return out;
}

export function countSentences(text: string): number {
  return splitSentences(text).length;
}

/** 对白段落口径：段落内出现成对引号「」或 “”。 */
export function isDialogueParagraph(paragraph: string): boolean {
  return /[「『][^」』]*[」』]/u.test(paragraph) || /“[^”]*”/u.test(paragraph);
}

export function computeTextStats(text: string, paragraphs?: Paragraph[]): TextStats {
  const paras = paragraphs ?? splitParagraphs(text);
  const sentences = splitSentences(text);
  const sentenceChars = sentences.map(countChars).filter((n) => n > 0);
  const total = countChars(text);
  const dialogueParagraphList = paras.filter((p) => isDialogueParagraph(p.text));
  const dialogueChars = dialogueParagraphList.reduce((acc, p) => acc + countChars(p.text), 0);
  const longest = sentenceChars.length ? Math.max(...sentenceChars) : 0;
  const avg = sentenceChars.length
    ? Math.round((sentenceChars.reduce((a, b) => a + b, 0) / sentenceChars.length) * 10) / 10
    : 0;
  return {
    chars: total,
    codePoints: countCodePoints(text),
    paragraphs: paras.length,
    sentences: sentenceChars.length,
    longestSentenceChars: longest,
    avgSentenceChars: avg,
    dialogueParagraphs: dialogueParagraphList.length,
    dialogueCharRatio: total > 0 ? Math.round((dialogueChars / total) * 1000) / 1000 : 0,
    avgParagraphChars: paras.length ? Math.round((total / paras.length) * 10) / 10 : 0,
  };
}

/** 正文内容摘要：对原文逐字取 SHA-256（UTF-8 字节），任何改动都会变。 */
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface SplitFragment {
  index: number;
  /** UTF-16 起始下标（含），片段之间首尾相接。 */
  start: number;
  /** UTF-16 结束下标（不含）。 */
  end: number;
  /** 该片段字数（含标点）。 */
  chars: number;
  /** 该片段跨越的段落序号。 */
  paragraphIndexes: number[];
  /** 是否在段落内部被切开（长段落降级处理，属于局限性，要在界面说明）。 */
  splitInsideParagraph: boolean;
}

export interface SplitPlan {
  /** 原文总字数（含标点）。 */
  totalChars: number;
  /** 片段上限。 */
  maxChars: number;
  needsSplit: boolean;
  /** true 表示存在段内硬切，必须向作者说明。 */
  hasInsideParagraphSplit: boolean;
  fragments: SplitFragment[];
}

/**
 * 超限长文的分区规划：**分区而不是裁剪**。
 * 片段首尾相接覆盖 [0, text.length)，逐字拼接后与原文完全一致（有测试断言）。
 * 优先按段落边界切；单段超过上限时降级到句末标点；仍超过则按码点硬切，并置位 splitInsideParagraph。
 */
export function planSplit(text: string, maxChars: number): SplitPlan {
  const limit = Math.max(1, Math.floor(maxChars));
  const paragraphs = splitParagraphs(text);
  const totalChars = countChars(text);
  if (totalChars <= limit) {
    return {
      totalChars,
      maxChars: limit,
      needsSplit: false,
      hasInsideParagraphSplit: false,
      fragments:
        text.length > 0
          ? [
              {
                index: 1,
                start: 0,
                end: text.length,
                chars: totalChars,
                paragraphIndexes: paragraphs.map((p) => p.index),
                splitInsideParagraph: false,
              },
            ]
          : [],
    };
  }

  type Piece = { start: number; end: number; paragraphIndexes: number[]; inside: boolean };
  const pieces: Piece[] = [];
  for (const p of paragraphs) {
    if (countChars(p.text) <= limit) {
      pieces.push({ start: p.start, end: p.end, paragraphIndexes: [p.index], inside: false });
      continue;
    }
    // 段落太长：先按句子切
    const sentences: { start: number; end: number }[] = [];
    TERMINAL_PUNCT_RE.lastIndex = 0;
    let cursor = p.start;
    let m: RegExpExecArray | null;
    while ((m = TERMINAL_PUNCT_RE.exec(text)) !== null) {
      if (m.index < p.start) continue;
      if (m.index >= p.end) break;
      const end = m.index + m[0].length;
      sentences.push({ start: cursor, end });
      cursor = end;
    }
    if (cursor < p.end) sentences.push({ start: cursor, end: p.end });
    for (const s of sentences) {
      if (countChars(text.slice(s.start, s.end)) <= limit) {
        pieces.push({ start: s.start, end: s.end, paragraphIndexes: [p.index], inside: false });
        continue;
      }
      // 单句仍超限：按码点硬切（保持连续，不删字）
      let from = s.start;
      while (from < s.end) {
        let to = from;
        let count = 0;
        for (const ch of text.slice(from, s.end)) {
          if (to >= s.end) break;
          const w = ch.length;
          if (count > 0 && count + 1 > limit) break;
          to += w;
          if (!WHITESPACE_RE.test(ch)) count += 1;
        }
        if (to <= from) to = Math.min(s.end, from + 1);
        pieces.push({ start: from, end: to, paragraphIndexes: [p.index], inside: true });
        from = to;
      }
    }
  }

  // 贪心装箱：片段之间用原文里的分隔符连接，保证拼接后与原文逐字一致。
  const fragments: SplitFragment[] = [];
  let current: (SplitFragment & { _inside: boolean }) | null = null;
  const ordered = pieces.sort((a, b) => a.start - b.start);
  for (let i = 0; i < ordered.length; i += 1) {
    const piece = ordered[i];
    const isFirst: boolean = fragments.length === 0 && current === null;
    if (current === null) {
      current = {
        index: fragments.length + 1,
        start: isFirst ? 0 : piece.start,
        end: piece.end,
        chars: countChars(text.slice(isFirst ? 0 : piece.start, piece.end)),
        paragraphIndexes: [...piece.paragraphIndexes],
        splitInsideParagraph: piece.inside,
        _inside: piece.inside,
      };
      continue;
    }
    const candidateEnd = piece.end;
    const candidateChars = countChars(text.slice(current.start, candidateEnd));
    if (candidateChars <= limit) {
      current.end = candidateEnd;
      current.chars = candidateChars;
      current.paragraphIndexes = Array.from(new Set([...current.paragraphIndexes, ...piece.paragraphIndexes]));
      current.splitInsideParagraph = current._inside || piece.inside;
      current._inside = current.splitInsideParagraph;
    } else {
      fragments.push(stripInternal(current));
      current = {
        index: fragments.length + 1,
        start: current.end,
        end: candidateEnd,
        chars: countChars(text.slice(current.end, candidateEnd)),
        paragraphIndexes: [...piece.paragraphIndexes],
        splitInsideParagraph: piece.inside,
        _inside: piece.inside,
      };
    }
  }
  if (current !== null) fragments.push(stripInternal(current));
  // 收尾：确保覆盖到原文末尾（原文尾部空白归入最后一段，保证可逐字还原）。
  if (fragments.length > 0 && fragments[fragments.length - 1].end < text.length) {
    const last = fragments[fragments.length - 1];
    last.end = text.length;
    last.chars = countChars(text.slice(last.start, last.end));
  }
  const rebuilt = fragments.map((f) => text.slice(f.start, f.end)).join('');
  if (rebuilt !== text) {
    // 理论上不会发生；一旦发生就退回“整篇一段”，宁可超限也不改动原文。
    return {
      totalChars,
      maxChars: limit,
      needsSplit: true,
      hasInsideParagraphSplit: false,
      fragments: [
        {
          index: 1,
          start: 0,
          end: text.length,
          chars: totalChars,
          paragraphIndexes: paragraphs.map((p) => p.index),
          splitInsideParagraph: false,
        },
      ],
    };
  }
  return {
    totalChars,
    maxChars: limit,
    needsSplit: true,
    hasInsideParagraphSplit: fragments.some((f) => f.splitInsideParagraph),
    fragments,
  };
}

function stripInternal(f: SplitFragment & { _inside: boolean }): SplitFragment {
  const { _inside, ...rest } = f;
  void _inside;
  return rest;
}

/** 片段拼接还原检查：直接采样与长文切分都用它做断言。 */
export function joinFragments(text: string, fragments: { start: number; end: number }[]): string {
  return fragments.map((f) => text.slice(f.start, f.end)).join('');
}

export interface LengthViolation {
  code: 'SAMPLE_TOO_LONG' | 'BATCH_TOO_MANY' | 'BATCH_TOO_LARGE';
  message: string;
}

/** 前后端共用的长度校验（服务端必须再验一次，不能只信前端）。 */
export function checkLengthLimits(
  samples: { chars?: number; text?: string }[],
  limits: { maxCharsPerSample: number; maxSamplesPerBatch: number; maxTotalCharsPerBatch: number },
): LengthViolation[] {
  const out: LengthViolation[] = [];
  const charsOf = (s: { chars?: number; text?: string }) =>
    typeof s.chars === 'number' ? s.chars : countChars(s.text ?? '');
  if (samples.length > limits.maxSamplesPerBatch) {
    out.push({
      code: 'BATCH_TOO_MANY',
      message: `一批最多 ${limits.maxSamplesPerBatch} 篇，当前 ${samples.length} 篇`,
    });
  }
  for (const s of samples) {
    const n = charsOf(s);
    if (n > limits.maxCharsPerSample) {
      out.push({
        code: 'SAMPLE_TOO_LONG',
        message: `单篇超过 ${limits.maxCharsPerSample} 字（含标点），当前 ${n} 字，请切分或缩短后再发送`,
      });
    }
  }
  const total = samples.reduce((acc, s) => acc + charsOf(s), 0);
  if (total > limits.maxTotalCharsPerBatch) {
    out.push({
      code: 'BATCH_TOO_LARGE',
      message: `一批总量超过 ${limits.maxTotalCharsPerBatch} 字（含标点），当前 ${total} 字`,
    });
  }
  return out;
}

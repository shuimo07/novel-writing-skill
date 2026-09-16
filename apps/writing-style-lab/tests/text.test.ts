import { describe, expect, it } from 'vitest';
import {
  checkLengthLimits,
  computeTextStats,
  contentHash,
  countChars,
  countCodePoints,
  joinFragments,
  planSplit,
  receiptFeatures,
  splitParagraphs,
  splitSentences,
  utf16Length,
} from '../src/shared/text';

describe('字数口径（含标点、码点、排除空白）', () => {
  it('扩展字符按码点算，不用 UTF-16 长度', () => {
    const text = 'a𝄞b'; // 𝄞 是 1 个码点、2 个 UTF-16 单元
    expect(countChars(text)).toBe(3);
    expect(countCodePoints(text)).toBe(3);
    expect(utf16Length(text)).toBe(4);
    expect(countChars(text)).not.toBe(utf16Length(text));
  });

  it('emoji 与组合字符不会被劈开', () => {
    expect(countChars('👩‍🚀')).toBe(3); // 女人 + 零宽连接符 + 火箭，均为非空白码点
    expect(countCodePoints('👩‍🚀')).toBe(3);
  });

  it('标点计入，空白（含全角空格、换行、制表）不计入', () => {
    expect(countChars('你好，世界。')).toBe(6);
    expect(countChars('你 好\n世\t界')).toBe(4);
    expect(countChars('　全角空格')).toBe(4);
  });
});

describe('段落切分', () => {
  const text = '第一段第一行\n第一段第二行\n\n第二段\n\n\n第三段';

  it('偏移与原文逐字一致', () => {
    for (const p of splitParagraphs(text)) {
      expect(p.text).toBe(text.slice(p.start, p.end));
    }
  });

  it('段内单换行保留，空行才分段', () => {
    const paragraphs = splitParagraphs(text);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].text).toContain('\n');
    expect(paragraphs[0].text).toBe('第一段第一行\n第一段第二行');
  });

  it('CRLF 空行分段后段落文本不夹带回车', () => {
    const crlf = '甲\r\n\r\n乙\r\n\r\n丙';
    const paragraphs = splitParagraphs(crlf);
    expect(paragraphs.map((p) => p.text)).toEqual(['甲', '乙', '丙']);
    for (const p of paragraphs) expect(p.text).toBe(crlf.slice(p.start, p.end));
  });

  it('段落 id 稳定递增', () => {
    expect(splitParagraphs(text).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('句段统计口径', () => {
  it('按终止标点断句，无标点的段落残余算一句', () => {
    expect(splitSentences('短。也短！真的很短？')).toHaveLength(3);
    expect(splitSentences('没有终止标点的一段话')).toHaveLength(1);
    expect(splitSentences('甲。\n\n乙。')).toHaveLength(2);
  });

  it('统计给出的是明确口径的近似值，不假装精确', () => {
    const stats = computeTextStats('他很累。她没说话。');
    expect(stats.sentences).toBe(2);
    expect(stats.chars).toBe(countChars('他很累。她没说话。'));
    expect(stats.paragraphs).toBe(1);
  });
});

describe('contentHash', () => {
  it('同一文本稳定，改一个字符就变', async () => {
    const a = await contentHash('他推开门，屋里没有人。');
    const b = await contentHash('他推开门，屋里没有人。');
    const c = await contentHash('他推开门，屋里没有人');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('CRLF 与 LF 的 hash 不同（证明没有做换行归一化）', async () => {
    const lf = await contentHash('甲\n乙');
    const crlf = await contentHash('甲\r\n乙');
    expect(lf).not.toBe(crlf);
  });
});

describe('接收特征（程序没有帮你规范化）', () => {
  it('识别 CRLF、BOM、零宽字符、制表符', () => {
    const f = receiptFeatures('\uFEFF甲\r\n乙\u200B\t丙');
    expect(f.lineEnding).toBe('crlf');
    expect(f.hasBom).toBe(true);
    expect(f.hasZeroWidth).toBe(true);
    expect(f.hasTab).toBe(true);
  });

  it('无换行时报告 none', () => {
    expect(receiptFeatures('只有一行').lineEnding).toBe('none');
  });
});

describe('长文切分（分区而不是裁剪）', () => {
  const long = Array.from({ length: 40 }, (_, i) => `第${i + 1}段：${'字'.repeat(90)}。`).join('\n\n');

  it('片段首尾相接，拼接后与原文逐字一致', () => {
    const plan = planSplit(long, 600);
    expect(plan.needsSplit).toBe(true);
    expect(plan.fragments.length).toBeGreaterThan(1);
    expect(joinFragments(long, plan.fragments)).toBe(long);
  });

  it('覆盖完整区间，不漏字也不重复', () => {
    const plan = planSplit(long, 700);
    expect(plan.fragments[0].start).toBe(0);
    expect(plan.fragments[plan.fragments.length - 1].end).toBe(long.length);
    for (let i = 1; i < plan.fragments.length; i += 1) {
      expect(plan.fragments[i].start).toBe(plan.fragments[i - 1].end);
    }
  });

  it('含 emoji、CRLF、零宽字符的长文也能逐字还原', () => {
    const tricky = Array.from({ length: 30 }, (_, i) => `第${i}段👩‍🚀\u200B${'甲'.repeat(80)}`).join('\r\n\r\n');
    const plan = planSplit(tricky, 500);
    expect(joinFragments(tricky, plan.fragments)).toBe(tricky);
  });

  it('不超限时只给一个片段且不切', () => {
    const plan = planSplit('短文本。', 600);
    expect(plan.needsSplit).toBe(false);
    expect(plan.fragments).toHaveLength(1);
    expect(plan.fragments[0].splitInsideParagraph).toBe(false);
  });

  it('超长单段降级到句末标点，并如实标记', () => {
    const oneParagraph = `${'甲'.repeat(400)}。${'乙'.repeat(400)}。`;
    const plan = planSplit(oneParagraph, 500);
    expect(joinFragments(oneParagraph, plan.fragments)).toBe(oneParagraph);
    expect(plan.fragments.length).toBeGreaterThan(1);
  });

  it('完全无标点的超长文本按码点硬切，仍然可还原且被标记', () => {
    const noPunct = '哈'.repeat(1500);
    const plan = planSplit(noPunct, 400);
    expect(joinFragments(noPunct, plan.fragments)).toBe(noPunct);
    expect(plan.hasInsideParagraphSplit).toBe(true);
  });
});

describe('长度校验（前后端共用同一套数字）', () => {
  const limits = { maxCharsPerSample: 6000, maxSamplesPerBatch: 10, maxTotalCharsPerBatch: 30000 };

  it('单篇超限被拦下', () => {
    const out = checkLengthLimits([{ text: '字'.repeat(6001) }], limits);
    expect(out.map((v) => v.code)).toContain('SAMPLE_TOO_LONG');
  });

  it('批量条数超限被拦下', () => {
    const out = checkLengthLimits(Array.from({ length: 11 }, () => ({ chars: 10 })), limits);
    expect(out.map((v) => v.code)).toContain('BATCH_TOO_MANY');
  });

  it('总量超限被拦下', () => {
    const out = checkLengthLimits(Array.from({ length: 10 }, () => ({ chars: 3500 })), limits);
    expect(out.map((v) => v.code)).toContain('BATCH_TOO_LARGE');
  });

  it('合规时无违规项', () => {
    expect(checkLengthLimits([{ chars: 500 }, { chars: 600 }], limits)).toEqual([]);
  });
});

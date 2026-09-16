/**
 * 本地风格学统计的展示件，以及「模型说法与本地实测不一致」提示的醒目样式。
 *
 * 为什么要在界面里展示：
 * - 直接采样时，作者在花 API 费用之前就能看到这篇文字的实际数字（不再只看模型的形容词）；
 * - 分析结果里，这些数字就是「可核查」的那一半：模型说「全用短句」，这里能直接看到平均句长是多少。
 *
 * 口径一律照抄 src/shared/stylometry.ts 的声明，不夸大、不假装是精确语言学测量。
 */
import { useMemo } from 'react';
import { computeStylometry, stylometryLines, type Stylometry } from '../../shared/stylometry';

export const CROSS_CHECK_PREFIX = '程序统计与这条说法不一致：';

export function isCrossCheckNote(note: string): boolean {
  return note.startsWith(CROSS_CHECK_PREFIX);
}

/** 把 limitations 拆成「程序统计对不上的提示」和其它普通局限，去掉完全重复的条目。 */
export function splitLimitations(limitations: string[]): { crossChecks: string[]; others: string[] } {
  const crossChecks: string[] = [];
  const others: string[] = [];
  const seen = new Set<string>();
  for (const note of limitations) {
    const trimmed = note.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (isCrossCheckNote(trimmed)) crossChecks.push(trimmed);
    else others.push(trimmed);
  }
  return { crossChecks, others };
}

export const STYLOMETRY_CAVEAT =
  '口径：句长按终止标点（。！？!?…，可连续）断句，长度用「字数（含标点）」（Unicode 码点、排除空白）；' +
  '标点密度是每 100 字（含标点）的出现次数；字次只算汉字与字母数字，不含标点与空白；' +
  '高频二字组合取自连续汉字串的相邻二字，含常用词也含无意义组合，只作线索，不是词频。';

export function StylometryView({
  stylometry,
  title = '本地风格学统计（程序算的，可复核）',
  note,
  showCaveat = true,
}: {
  stylometry: Stylometry | null;
  title?: string;
  note?: string | null;
  showCaveat?: boolean;
}) {
  const lines = useMemo(() => (stylometry ? stylometryLines(stylometry) : []), [stylometry]);
  if (!stylometry) return null;
  return (
    <div className="stylometry">
      <h4 className="sub-title">{title}</h4>
      {note && <p className="hint-line">{note}</p>}
      <ul className="stat-lines">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      {showCaveat && <p className="hint-line">{STYLOMETRY_CAVEAT}</p>}
    </div>
  );
}

/** 现算一份统计（用同一份 shared/stylometry.ts，任何地方算出来都一样）。 */
export function useStylometryOf(text: string | null): Stylometry | null {
  return useMemo(() => {
    if (text === null || text.trim() === '') return null;
    return computeStylometry(text);
  }, [text]);
}

/**
 * 观察 / 规则的「局限」列表。
 * 以「程序统计与这条说法不一致：」开头的条目单独用警示色小标签顶出来 —— 那代表模型的说法和本地实测对不上，需要作者核对。
 */
export function LimitationList({
  limitations,
  emptyText = '（未记录局限）',
  title = '局限',
}: {
  limitations: string[];
  emptyText?: string;
  title?: string;
}) {
  const { crossChecks, others } = useMemo(() => splitLimitations(limitations), [limitations]);
  if (limitations.length === 0) {
    return <p className="hint-line">{emptyText}</p>;
  }
  return (
    <div className="limitation-block">
      {crossChecks.length > 0 && (
        <ul className="crosscheck-list">
          {crossChecks.map((note) => (
            <li key={note} className="mismatch-note">
              <span className="crosscheck-tag">模型说法与实测对不上，请你核对</span>
              <span className="crosscheck-text">{note}</span>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <p className="hint-line">
          {title}：{others.join('；')}
        </p>
      )}
    </div>
  );
}

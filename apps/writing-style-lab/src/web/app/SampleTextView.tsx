/**
 * 只读正文视图（纯文本段落，逐段可标记偏好）。
 * 用于：直接采样的只读采样视图、样本库里的样本详情、分析结果里的原文依据高亮。
 * 绝不改写正文；高亮只是把命中的引用包一层 <mark>，其余仍是文本节点。
 */
import { useEffect, useRef } from 'react';
import { SOURCE_TYPE_LABEL, type PreferenceMark, type Sample } from '../../shared/schema';
import { countChars } from '../../shared/text';
import { Badge, HighlightedText } from './common';

export interface PreferenceMarkDraft {
  paragraphId: string;
  quote: string;
  kind: 'keep' | 'avoid';
}

export interface SampleTextViewProps {
  sample: Sample;
  marks?: PreferenceMark[];
  onMark?: (draft: PreferenceMarkDraft) => void;
  onUnmark?: (markId: string) => void;
  marksEnabled?: boolean;
  highlight?: { paragraphId: string; quote: string } | null;
  showHeader?: boolean;
}

export function SampleTextView({
  sample,
  marks = [],
  onMark,
  onUnmark,
  marksEnabled = false,
  highlight = null,
  showHeader = true,
}: SampleTextViewProps) {
  const focusRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (highlight && focusRef.current) {
      focusRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlight]);

  const marksOf = (paragraphId: string) => marks.filter((m) => m.paragraphId === paragraphId);

  return (
    <div className="sample-text">
      {showHeader && (
        <div className="sample-text-head">
          <Badge tone="neutral">r{sample.revision}</Badge>
          <Badge tone="info">{countChars(sample.text)} 字（含标点）</Badge>
          <Badge tone="neutral">{SOURCE_TYPE_LABEL[sample.sourceType]}</Badge>
          <Badge tone={sample.entryMode === 'task' ? 'info' : 'neutral'}>
            {sample.entryMode === 'task' ? '按题目写作' : '直接采样'}
          </Badge>
          {sample.holdout && <Badge tone="warn">保留样本</Badge>}
          {sample.partial && <Badge tone="warn">部分样本</Badge>}
          {!sample.useForAnalysis && <Badge tone="neutral">未入选本轮</Badge>}
          {sample.fragment && (
            <Badge tone="warn">
              片段 {sample.fragment.fragmentIndex}/{sample.fragment.fragmentCount}
            </Badge>
          )}
        </div>
      )}
      {sample.sceneTags.length > 0 && (
        <p className="sample-text-tags">场景标签：{sample.sceneTags.join('、')}</p>
      )}
      <ol className="paragraph-list">
        {sample.paragraphs.map((paragraph) => {
          const paragraphMarks = marksOf(paragraph.id);
          const isFocus = highlight !== null && highlight.paragraphId === paragraph.id;
          const quote = isFocus && paragraph.text.includes(highlight.quote) ? highlight.quote : null;
          return (
            <li
              key={paragraph.id}
              className={isFocus ? 'paragraph paragraph-focus' : 'paragraph'}
              ref={isFocus ? focusRef : undefined}
            >
              <div className="paragraph-head">
                <span className="paragraph-index">第 {paragraph.index} 段</span>
                <span className="paragraph-meta">
                  {paragraph.id} · {countChars(paragraph.text)} 字
                </span>
              </div>
              <p className="paragraph-text">
                <HighlightedText text={paragraph.text} quote={quote} />
              </p>
              {marksEnabled && (
                <div className="paragraph-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => onMark?.({ paragraphId: paragraph.id, quote: paragraph.text, kind: 'keep' })}
                  >
                    这段我想保留
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => onMark?.({ paragraphId: paragraph.id, quote: paragraph.text, kind: 'avoid' })}
                  >
                    这段不代表我希望的风格
                  </button>
                  {paragraphMarks.map((mark) => (
                    <span key={mark.id} className={mark.kind === 'keep' ? 'mark-chip mark-keep' : 'mark-chip mark-avoid'}>
                      {mark.kind === 'keep' ? '想保留' : '不代表我的风格'}
                      {onUnmark && (
                        <button
                          type="button"
                          className="chip-close"
                          onClick={() => onUnmark(mark.id)}
                          aria-label="取消这条标记"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {!marksEnabled && paragraphMarks.length > 0 && (
                <div className="paragraph-actions">
                  {paragraphMarks.map((mark) => (
                    <span key={mark.id} className={mark.kind === 'keep' ? 'mark-chip mark-keep' : 'mark-chip mark-avoid'}>
                      {mark.kind === 'keep' ? '想保留' : '不代表我的风格'}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {sample.paragraphs.length === 0 && <p className="empty-hint">这篇样本没有可切分的段落。</p>}
    </div>
  );
}

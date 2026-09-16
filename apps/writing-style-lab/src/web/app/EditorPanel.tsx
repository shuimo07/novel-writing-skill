/**
 * 区域 2：写作编辑区。
 * - 纯文本编辑（textarea 天然只吃纯文本）、粘贴、UTF-8 TXT/Markdown 导入、自动保存；
 * - 保存状态可见：保存中 / 已保存（时间）/ 保存失败（带原因）；
 * - 中文输入法组合输入期间不打断光标、不重复插字、不把拼音落盘（见 hooks.ts 的三道闸门）；
 * - 字数一律用 countChars（含标点、码点口径）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SOURCE_TYPE_LABEL, type Sample, type SourceDocument } from '../../shared/schema';
import { computeTextStats, contentHash, countChars, receiptFeatures, splitParagraphs } from '../../shared/text';
import { isEligibleSource } from '../../shared/rules';
import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  KeyValue,
  TextArea,
  formatTime,
  newId,
  readTextFile,
  type PanelNavProps,
} from './common';
import { useDraftText } from './hooks';
import { draftKeyFor, findTask, readDraft, useLab, writeDraft } from './store';

export interface EditorPanelProps extends PanelNavProps {
  activeTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  /** 由别的面板写入草稿后 +1，用来强制编辑区重新载入。 */
  draftSignal: number;
}

export function EditorPanel({ onNavigate, activeTaskId, onSelectTask, draftSignal }: EditorPanelProps) {
  const { data, save } = useLab();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback((key: string) => readDraft(key), []);
  const persist = useCallback((key: string, text: string) => writeDraft(key, text), []);
  const draftKey = draftKeyFor(activeTaskId);
  const draft = useDraftText({ loadKey: draftKey, load, persist });
  const reloadDraft = draft.reload;

  useEffect(() => {
    if (draftSignal > 0) void reloadDraft();
  }, [draftSignal, reloadDraft]);

  const task = findTask(data.tasks, activeTaskId);
  const chars = countChars(draft.text);
  const stats = useMemo(() => computeTextStats(draft.text), [draft.text]);

  const previous = useMemo(() => {
    const mine = data.samples.filter((s) =>
      activeTaskId === null ? s.taskId === null && s.entryMode === 'task' : s.taskId === activeTaskId,
    );
    return mine.sort((a, b) => b.revision - a.revision)[0] ?? null;
  }, [data.samples, activeTaskId]);

  const lengthState = useMemo(() => {
    if (!task) return null;
    if (chars === 0) return null;
    if (chars < task.targetMinChars) return `低于目标下限 ${task.targetMinChars} 字`;
    if (chars > task.targetMaxChars) return `超过目标上限 ${task.targetMaxChars} 字`;
    return `落在目标区间 ${task.targetMinChars}—${task.targetMaxChars} 字内`;
  }, [task, chars]);

  const saveState = (() => {
    if (draft.composing) return { tone: 'warn' as const, label: '输入法组合中（暂停保存）' };
    switch (draft.status) {
      case 'loading':
        return { tone: 'neutral' as const, label: '读取草稿中…' };
      case 'saving':
        return { tone: 'warn' as const, label: '保存中…' };
      case 'saved':
        return { tone: 'ok' as const, label: `已保存${draft.savedAt ? ` ${formatTime(draft.savedAt)}` : ''}` };
      case 'error':
        return { tone: 'danger' as const, label: '保存失败' };
      default:
        return { tone: 'neutral' as const, label: draft.dirty ? '待保存' : '无未保存改动' };
    }
  })();

  const importFile = async (file: File) => {
    try {
      const { text, encodingNote } = await readTextFile(file);
      if (draft.text.trim() !== '' && !window.confirm('导入会覆盖当前编辑区内容（已提交的样本不受影响）。继续吗？')) return;
      draft.replaceText(text);
      setImportNote(encodingNote ?? `已导入「${file.name}」（UTF-8，原文按解码结果放入编辑区）。`);
      setError(null);
    } catch (err) {
      setError(`读取文件失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const submitSample = async () => {
    if (chars === 0) {
      setError('正文是空的，没有可提交的内容。');
      return;
    }
    try {
      const text = draft.text;
      const now = new Date().toISOString();
      const hash = await contentHash(text);
      const constraints = task?.constraints ?? [];
      const constraintsHash = constraints.length > 0 ? await contentHash(constraints.join('\n')) : null;
      const revision = previous ? previous.revision + 1 : 1;
      const background = task
        ? `按任务卡「${task.title}」（v${task.version}）写作` +
          (constraints.length > 0 ? `；框架约束：${constraints.join('；')}` : '')
        : '未绑定题目的自由写作（无题目约束信息）';
      const doc: SourceDocument = {
        id: newId('doc'),
        title: task ? `${task.title} r${revision}` : `自由写作 r${revision}`,
        importMethod: 'task',
        sourceFileName: null,
        text,
        contentHash: hash,
        receipt: receiptFeatures(text),
        declaredSourceType: 'self_current',
        backgroundContext: background,
        createdAt: now,
        updatedAt: now,
      };
      const sample: Sample = {
        id: newId('sm'),
        revision,
        entryMode: 'task',
        taskId: task ? task.id : null,
        taskVersion: task ? task.version : null,
        taskConstraintsHash: constraintsHash,
        sourceDocumentId: doc.id,
        fragment: null,
        sourceType: 'self_current',
        text,
        contentHash: hash,
        paragraphs: splitParagraphs(text),
        sceneTags: task ? task.sceneTags : [],
        useForAnalysis: true,
        holdout: false,
        partial: false,
        partialNote: null,
        backgroundContext: background,
        authorNote: null,
        createdAt: now,
        updatedAt: now,
      };
      const superseded: Sample[] = previous
        ? [{ ...previous, useForAnalysis: false, updatedAt: now }]
        : [];

      const docOk = await save('sourceDocuments', [doc]);
      if (!docOk) {
        setError('样本没提交成功：文稿记录写入失败（页面顶部有具体原因）。');
        return;
      }
      const ok = await save('samples', [sample, ...superseded]);
      if (!ok) {
        setError('样本没提交成功：样本写入失败（页面顶部有具体原因）。');
        return;
      }
      setError(null);
      setNotice(
        `已存为样本 r${revision}（未入选的旧版本${
          superseded.length > 0 ? ` r${previous?.revision} 已自动移出本轮` : '无'
        }）。同一文稿的多个版本不会重复计入证据。下一步去「分析」页发送。`,
      );
    } catch (err) {
      setError(`提交样本失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const sameAsSubmitted = previous !== null && previous.text === draft.text;

  return (
    <div className="panel">
      <Card
        title="写作编辑区"
        subtitle="纯文本编辑。可以直接粘贴；也可以导入 UTF-8 的 TXT/Markdown。改动会自动保存到本机浏览器存储。"
        actions={
          <>
            <Badge tone={saveState.tone}>{saveState.label}</Badge>
            <Button onClick={() => void draft.saveNow()}>立即保存</Button>
          </>
        }
      >
        <div className="form-row">
          <Field label="这一轮按哪张任务卡写">
            <select
              className="input"
              value={activeTaskId ?? ''}
              onChange={(e) => onSelectTask(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">不绑定题目（自由草稿）</option>
              {data.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}（v{t.version}）
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">导入 / 操作</span>
            <div className="form-actions">
              <Button onClick={() => fileRef.current?.click()}>导入 TXT/Markdown</Button>
              <Button
                onClick={() => {
                  if (countChars(draft.text) === 0 || window.confirm('清空编辑区？已提交的样本不受影响。')) {
                    draft.replaceText('');
                  }
                }}
              >
                清空草稿
              </Button>
              <Button variant="primary" onClick={() => void submitSample()}>
                提交为样本
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              className="hidden-file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void importFile(file);
              }}
            />
          </div>
        </div>

        {task && (
          <div className="task-brief">
            <p className="task-prompt">{task.prompt}</p>
            {task.constraints.length > 0 && (
              <p className="hint-line hint-warn">
                框架约束：{task.constraints.join('；')}（这些是题目要求，分析时会与你的写作习惯区分开）
              </p>
            )}
          </div>
        )}

        {importNote && (
          <Banner tone="info" onDismiss={() => setImportNote(null)}>
            {importNote}
          </Banner>
        )}
        {error && (
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        {draft.status === 'error' && draft.message && (
          <Banner tone="danger">
            {draft.message}（可以先点「立即保存」重试；正文不会因为保存失败而消失。）
          </Banner>
        )}
        {notice && (
          <Banner tone="ok" onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        )}

        <div className="editor-wrap">
          <TextArea
            className="editor"
            rows={18}
            placeholder="在这里写，或者直接粘贴。中文输入法组合输入期间不会被打断。"
            {...draft.textareaProps}
          />
          <div className="editor-side">
            <KeyValue
              items={[
                { key: '字数（含标点）', value: <strong>{chars}</strong> },
                { key: '段落数', value: stats.paragraphs },
                { key: '句数（按终止标点）', value: stats.sentences },
                { key: '平均句长', value: `${stats.avgSentenceChars} 字` },
                { key: '最长句', value: `${stats.longestSentenceChars} 字` },
                { key: '对白字数占比', value: `${Math.round(stats.dialogueCharRatio * 100)}%` },
                { key: '段均字数', value: stats.avgParagraphChars },
                { key: '输入法状态', value: draft.composing ? '组合输入中' : '空闲' },
                { key: '字数目标', value: lengthState ?? '未绑定题目' },
                {
                  key: '与已提交版本',
                  value: previous ? (
                    sameAsSubmitted ? (
                      <Badge tone="ok">与 r{previous.revision} 一致</Badge>
                    ) : (
                      <Badge tone="warn">与 r{previous.revision} 不同</Badge>
                    )
                  ) : (
                    '还没有提交过'
                  ),
                },
              ]}
            />
            <p className="hint-line">
              正文按纯文本保存；改字＝新 revision，旧 revision 的快照不会被改写（历史版本可在样本库里查到）。
            </p>
            <div className="form-actions">
              <Button onClick={() => onNavigate('tasks')}>回样本库</Button>
              <Button onClick={() => onNavigate('direct')}>直接采样</Button>
              <Button onClick={() => onNavigate('analysis')}>去分析</Button>
            </div>
          </div>
        </div>

        {previous && (
          <p className="hint-line">
            最近一次提交：r{previous.revision} · {countChars(previous.text)} 字 ·{' '}
            {SOURCE_TYPE_LABEL[previous.sourceType]} ·{' '}
            {isEligibleSource(previous.sourceType) ? '来源可入选提炼' : '来源默认不参与提炼'} · 更新于{' '}
            {formatTime(previous.updatedAt)}
          </p>
        )}
      </Card>
    </div>
  );
}

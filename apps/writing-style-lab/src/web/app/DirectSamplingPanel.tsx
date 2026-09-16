/**
 * 区域 3：直接采样 —— 把已经写好的文字直接丢进来。
 *
 * 硬规则（都在这里落实）：
 * - 原样接收：不做 trim / 换行归一化，接收特征（换行风格、BOM、零宽字符）如实展示；
 * - 必须点选一次「来源自述」，默认不预选；
 * - 单篇超过上限时用 planSplit 给出「切成 N 段、每段约 X 字」的预览，作者确认后才切；绝不静默截断；
 * - 同一篇文稿的片段共用同一个 sourceDocumentId，界面明说「归纳时只算一份证据」；
 * - 采样视图默认只读，支持逐段标记偏好；想改字只能「另存为写作草稿」，原文版本不动。
 */
import { useMemo, useRef, useState } from 'react';
import {
  SOURCE_TYPE_LABEL,
  type PreferenceMark,
  type Sample,
  type SourceDocument,
  type SourceType,
} from '../../shared/schema';
import { MAX_CHARS_PER_SAMPLE } from '../../shared/limits';
import { contentHash, countChars, planSplit, receiptFeatures, splitParagraphs } from '../../shared/text';
import { computeStylometry } from '../../shared/stylometry';
import { isEligibleSource } from '../../shared/rules';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyHint,
  Field,
  KeyValue,
  TextArea,
  TextInput,
  formatTime,
  newId,
  parseSceneTags,
  readTextFile,
  summarizeText,
  type PanelNavProps,
} from './common';
import { SampleTextView, type PreferenceMarkDraft } from './SampleTextView';
import { StylometryView } from './StylometryView';
import { draftKeyFor, readDraft, useLab, writeDraft } from './store';

export interface DirectSamplingPanelProps extends PanelNavProps {
  onDraftLoaded: () => void;
}

interface IntakeItem {
  key: string;
  title: string;
  text: string;
  sourceFileName: string | null;
  importMethod: 'paste' | 'file';
  note: string | null;
}

const DECLARABLE: SourceType[] = ['self_current', 'self_old', 'ai_generated', 'unconfirmed'];

const LINE_ENDING_LABEL: Record<ReturnType<typeof receiptFeatures>['lineEnding'], string> = {
  lf: 'LF（\\n）',
  crlf: 'CRLF（\\r\\n）',
  cr: 'CR（\\r）',
  mixed: '混合换行（多种混用）',
  none: '无换行',
};

export function DirectSamplingPanel({ onNavigate, onDraftLoaded }: DirectSamplingPanelProps) {
  const { data, save, remove, removeSourceDocuments } = useLab();
  const [pasteText, setPasteText] = useState('');
  const [items, setItems] = useState<IntakeItem[]>([]);
  const [declared, setDeclared] = useState<SourceType | null>(null);
  const [sceneTagsInput, setSceneTagsInput] = useState('');
  const [background, setBackground] = useState('');
  const [holdout, setHoldout] = useState(false);
  const [batchConfirmed, setBatchConfirmed] = useState(false);
  const [oversizeMode, setOversizeMode] = useState<Record<string, 'split' | 'keep'>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const addPaste = () => {
    if (pasteText.trim() === '') {
      setError('粘贴框是空的。');
      return;
    }
    setItems((prev) => [
      ...prev,
      {
        key: newId('intake'),
        title: summarizeText(pasteText, 20),
        text: pasteText,
        sourceFileName: null,
        importMethod: 'paste',
        note: '来自粘贴框：浏览器文本框只接受纯文本，输入框里的换行会统一成 LF。要保留原始换行（CRLF 等）请用文件导入。',
      },
    ]);
    setPasteText('');
    setError(null);
  };

  const addFiles = async (files: FileList) => {
    const next: IntakeItem[] = [];
    const notes: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const { text, encodingNote } = await readTextFile(file);
        next.push({
          key: newId('intake'),
          title: file.name.replace(/\.[^.]+$/u, ''),
          text,
          sourceFileName: file.name,
          importMethod: 'file',
          note: encodingNote,
        });
      } catch (err) {
        notes.push(`「${file.name}」读取失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
    }
    if (next.length > 0) setItems((prev) => [...prev, ...next]);
    setError(notes.length > 0 ? notes.join('；') : null);
    setBatchConfirmed(false);
  };

  const plans = useMemo(
    () =>
      items.map((item) => ({
        item,
        plan: planSplit(item.text, MAX_CHARS_PER_SAMPLE),
        receipt: receiptFeatures(item.text),
        chars: countChars(item.text),
        // 本地统计：在发送给模型之前就让作者看到数字，不花钱。
        stylometry: computeStylometry(item.text),
      })),
    [items],
  );

  const oversize = plans.filter((p) => p.plan.needsSplit);
  const oversizeUnresolved = oversize.filter((p) => !oversizeMode[p.item.key]);
  const canAccept =
    items.length > 0 &&
    declared !== null &&
    items.every((item) => countChars(item.text) > 0) &&
    oversizeUnresolved.length === 0 &&
    (items.length === 1 || batchConfirmed);

  const accept = async () => {
    if (!declared) {
      setError('必须先点选一次来源自述（没有默认选项）。');
      return;
    }
    const tags = parseSceneTags(sceneTagsInput);
    const now = new Date().toISOString();
    let created = 0;
    let fragments = 0;
    for (const { item, plan } of plans) {
      const mode = oversizeMode[item.key] ?? 'keep';
      const hash = await contentHash(item.text);
      const doc: SourceDocument = {
        id: newId('doc'),
        title: item.title.trim() === '' ? summarizeText(item.text, 16) : item.title.trim(),
        importMethod: item.importMethod,
        sourceFileName: item.sourceFileName,
        text: item.text,
        contentHash: hash,
        receipt: receiptFeatures(item.text),
        declaredSourceType: declared,
        backgroundContext: background.trim() === '' ? null : background.trim(),
        createdAt: now,
        updatedAt: now,
      };
      const samples: Sample[] = [];
      if (plan.needsSplit && mode === 'split') {
        for (const fragment of plan.fragments) {
          const fragmentText = item.text.slice(fragment.start, fragment.end);
          samples.push({
            id: newId('sm'),
            revision: 1,
            entryMode: 'direct',
            taskId: null,
            taskVersion: null,
            taskConstraintsHash: null,
            sourceDocumentId: doc.id,
            fragment: {
              fragmentIndex: fragment.index,
              fragmentCount: plan.fragments.length,
              start: fragment.start,
              end: fragment.end,
              splitInsideParagraph: fragment.splitInsideParagraph,
            },
            sourceType: declared,
            text: fragmentText,
            contentHash: await contentHash(fragmentText),
            paragraphs: splitParagraphs(fragmentText),
            sceneTags: tags,
            useForAnalysis: true,
            holdout,
            partial: false,
            partialNote: null,
            backgroundContext: doc.backgroundContext,
            authorNote: null,
            createdAt: now,
            updatedAt: now,
          });
        }
        fragments += plan.fragments.length;
      } else {
        samples.push({
          id: newId('sm'),
          revision: 1,
          entryMode: 'direct',
          taskId: null,
          taskVersion: null,
          taskConstraintsHash: null,
          sourceDocumentId: doc.id,
          fragment: null,
          sourceType: declared,
          text: item.text,
          contentHash: hash,
          paragraphs: splitParagraphs(item.text),
          sceneTags: tags,
          // 超过单篇上限又没切分：默认不入选本轮（否则一定发不出去），作者可自己在样本库里改。
          useForAnalysis: !plan.needsSplit,
          holdout,
          partial: false,
          partialNote: plan.needsSplit
            ? `整篇 ${plan.totalChars} 字，超过单篇上限 ${MAX_CHARS_PER_SAMPLE} 字，未切分，因此默认不参与本轮提炼`
            : null,
          backgroundContext: doc.backgroundContext,
          authorNote: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const docOk = await save('sourceDocuments', [doc]);
      if (!docOk) {
        setError('接收中断：文稿记录写入失败（页面顶部有具体原因）。已经写入的部分不会回滚，请检查后再继续。');
        return;
      }
      const sampleOk = await save('samples', samples);
      if (!sampleOk) {
        setError('接收中断：样本写入失败（页面顶部有具体原因）。请到样本库确认这篇文稿的状态。');
        return;
      }
      created += 1;
    }
    setItems([]);
    setOversizeMode({});
    setDeclared(null);
    setBatchConfirmed(false);
    setSceneTagsInput('');
    setBackground('');
    setHoldout(false);
    setError(null);
    setNotice(
      `已接收 ${created} 篇文稿${fragments > 0 ? `，切分为 ${fragments} 个片段` : ''}。同一文稿的片段共用同一个 sourceDocumentId，归纳时只算一份证据。`,
    );
  };

  const openDoc = openDocId ? data.sourceDocuments.find((d) => d.id === openDocId) ?? null : null;
  const openDocSamples = openDoc ? data.samples.filter((s) => s.sourceDocumentId === openDoc.id) : [];

  const markParagraph = async (sample: Sample, draft: PreferenceMarkDraft) => {
    const mark: PreferenceMark = {
      id: newId('pm'),
      sampleId: sample.id,
      sampleRevision: sample.revision,
      paragraphId: draft.paragraphId,
      quote: draft.quote,
      kind: draft.kind,
      note: null,
      createdAt: new Date().toISOString(),
    };
    const ok = await save('preferences', [mark]);
    if (!ok) setError('保存段落偏好失败（页面顶部有具体原因）。');
  };

  const saveAsDraft = async (doc: SourceDocument) => {
    const key = draftKeyFor(null);
    try {
      const existing = await readDraft(key);
      if (existing.trim() !== '' && !window.confirm('自由草稿里已有内容，会覆盖它。继续吗？')) return;
      await writeDraft(key, doc.text);
      onDraftLoaded();
      setNotice('已另存为写作草稿（未绑定题目）。原稿版本仍然只读、未被改动。');
      onNavigate('editor');
    } catch (err) {
      setError(`另存草稿失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const dropDoc = async (doc: SourceDocument) => {
    if (!window.confirm(`确认删除文稿「${doc.title}」及其全部片段样本？`)) return;
    const ok = await removeSourceDocuments([doc.id]);
    if (!ok) setError('删除失败（页面顶部有具体原因）。');
    else if (openDocId === doc.id) setOpenDocId(null);
  };

  return (
    <div className="panel">
      <Card
        title="直接采样：把已经写好的文字丢进来"
        subtitle="不用重写一遍。粘贴或导入成稿，程序原样接收（不改字、不规范化），你只需要说明来源。"
        actions={<Button onClick={() => onNavigate('tasks')}>回样本库</Button>}
      >
        <div className="form-grid">
          <Field
            label="粘贴正文"
            hint="文本框只接受纯文本；框内的换行会被浏览器统一成 LF。要保留 CRLF 等原始换行，请用文件导入。"
          >
            <TextArea
              className="intake"
              rows={6}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="把写好的文字贴进来……"
            />
          </Field>
          <div className="form-actions">
            <Button onClick={addPaste}>加入待接收清单</Button>
            <Button onClick={() => fileRef.current?.click()}>导入 TXT/Markdown（可多选）</Button>
            <span className="hint-line">当前粘贴框字数（含标点）：{countChars(pasteText)}</span>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              className="hidden-file"
              onChange={(e) => {
                const files = e.target.files;
                e.target.value = '';
                if (files && files.length > 0) void addFiles(files);
              }}
            />
          </div>
        </div>

        {notice && (
          <Banner tone="ok" onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        )}
        {error && (
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        {plans.length === 0 ? (
          <EmptyHint>还没有待接收的文稿。</EmptyHint>
        ) : (
          <>
            <h4 className="sub-title">待接收清单（原样接收特征）</h4>
            <ul className="intake-list">
              {plans.map(({ item, plan, receipt, chars, stylometry }) => (
                <li key={item.key} className="intake-item">
                  <div className="intake-head">
                    <TextInput
                      value={item.title}
                      placeholder="文稿标题"
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((it) => (it.key === item.key ? { ...it, title: e.target.value } : it)),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      onClick={() => setItems((prev) => prev.filter((it) => it.key !== item.key))}
                    >
                      移除
                    </Button>
                  </div>
                  <KeyValue
                    items={[
                      { key: '字数（含标点）', value: <strong>{chars}</strong> },
                      { key: '全部码点（含空白）', value: receipt.codePoints },
                      { key: 'UTF-16 长度', value: receipt.utf16Length },
                      { key: '换行风格', value: LINE_ENDING_LABEL[receipt.lineEnding] },
                      { key: 'BOM', value: receipt.hasBom ? '含 BOM（已原样保留）' : '无' },
                      {
                        key: '零宽字符',
                        value: receipt.hasZeroWidth
                          ? '含零宽字符（U+200B—200D / U+2060 / U+FEFF 之一，已原样保留）'
                          : '无',
                      },
                      { key: '制表符', value: receipt.hasTab ? '含 Tab' : '无' },
                      { key: '来源文件', value: item.sourceFileName ?? '（粘贴）' },
                    ]}
                  />
                  {item.note && <p className="hint-line hint-warn">{item.note}</p>}
                  <StylometryView
                    stylometry={stylometry}
                    title="本地统计（发送给模型之前就可以看到的数字）"
                    note="这些数字由程序在你本机算出，还没调用任何接口，也不花钱；之后模型的观察会拿它们对照。"
                  />
                  {plan.needsSplit && (
                    <div className="split-plan">
                      <Banner tone="warn" title="超过单篇上限，需要你决定怎么处理">
                        共 {plan.totalChars} 字，超过单篇上限 {plan.maxChars} 字。程序不会截断，只会按下面的方式处理：
                        <br />
                        将切成 <strong>{plan.fragments.length}</strong> 段，每段约{' '}
                        <strong>{Math.round(plan.totalChars / Math.max(1, plan.fragments.length))}</strong> 字。
                        {plan.hasInsideParagraphSplit &&
                          '（其中有段落内部被切开，属于局限性：切点落在段落中间，可能切掉上下文。）'}
                        <ol className="fragment-list">
                          {plan.fragments.map((f) => (
                            <li key={f.index}>
                              第 {f.index} 段：{f.chars} 字，覆盖段落 {f.paragraphIndexes.join('、') || '—'}
                              {f.splitInsideParagraph ? '（段内切开）' : ''}
                            </li>
                          ))}
                        </ol>
                      </Banner>
                      <div className="radio-row">
                        <label className="radio">
                          <input
                            type="radio"
                            name={`split-${item.key}`}
                            checked={oversizeMode[item.key] === 'split'}
                            onChange={() => setOversizeMode((prev) => ({ ...prev, [item.key]: 'split' }))}
                          />
                          确认切分（推荐：每个片段都能单独送入分析与提炼）
                        </label>
                        <label className="radio">
                          <input
                            type="radio"
                            name={`split-${item.key}`}
                            checked={oversizeMode[item.key] === 'keep'}
                            onChange={() => setOversizeMode((prev) => ({ ...prev, [item.key]: 'keep' }))}
                          />
                          不切分，整篇存为样本（超过单篇上限，默认不入选本轮）
                        </label>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <h4 className="sub-title">来源自述（必须选一次，没有默认值）</h4>
            <div className="radio-row">
              {DECLARABLE.map((type) => (
                <label key={type} className="radio">
                  <input
                    type="radio"
                    name="declared-source"
                    checked={declared === type}
                    onChange={() => setDeclared(type)}
                  />
                  {SOURCE_TYPE_LABEL[type]}
                  {type === 'self_current' && <span className="hint-inline">（本次写作）</span>}
                  {type === 'self_old' && <span className="hint-inline">（旧文）</span>}
                </label>
              ))}
            </div>
            <p className="hint-line">
              只有「本人本次写作 / 本人旧文」默认参与提炼；「含 AI 生成」「不确定」会照常存进样本库，但不会发送到提炼。
              如果这篇是人机混合写的，请在写作背景声明里写清楚，并选最保守的来源（不确定 → 不参与提炼）。
            </p>

            <div className="form-grid">
              <Field label="场景标签（可选）" hint="用「、」或逗号分隔，例如：对话、都市、回忆。">
                <TextInput value={sceneTagsInput} onChange={(e) => setSceneTagsInput(e.target.value)} />
              </Field>
              <Field
                label="写作背景声明（可选）"
                hint="例如：这是给杂志写的、当时要求全用短句。没有题目信息时，程序无法判断哪些特征是题目逼出来的。"
              >
                <TextArea rows={3} value={background} onChange={(e) => setBackground(e.target.value)} />
              </Field>
              <label className="checkbox">
                <input type="checkbox" checked={holdout} onChange={(e) => setHoldout(e.target.checked)} />
                设为保留样本（holdout）：存进库里，但不发送到本轮提炼，留给你事后人工对照规则
              </label>
              {items.length > 1 && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={batchConfirmed}
                    onChange={(e) => setBatchConfirmed(e.target.checked)}
                  />
                  这 {items.length} 篇的来源自述相同，确认按上面选中的来源一次性接收
                </label>
              )}
            </div>

            <div className="form-actions">
              <Button variant="primary" disabled={!canAccept} onClick={() => void accept()}>
                接收并建立样本
              </Button>
              <Button
                onClick={() => {
                  setItems([]);
                  setOversizeMode({});
                  setError(null);
                }}
              >
                清空待接收清单
              </Button>
              {!canAccept && (
                <span className="hint-line hint-warn">
                  {declared === null
                    ? '还不能接收：请先点选来源自述。'
                    : oversizeUnresolved.length > 0
                      ? `还不能接收：有 ${oversizeUnresolved.length} 篇超限文稿还没决定切分方式。`
                      : items.length > 1 && !batchConfirmed
                        ? '还不能接收：多篇一次接收需要勾选确认来源相同。'
                        : '还不能接收：清单是空的或正文为空。'}
                </span>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title="已接收文稿" subtitle="默认只读。原文版本永远不动；要改字请「另存为写作草稿」。" >
        {data.sourceDocuments.length === 0 ? (
          <EmptyHint>还没有接收过文稿。</EmptyHint>
        ) : (
          <ul className="doc-list">
            {data.sourceDocuments
              .slice()
              .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
              .map((doc) => {
                const samples = data.samples.filter((s) => s.sourceDocumentId === doc.id);
                const usable = samples.filter((s) => isEligibleSource(s.sourceType) && !s.holdout && s.useForAnalysis);
                return (
                  <li key={doc.id} className="doc-row">
                    <div className="doc-row-main">
                      <div className="sample-row-title">
                        <strong>{doc.title}</strong>
                        <Badge tone="neutral">{SOURCE_TYPE_LABEL[doc.declaredSourceType]}</Badge>
                        <Badge tone="info">{countChars(doc.text)} 字（含标点）</Badge>
                        {samples.length > 1 && <Badge tone="warn">{samples.length} 个片段</Badge>}
                        {doc.declaredSourceType === 'ai_generated' && <Badge tone="danger">AI 生成</Badge>}
                      </div>
                      <div className="sample-row-meta">
                        <span>接收方式：{doc.importMethod === 'file' ? '文件导入' : doc.importMethod === 'paste' ? '粘贴' : '题目写作'}</span>
                        {doc.sourceFileName && <span>文件：{doc.sourceFileName}</span>}
                        <span>换行：{LINE_ENDING_LABEL[doc.receipt.lineEnding]}</span>
                        <span>BOM：{doc.receipt.hasBom ? '含' : '无'}</span>
                        <span>零宽字符：{doc.receipt.hasZeroWidth ? '含' : '无'}</span>
                        <span>接收于 {formatTime(doc.createdAt)}</span>
                      </div>
                      {samples.length > 1 && (
                        <p className="hint-line">
                          同一文稿的片段，归纳时只算一份证据（sourceDocumentId 相同，共 {samples.length} 段，其中 {usable.length} 段入选本轮）。
                        </p>
                      )}
                      {doc.backgroundContext && <p className="hint-line">背景声明：{doc.backgroundContext}</p>}
                    </div>
                    <div className="sample-row-actions">
                      <Button onClick={() => setOpenDocId(openDocId === doc.id ? null : doc.id)}>
                        {openDocId === doc.id ? '收起只读视图' : '查看（只读）'}
                      </Button>
                      <Button onClick={() => void saveAsDraft(doc)}>另存为写作草稿</Button>
                      <Button variant="danger" onClick={() => void dropDoc(doc)}>
                        删除文稿
                      </Button>
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </Card>

      {openDoc && (
        <Card
          title={`只读采样视图 · ${openDoc.title}`}
          subtitle="这一屏不能改字。想改，另存为写作草稿；原文版本保持原样，可随时回来对照。"
          actions={
            <>
              <Badge tone="neutral">只读</Badge>
              <Button onClick={() => void saveAsDraft(openDoc)}>另存为写作草稿</Button>
            </>
          }
        >
          {openDocSamples.length === 0 ? (
            <EmptyHint>这篇文稿没有对应的样本记录。</EmptyHint>
          ) : (
            openDocSamples
              .slice()
              .sort((a, b) => (a.fragment?.fragmentIndex ?? 0) - (b.fragment?.fragmentIndex ?? 0))
              .map((sample) => (
                <SampleTextView
                  key={sample.id}
                  sample={sample}
                  marks={data.preferences.filter((p) => p.sampleId === sample.id)}
                  marksEnabled
                  onMark={(draft) => void markParagraph(sample, draft)}
                  onUnmark={(markId) => void remove('preferences', [markId])}
                />
              ))
          )}
        </Card>
      )}
    </div>
  );
}

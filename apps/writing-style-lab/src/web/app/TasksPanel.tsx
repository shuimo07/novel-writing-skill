/**
 * 区域 1：写作任务与样本库。
 * - 内置 6 张任务卡，可改（改了就 +1 版本，旧样本仍记着当时那版）；
 * - 样本库列出全部样本：标题、字数（含标点）、来源标签、场景标签、是否入选本轮、holdout、状态徽章；
 * - 「从题目开始写作」与「直接采样」两个入口并排放在样本库区域里。
 */
import { useMemo, useState } from 'react';
import {
  SOURCE_TYPE_LABEL,
  type PreferenceMark,
  type Sample,
  type WritingTask,
} from '../../shared/schema';
import { countChars } from '../../shared/text';
import { describeExclusion } from '../../shared/rules';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyHint,
  Field,
  TextArea,
  TextInput,
  formatTime,
  newId,
  parseSceneTags,
  summarizeText,
  type PanelNavProps,
} from './common';
import { SampleTextView, type PreferenceMarkDraft } from './SampleTextView';
import { analysisStatusOf, draftKeyFor, findTask, readDraft, sampleTitle, useLab, writeDraft } from './store';

export interface TasksPanelProps extends PanelNavProps {
  activeTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  /** 通知 App：编辑区需要重新从本地存储载入草稿。 */
  onDraftLoaded: () => void;
}

type SampleFilter = 'all' | 'selected' | 'holdout' | 'excluded' | 'analyzed' | 'outdated';

const FILTERS: { key: SampleFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'selected', label: '入选本轮' },
  { key: 'holdout', label: '保留样本' },
  { key: 'excluded', label: '已排除' },
  { key: 'analyzed', label: '已有可用分析' },
  { key: 'outdated', label: '分析过期' },
];

function TaskCard({
  task,
  onStartWriting,
  onDeleted,
}: {
  task: WritingTask;
  onStartWriting: (taskId: string) => void;
  onDeleted: () => void;
}) {
  const { data, save, remove } = useLab();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: task.title,
    prompt: task.prompt,
    constraints: task.constraints.join('\n'),
    sceneTags: task.sceneTags.join('、'),
    min: task.targetMinChars,
    max: task.targetMaxChars,
  });
  const [error, setError] = useState<string | null>(null);

  const mine = data.samples.filter((s) => s.taskId === task.id);
  const outdated = mine.filter((s) => s.taskVersion !== null && s.taskVersion !== task.version);

  const submit = async () => {
    if (form.title.trim() === '') {
      setError('标题不能为空。');
      return;
    }
    if (!Number.isFinite(form.min) || !Number.isFinite(form.max) || form.min <= 0 || form.max < form.min) {
      setError('目标字数区间不合法：必须是正数，且上限不小于下限。');
      return;
    }
    const next: WritingTask = {
      ...task,
      version: task.version + 1,
      title: form.title.trim(),
      prompt: form.prompt,
      constraints: form.constraints
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      sceneTags: parseSceneTags(form.sceneTags),
      targetMinChars: Math.round(form.min),
      targetMaxChars: Math.round(form.max),
      updatedAt: new Date().toISOString(),
    };
    const ok = await save('tasks', [next]);
    if (!ok) {
      setError('保存失败，本地数据库没有写入成功（页面顶部有具体原因）。');
      return;
    }
    setError(null);
    setOpen(false);
  };

  const drop = async () => {
    if (mine.length > 0) {
      setError(`还有 ${mine.length} 篇样本挂在这张任务卡上，先把它们删掉或改挂别的任务，再删除任务卡。`);
      return;
    }
    if (!window.confirm(`确认删除任务卡「${task.title}」？`)) return;
    const ok = await remove('tasks', [task.id]);
    if (ok) onDeleted();
    else setError('删除失败（页面顶部有具体原因）。');
  };

  return (
    <Card
      title={
        <span className="task-title">
          {task.title}
          <Badge tone="neutral">v{task.version}</Badge>
          {task.builtIn && <Badge tone="info">内置</Badge>}
        </span>
      }
      subtitle={`目标 ${task.targetMinChars}—${task.targetMaxChars} 字 · 已有样本 ${mine.length} 篇`}
      actions={
        <>
          <Button variant="primary" onClick={() => onStartWriting(task.id)}>
            从题目开始写作
          </Button>
          <Button onClick={() => setOpen((v) => !v)}>{open ? '收起' : '编辑任务卡'}</Button>
        </>
      }
    >
      <p className="task-prompt">{task.prompt}</p>
      <div className="tag-row">
        {task.sceneTags.map((tag) => (
          <Badge key={tag} tone="neutral">
            {tag}
          </Badge>
        ))}
        {task.constraints.length === 0 ? (
          <Badge tone="neutral">无额外框架约束</Badge>
        ) : (
          task.constraints.map((c) => (
            <Badge key={c} tone="warn">
              框架约束：{c}
            </Badge>
          ))
        )}
      </div>
      {outdated.length > 0 && (
        <Banner tone="warn">
          有 {outdated.length} 篇样本是在这张任务卡的旧版本（v
          {Array.from(new Set(outdated.map((s) => s.taskVersion))).join('/v')}）下写的。旧样本仍按当时那版约束参与分析，不会被自动改写。
        </Banner>
      )}
      {error && (
        <Banner tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {open && (
        <div className="form-grid">
          <Field label="标题">
            <TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="题目正文" hint="只限定人物、目标、事件、长度。">
            <TextArea rows={4} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          </Field>
          <Field label="框架约束（每行一条）" hint="例如「全用短句」。分析时必须识别这类约束的影响，不能当成你的写作习惯。">
            <TextArea
              rows={3}
              value={form.constraints}
              placeholder={'全用短句\n不用比喻'}
              onChange={(e) => setForm({ ...form, constraints: e.target.value })}
            />
          </Field>
          <div className="form-row">
            <Field label="目标最少字数">
              <TextInput
                type="number"
                min={1}
                value={form.min}
                onChange={(e) => setForm({ ...form, min: Number(e.target.value) })}
              />
            </Field>
            <Field label="目标最多字数">
              <TextInput
                type="number"
                min={1}
                value={form.max}
                onChange={(e) => setForm({ ...form, max: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="场景标签" hint="用「、」或逗号分隔。">
            <TextInput value={form.sceneTags} onChange={(e) => setForm({ ...form, sceneTags: e.target.value })} />
          </Field>
          <div className="form-actions">
            <Button variant="primary" onClick={() => void submit()}>
              保存（版本 +1）
            </Button>
            <Button
              onClick={() => {
                setForm({
                  title: task.title,
                  prompt: task.prompt,
                  constraints: task.constraints.join('\n'),
                  sceneTags: task.sceneTags.join('、'),
                  min: task.targetMinChars,
                  max: task.targetMaxChars,
                });
                setError(null);
              }}
            >
              还原
            </Button>
            <Button variant="danger" onClick={() => void drop()}>
              删除任务卡
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SampleRow({
  sample,
  selected,
  onSelect,
  onStartWritingFromSample,
}: {
  sample: Sample;
  selected: boolean;
  onSelect: () => void;
  onStartWritingFromSample: (sample: Sample) => void;
}) {
  const { data, save, removeSamples } = useLab();
  const [error, setError] = useState<string | null>(null);
  const status = analysisStatusOf(sample, data.analyses);
  const exclusion = describeExclusion(sample);
  const doc = sample.sourceDocumentId
    ? data.sourceDocuments.find((d) => d.id === sample.sourceDocumentId)
    : undefined;
  const siblings = doc ? data.samples.filter((s) => s.sourceDocumentId === doc.id) : [];
  const task = findTask(data.tasks, sample.taskId);

  const toggle = async (patch: Partial<Sample>) => {
    const next: Sample = { ...sample, ...patch, updatedAt: new Date().toISOString() };
    const ok = await save('samples', [next]);
    if (!ok) setError('修改失败（页面顶部有具体原因）。');
  };

  const drop = async () => {
    if (!window.confirm('确认删除这篇样本？它上面的分析与偏好标记会一起删掉，引用它的规则会被标记为需重新确认。')) return;
    const ok = await removeSamples([sample.id]);
    if (!ok) setError('删除失败（页面顶部有具体原因）。');
  };

  return (
    <li className={selected ? 'sample-row sample-row-active' : 'sample-row'}>
      <div className="sample-row-main">
        <div className="sample-row-title">
          <strong>{summarizeText(sampleTitle(sample, data), 40)}</strong>
          {status.usable && <Badge tone="ok">已有分析</Badge>}
          {status.outdated && <Badge tone="warn">分析过期</Badge>}
          {status.rejected && <Badge tone="danger">上次分析被拒绝</Badge>}
          {!status.latest && <Badge tone="neutral">未分析</Badge>}
          {status.mock && <Badge tone="mock">Mock</Badge>}
        </div>
        <div className="sample-row-meta">
          <span>{countChars(sample.text)} 字（含标点）</span>
          <span>来源：{SOURCE_TYPE_LABEL[sample.sourceType]}</span>
          <span>{sample.entryMode === 'task' ? `题目：${task ? task.title : '（任务卡已删除）'}` : '直接采样'}</span>
          {sample.sceneTags.length > 0 && <span>场景：{sample.sceneTags.join('、')}</span>}
          <span>r{sample.revision}</span>
          {sample.fragment && (
            <span>
              片段 {sample.fragment.fragmentIndex}/{sample.fragment.fragmentCount}
            </span>
          )}
          <span>更新：{formatTime(sample.updatedAt)}</span>
        </div>
        {doc && siblings.length > 1 && (
          <p className="hint-line">
            同一文稿的片段（{siblings.length} 段，文稿「{doc.title}」），归纳时只算一份证据。
          </p>
        )}
        {exclusion && <p className="hint-line hint-warn">本轮不发的原因：{exclusion}</p>}
        {error && (
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
      </div>
      <div className="sample-row-actions">
        <Button onClick={onSelect}>{selected ? '收起原文' : '查看原文'}</Button>
        <Button onClick={() => void toggle({ useForAnalysis: !sample.useForAnalysis })}>
          {sample.useForAnalysis ? '移出本轮' : '入选本轮'}
        </Button>
        <Button onClick={() => void toggle({ holdout: !sample.holdout })}>
          {sample.holdout ? '取消保留' : '设为保留样本'}
        </Button>
        <Button onClick={() => onStartWritingFromSample(sample)}>基于此版本继续写</Button>
        <Button variant="danger" onClick={() => void drop()}>
          删除
        </Button>
      </div>
    </li>
  );
}

export function TasksPanel({ onNavigate, activeTaskId, onSelectTask, onDraftLoaded }: TasksPanelProps) {
  const { data, save, remove, removeSamples } = useLab();
  const [filter, setFilter] = useState<SampleFilter>('all');
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const samples = useMemo(() => {
    const withStatus = data.samples.map((sample) => ({ sample, status: analysisStatusOf(sample, data.analyses) }));
    const filtered = withStatus.filter(({ sample, status }) => {
      switch (filter) {
        case 'selected':
          return sample.useForAnalysis && !sample.holdout;
        case 'holdout':
          return sample.holdout;
        case 'excluded':
          return describeExclusion(sample) !== null;
        case 'analyzed':
          return status.usable;
        case 'outdated':
          return status.needsAttention;
        default:
          return true;
      }
    });
    return filtered
      .map(({ sample }) => sample)
      .sort((a, b) => {
        const docA = a.sourceDocumentId ?? a.id;
        const docB = b.sourceDocumentId ?? b.id;
        if (docA !== docB) return docA < docB ? -1 : 1;
        if (a.revision !== b.revision) return b.revision - a.revision;
        const fa = a.fragment?.fragmentIndex ?? 0;
        const fb = b.fragment?.fragmentIndex ?? 0;
        return fa - fb;
      });
  }, [data.samples, data.analyses, filter]);

  const selectedSample = selectedSampleId ? data.samples.find((s) => s.id === selectedSampleId) ?? null : null;

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
    if (!ok) setError('保存偏好标记失败（页面顶部有具体原因）。');
    else setNotice('已记录这条段落偏好；它会在归纳时作为作者本人的偏好提交，不当作样本证据。');
  };

  const unmarkParagraph = async (markId: string) => {
    const ok = await remove('preferences', [markId]);
    if (!ok) setError('取消标记失败（页面顶部有具体原因）。');
  };

  /** 把某段正文放进编辑区草稿（原文快照本身不动）。 */
  const startWriting = async (task: WritingTask | null, initialText?: string) => {
    const key = draftKeyFor(task ? task.id : null);
    if (initialText !== undefined) {
      let existing = '';
      try {
        existing = await readDraft(key);
      } catch (err) {
        setError(`读取已有草稿失败：${err instanceof Error ? err.message : '未知错误'}`);
        return;
      }
      if (existing.trim() !== '' && !window.confirm('这份草稿里已经有内容，写入会覆盖它。要覆盖吗？')) return;
      try {
        await writeDraft(key, initialText);
      } catch (err) {
        setError(`写入草稿失败：${err instanceof Error ? err.message : '未知错误'}`);
        return;
      }
      onDraftLoaded();
    }
    onSelectTask(task ? task.id : null);
    onNavigate('editor');
  };

  const createTask = async () => {
    const now = new Date().toISOString();
    const task: WritingTask = {
      id: newId('task'),
      version: 1,
      title: '（未命名任务）',
      prompt: '',
      constraints: [],
      targetMinChars: 300,
      targetMaxChars: 600,
      sceneTags: [],
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    };
    const ok = await save('tasks', [task]);
    if (!ok) setError('新建任务卡失败（页面顶部有具体原因）。');
    else setNotice('已新建任务卡，请在卡片里编辑标题、题目与框架约束。');
  };

  const dropAllExcluded = async () => {
    const excluded = data.samples.filter((s) => describeExclusion(s) !== null && !s.holdout);
    if (excluded.length === 0) {
      setNotice('没有可清理的排除样本。');
      return;
    }
    if (!window.confirm(`确认删除这 ${excluded.length} 篇已排除的样本？（保留样本不会被删）`)) return;
    const ok = await removeSamples(excluded.map((s) => s.id));
    if (!ok) setError('删除失败（页面顶部有具体原因）。');
  };

  return (
    <div className="panel">
      <Card
        title="写作任务"
        subtitle="内置 6 张任务卡，题目只限定人物/目标/事件/长度；你额外加的框架约束会存进任务卡的 constraints，分析时必须区分。"
        actions={
          <Button onClick={() => void createTask()}>新建任务卡</Button>
        }
      >
        <div className="task-grid">
          {data.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onStartWriting={(taskId) => {
                const target = data.tasks.find((t) => t.id === taskId) ?? null;
                void startWriting(target);
              }}
              onDeleted={() => setNotice('任务卡已删除。')}
            />
          ))}
        </div>
      </Card>

      <Card
        title="样本库"
        subtitle="所有样本（含直接采样的片段）都在这里。字数口径是「含标点、按码点、排除空白」。"
        actions={<Button onClick={() => void dropAllExcluded()}>清理已排除样本</Button>}
      >
        <div className="entry-row">
          <label className="entry-pick">
            <span className="field-label">这一轮写哪张任务卡</span>
            <select
              className="input"
              value={activeTaskId ?? ''}
              onChange={(e) => onSelectTask(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">不绑定题目（自由草稿）</option>
              {data.tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}（v{task.version}）
                </option>
              ))}
            </select>
          </label>
          <Button variant="primary" onClick={() => void startWriting(findTask(data.tasks, activeTaskId))}>
            从题目开始写作
          </Button>
          <Button onClick={() => onNavigate('direct')}>直接采样（把已经写好的文字丢进来）</Button>
        </div>
        {notice && (
          <Banner tone="info" onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        )}
        {error && (
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        <div className="chip-row">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={filter === item.key ? 'chip chip-active' : 'chip'}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {samples.length === 0 ? (
          <EmptyHint>
            还没有样本。可以用上面的「从题目开始写作」按题目写，也可以直接采样把已经写好的文字丢进来。
          </EmptyHint>
        ) : (
          <ul className="sample-list">
            {samples.map((sample) => (
              <SampleRow
                key={sample.id}
                sample={sample}
                selected={sample.id === selectedSampleId}
                onSelect={() => setSelectedSampleId(sample.id === selectedSampleId ? null : sample.id)}
                onStartWritingFromSample={(s) => {
                  const task = findTask(data.tasks, s.taskId);
                  void startWriting(task, s.text);
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      {selectedSample && (
        <Card
          title="样本原文（只读）"
          subtitle={`${sampleTitle(selectedSample, data)} · r${selectedSample.revision} · 原文快照不可编辑；标记只记录你对段落的偏好。`}
          actions={
            <>
              <Button
                onClick={() => {
                  const task = findTask(data.tasks, selectedSample.taskId);
                  void startWriting(task, selectedSample.text);
                }}
              >
                另存为写作草稿（原文不动）
              </Button>
              <Button onClick={() => onNavigate('analysis')}>去分析</Button>
            </>
          }
        >
          <SampleTextView
            sample={selectedSample}
            marks={data.preferences.filter((p) => p.sampleId === selectedSample.id)}
            marksEnabled
            onMark={(draft) => void markParagraph(selectedSample, draft)}
            onUnmark={(markId) => void unmarkParagraph(markId)}
          />
        </Card>
      )}
    </div>
  );
}

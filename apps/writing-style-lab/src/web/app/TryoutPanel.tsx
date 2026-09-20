/**
 * 区域 6：对照试写、历史版本与设置。
 *
 * 对照试写的纪律：
 * - 题目必须是本轮提炼没用过的新题目；
 * - 评价之前绝不显示哪个是加了 Skill 的（界面上不出现任何暗示），评价完成之后才能揭示；
 * - 试写文本永远标记为 AI 生成，不提供任何“收进样本库”的入口。
 */
import { useMemo, useRef, useState } from 'react';
import {
  RULE_SCOPE_LABEL,
  UNKNOWN_USAGE,
  type Backup,
  type Evaluation,
  type TryoutResponse,
} from '../../shared/schema';
import { PROMPT_VERSION, TRYOUT_TARGET_MAX, TRYOUT_TARGET_MIN } from '../../shared/limits';
import { selectExportableRules } from '../../shared/rules';
import { compileExport } from '../../shared/export';
import { applyImport, createBackup, previewImport, serializeBackup } from '../../shared/backup';
import { createABPair, revealCondition, type ABPair } from '../../shared/ab';
import { STATIC_DEMO, tryout } from '../api';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyHint,
  Field,
  KeyValue,
  PlainText,
  TextArea,
  TextInput,
  downloadText,
  formatTime,
  formatUsage,
  newId,
  readTextFile,
  type PanelNavProps,
} from './common';
import { APP_VERSION, buildProfile, collectScenes, createBuiltinTasks, findTask, readDraft, useLab } from './store';
import * as db from '../db';

export interface TryoutPanelProps extends PanelNavProps {}

type Choice = 'A' | 'B' | 'both' | 'neither' | 'similar';

const PICK_LABEL: Record<Choice, string> = {
  A: 'A',
  B: 'B',
  both: '都像',
  neither: '都不像',
  similar: '差不多',
};

interface PendingTryout {
  runId: string;
  prompt: string;
  pair: ABPair;
  response: TryoutResponse;
  revealed: boolean;
  evaluationId: string | null;
}

function PickRow({
  label,
  value,
  onChange,
  allowEmpty,
}: {
  label: string;
  value: Choice | null;
  onChange: (next: Choice | null) => void;
  allowEmpty?: boolean;
}) {
  return (
    <div className="pick-row">
      <span className="field-label">{label}</span>
      {(['A', 'B', 'both', 'neither', 'similar'] as Choice[]).map((option) => (
        <label key={option} className="radio">
          <input type="radio" checked={value === option} onChange={() => onChange(option)} />
          {PICK_LABEL[option]}
        </label>
      ))}
      {allowEmpty && (
        <label className="radio">
          <input type="radio" checked={value === null} onChange={() => onChange(null)} />
          不评
        </label>
      )}
    </div>
  );
}

export function TryoutPanel({ onNavigate }: TryoutPanelProps) {
  const { data, save, replaceAll, status, statusError, refreshStatus } = useLab();
  const [prompt, setPrompt] = useState('');
  const [freshConfirmed, setFreshConfirmed] = useState(false);
  const [targetMin, setTargetMin] = useState(TRYOUT_TARGET_MIN);
  const [targetMax, setTargetMax] = useState(TRYOUT_TARGET_MAX);
  const [busy, setBusy] = useState(false);
  const [useMock, setUseMock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTryout | null>(null);
  const [closer, setCloser] = useState<Choice | null>(null);
  const [tone, setTone] = useState<Choice | null>(null);
  const [rhythm, setRhythm] = useState<Choice | null>(null);
  const [detail, setDetail] = useState<Choice | null>(null);
  const [reason, setReason] = useState('');
  const [backupJson, setBackupJson] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<'skip' | 'overwrite' | 'duplicate'>('skip');
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const backupFileRef = useRef<HTMLInputElement | null>(null);

  const exportable = useMemo(() => selectExportableRules(data.rules), [data.rules]);

  const sendable = useMemo(() => data.samples.filter((s) => s.useForAnalysis && !s.holdout), [data.samples]);

  const compiled = useMemo(() => {
    const profile = buildProfile({
      rules: exportable,
      samples: sendable,
      model: data.profiles[0]?.model ?? '（暂无模型信息）',
      promptVersion: PROMPT_VERSION,
      mock: data.analyses.some((a) => a.mock),
      version: data.profiles.length + 1,
      now: new Date().toISOString(),
      coveredScenes: collectScenes(sendable),
    });
    return compileExport({ profile, samples: sendable, rules: data.rules, options: { includeEvidence: false } });
  }, [exportable, sendable, data.profiles, data.analyses, data.rules]);

  /** 本轮提炼用过的题目（用来提醒“这是旧题目”）。 */
  const usedTaskTitles = useMemo(
    () =>
      Array.from(
        new Set(
          sendable
            .map((s) => findTask(data.tasks, s.taskId)?.title ?? null)
            .filter((t): t is string => t !== null),
        ),
      ),
    [sendable, data.tasks],
  );

  const looksReused = useMemo(() => {
    const trimmed = prompt.trim();
    if (trimmed === '') return false;
    if (usedTaskTitles.some((t) => trimmed.includes(t) || t.includes(trimmed))) return true;
    const head = trimmed.slice(0, 12);
    return sendable.some((s) => s.text.includes(head));
  }, [prompt, usedTaskTitles, sendable]);

  const runTryout = async () => {
    if (prompt.trim() === '') {
      setError('先写一个题目。');
      return;
    }
    if (looksReused && !freshConfirmed) {
      setError('这个题目看起来本轮提炼已经用过（和已有任务卡或样本正文重合）。对照试写必须用新题目，请换一个，或勾选确认。');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const runId = newId('try');
      const skillMarkdown = compiled.blocked ? null : compiled.skillMarkdown;
      const res = await tryout(
        {
          runId,
          prompt: prompt.trim(),
          skillMarkdown,
          targetMinChars: Math.max(1, Math.round(targetMin)),
          targetMaxChars: Math.max(Math.round(targetMin), Math.round(targetMax)),
        },
        useMock,
      );
      const pair = createABPair(res.base.text, res.withSkill.text);
      setPending({
        runId,
        prompt: prompt.trim(),
        pair,
        response: res,
        revealed: false,
        evaluationId: null,
      });
      setCloser(null);
      setTone(null);
      setRhythm(null);
      setDetail(null);
      setReason('');
      setNotice(
        `已生成 A/B 两版（各 ${res.base.chars} / ${res.withSkill.chars} 字）。评价完成前，界面不会告诉你哪一版用了 Skill。` +
          (res.mock ? '注意：这是 Mock 数据，不代表真实模型表现。' : ''),
      );
    } catch (err) {
      setError(`试写失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusy(false);
    }
  };

  const currentEvaluation = (): Evaluation | null =>
    pending && pending.evaluationId ? data.evaluations.find((e) => e.id === pending.evaluationId) ?? null : null;

  const saveEvaluation = async (revealed: boolean) => {
    if (!pending) return;
    if (closer === null) {
      setError('至少要给「哪一版更像你」一个判断（可以是「都不像」或「差不多」）。');
      return;
    }
    if (reason.trim() === '') {
      setError('请写一句理由 —— 没有理由的判断没法用来改进规则。');
      return;
    }
    const now = new Date().toISOString();
    const existing = currentEvaluation();
    const evaluation: Evaluation = {
      id: existing?.id ?? newId('eval'),
      prompt: pending.prompt,
      skillProfileId: data.profiles[0]?.id ?? null,
      skillVersion: data.profiles[0]?.version ?? null,
      base: pending.response.base,
      withSkill: pending.response.withSkill,
      abOrder: pending.pair.mapping,
      revealed,
      feedback: {
        closer,
        tone,
        rhythm,
        detail,
        reason: reason.trim(),
      },
      model: pending.response.model,
      params: pending.response.params,
      usage: pending.response.usage ?? UNKNOWN_USAGE,
      elapsedMs: pending.response.elapsedMs,
      mock: pending.response.mock,
      createdAt: existing?.createdAt ?? now,
    };
    const ok = await save('evaluations', [evaluation]);
    if (!ok) {
      setError('评价保存失败（页面顶部有具体原因）。');
      return;
    }
    setPending({ ...pending, evaluationId: evaluation.id, revealed: revealed || pending.revealed });
    setNotice(
      revealed
        ? '已保存评价，并揭示条件：上面的映射就是这一轮的真相。'
        : '已保存评价（此时仍保持盲评状态）。点「揭示条件」可以看到哪一版用了 Skill。',
    );
    setError(null);
  };

  const reveal = async () => {
    if (!pending) return;
    if (!pending.evaluationId) {
      setError('先保存评价，再揭示条件 —— 评价之前看到答案，这一轮就白做了。');
      return;
    }
    const evaluation = currentEvaluation();
    if (evaluation && !evaluation.revealed) {
      const ok = await save('evaluations', [{ ...evaluation, revealed: true }]);
      if (!ok) {
        setError('揭示状态保存失败（页面顶部有具体原因）。');
        return;
      }
    }
    setPending({ ...pending, revealed: true });
  };

  const exportBackup = () => {
    try {
      const backup: Backup = createBackup(
        {
          tasks: data.tasks,
          sourceDocuments: data.sourceDocuments,
          samples: data.samples,
          analyses: data.analyses,
          rules: data.rules,
          profiles: data.profiles,
          evaluations: data.evaluations,
          preferences: data.preferences,
        },
        { now: new Date() },
      );
      const json = serializeBackup(backup);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/gu, '-');
      downloadText(`writing-style-lab-backup-${stamp}.json`, json, 'application/json;charset=utf-8');
      setNotice('备份已开始下载。注意：备份里含你的私人正文，不要当成 Skill 分发。');
    } catch (err) {
      setError(`备份导出失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const loadBackupFile = async (file: File) => {
    try {
      const { text, encodingNote } = await readTextFile(file);
      if (encodingNote) setError(encodingNote);
      setBackupJson(text);
      setImportSummary(null);
      setOverwriteConfirmed(false);
      setImportMode('skip');
    } catch (err) {
      setError(`读取备份文件失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const backupPreview = useMemo(() => {
    if (!backupJson) return null;
    return previewImport(backupJson, {
      tasks: data.tasks,
      sourceDocuments: data.sourceDocuments,
      samples: data.samples,
      analyses: data.analyses,
      rules: data.rules,
      profiles: data.profiles,
      evaluations: data.evaluations,
      preferences: data.preferences,
    });
  }, [backupJson, data]);

  const runImport = async () => {
    if (!backupJson || !backupPreview) return;
    if (!backupPreview.ok) {
      setError('备份校验没通过，不能导入。请先修正上面列出的问题。');
      return;
    }
    if (importMode === 'overwrite' && !overwriteConfirmed) {
      setError('「覆盖」需要先勾选确认：本机现有数据会被替换。');
      return;
    }
    try {
      const result = applyImport(
        backupJson,
        {
          tasks: data.tasks,
          sourceDocuments: data.sourceDocuments,
          samples: data.samples,
          analyses: data.analyses,
          rules: data.rules,
          profiles: data.profiles,
          evaluations: data.evaluations,
          preferences: data.preferences,
        },
        importMode,
      );
      if (result.errors.length > 0 && Object.keys(result.applied).length === 0) {
        setError(`导入被拒绝：${result.errors.join('；')}`);
        return;
      }
      const written = await replaceAll({
        tasks: result.state.tasks,
        sourceDocuments: result.state.sourceDocuments,
        samples: result.state.samples,
        analyses: result.state.analyses,
        rules: result.state.rules,
        profiles: result.state.profiles,
        evaluations: result.state.evaluations,
        preferences: result.state.preferences,
      });
      if (!written) {
        setError('导入结果没能写进本地数据库（页面顶部有具体原因）。本地数据保持原样。');
        return;
      }
      setImportSummary(
        `导入完成（模式：${importMode === 'skip' ? '跳过冲突' : importMode === 'overwrite' ? '覆盖冲突' : '重复保留'}）。` +
          `写入：${Object.entries(result.applied).map(([k, v]) => `${k} ${v}`).join('、') || '无'}。` +
          `跳过：${result.skipped.length} 项。` +
          (result.errors.length > 0 ? `错误：${result.errors.join('；')}` : ''),
      );
      setError(null);
      setBackupJson(null);
    } catch (err) {
      setError(`导入失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const clearAll = async () => {
    if (!window.confirm('这会清空本机全部样本、分析、规则、试写记录与草稿，且无法撤销。建议先导出备份。继续吗？')) return;
    const typed = window.prompt('请输入「清空」两个字确认：');
    if (typed !== '清空') {
      setNotice('已取消清空。');
      return;
    }
    try {
      await db.clearEverything();
      const builtins = createBuiltinTasks(new Date().toISOString());
      const ok = await replaceAll({
        tasks: builtins,
        sourceDocuments: [],
        samples: [],
        analyses: [],
        rules: [],
        profiles: [],
        evaluations: [],
        preferences: [],
      });
      if (!ok) {
        setError('清空后重建内置任务卡失败（页面顶部有具体原因）。刷新页面可重新生成。');
        return;
      }
      setNotice('本地数据已清空，6 张内置任务卡已重新生成。');
      setPending(null);
    } catch (err) {
      setError(`清空失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const analysisRounds = useMemo(() => {
    const groups = new Map<string, typeof data.analyses>();
    for (const analysis of data.analyses) {
      const key = analysis.runId ?? '（无 runId）';
      const list = groups.get(key) ?? [];
      list.push(analysis);
      groups.set(key, list);
    }
    return Array.from(groups.entries())
      .map(([runId, list]) => ({
        runId,
        list: list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      }))
      .sort((a, b) => (a.list[0].createdAt < b.list[0].createdAt ? 1 : -1));
  }, [data.analyses]);

  return (
    <div className="panel">
      <Card        title="第 5 步 · 对照试写（新题目）"
        subtitle="用一条本轮提炼没用过的新题目，分别拿基础版和加 Skill 版写一遍，然后由你盲评。"
        actions={
          <>
            <Badge tone="info">Skill 里已接受规则 {exportable.length} 条</Badge>
            <Button disabled={busy} variant="primary" onClick={() => void runTryout()}>
              {busy ? '生成中…' : '生成 A/B 两版'}
            </Button>
          </>
        }
      >
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
        {compiled.blocked && (
          <Banner tone="warn" title="当前没有可用的 Skill 文本">
            导出被 compileExport 拒绝：{compiled.blocked.reason}。这一轮会以「无 Skill 文本」发起请求，A/B 可能没有区别。
          </Banner>
        )}
        <div className="form-grid">
          <Field label="新题目" hint="不要用本轮提炼里的题目：题目本身会拖动风格，重用会让对照失效。">
            <TextArea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：写一个雨夜等不到人的场景，300—500 字。" />
          </Field>
          <div className="form-row">
            <Field label="目标最少字数">
              <TextInput type="number" min={1} value={targetMin} onChange={(e) => setTargetMin(Number(e.target.value))} />
            </Field>
            <Field label="目标最多字数">
              <TextInput type="number" min={1} value={targetMax} onChange={(e) => setTargetMax(Number(e.target.value))} />
            </Field>
          </div>
          {looksReused && (
            <label className="checkbox">
              <input type="checkbox" checked={freshConfirmed} onChange={(e) => setFreshConfirmed(e.target.checked)} />
              我知道这看起来像用过的题目（与本轮任务卡「{usedTaskTitles.join('、') || '—'}」或样本正文重合），仍要按新题目处理
            </label>
          )}
          {usedTaskTitles.length > 0 && (
            <p className="hint-line">本轮提炼用过的题目：{usedTaskTitles.join('；')}</p>
          )}
          {status?.mockEnabled && (
            <label className="checkbox">
              <input type="checkbox" checked={useMock} onChange={(e) => setUseMock(e.target.checked)} />
              {STATIC_DEMO
                ? '试玩：用本机占位文本排一次 A/B（不联网、不花钱，只给你看界面流程，不代表真实模型表现）'
                : '本次试写显式要 Mock 数据（服务端已开 ALLOW_MOCK_ANALYSIS；只是给你看看界面流程，不代表真实模型表现）'}
            </label>
          )}
        </div>
      </Card>

      {pending && (
        <Card
          title="A/B 盲评"
          subtitle="评价之前不显示哪一版加了 Skill；这里也不会给任何暗示（顺序是随机排的）。"
          actions={
            <>
              <Badge tone={pending.revealed ? 'info' : 'warn'}>
                {pending.revealed ? '已揭示条件' : '条件隐藏中'}
              </Badge>
              <Button onClick={() => void saveEvaluation(false)}>保存评价</Button>
              <Button variant="primary" onClick={() => void reveal()}>
                揭示条件
              </Button>
            </>
          }
        >
          <div className="ab-grid">
            {pending.pair.items.map((item) => (
              <div key={item.label} className="ab-item">
                <div className="sample-row-title">
                  <strong>版本 {item.label}</strong>
                  <Badge tone="mock">AI 生成</Badge>
                  {pending.revealed && (
                    <Badge tone={revealCondition(pending.pair, item.label) === 'skill' ? 'ok' : 'neutral'}>
                      {revealCondition(pending.pair, item.label) === 'skill' ? '加了 Skill' : '基础版（无 Skill）'}
                    </Badge>
                  )}
                </div>
                <PlainText text={item.text} className="ab-text" />
              </div>
            ))}
          </div>
          <Banner tone="warn" title="这两段都是 AI 生成的">
            它们永远标记为 AI 生成，不会自动进入作者样本库；要用其中的文字，必须你自己改写后另行提交为样本。
          </Banner>
          <div className="form-grid">
            <PickRow label="哪一版更像你写的东西？" value={closer} onChange={setCloser} />
            <PickRow label="语气" value={tone} onChange={setTone} allowEmpty />
            <PickRow label="节奏" value={rhythm} onChange={setRhythm} allowEmpty />
            <PickRow label="细节" value={detail} onChange={setDetail} allowEmpty />
            <Field label="理由（必填）">
              <TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：A 的句子更长，但我在对话场景里不会连续用形容词……" />
            </Field>
          </div>
          {pending.revealed && (
            <Banner tone="info" title="条件映射">
              A = {pending.pair.mapping.A === 'skill' ? '加了 Skill' : '基础版'}；B ={' '}
              {pending.pair.mapping.B === 'skill' ? '加了 Skill' : '基础版'}。模型 {pending.response.model}，
              温度 {pending.response.params.temperature}，最大 token {pending.response.params.maxTokens}，
              用量 {formatUsage(pending.response.usage)}，耗时 {pending.response.elapsedMs} ms
              {pending.response.mock ? '（Mock 数据）' : ''}。
            </Banner>
          )}
          <p className="hint-line">
            一次 A/B 不能证明效果：它只说明“这一次、这个题目、这个模型”下的阅读感受，样本量是 1。别据此推断 Skill 一定更好。
          </p>
        </Card>
      )}

      <Card title="历史版本" subtitle="分析轮次、规则决定与试写记录都留着，方便你回头核对当时的判断。">
        <h4 className="sub-title">分析轮次（{analysisRounds.length} 轮）</h4>
        {analysisRounds.length === 0 ? (
          <EmptyHint>还没有分析记录。</EmptyHint>
        ) : (
          <ul className="plain-list">
            {analysisRounds.map((round) => {
              const ok = round.list.filter((a) => a.status === 'ok').length;
              const partial = round.list.filter((a) => a.status === 'partial').length;
              const rejected = round.list.filter((a) => a.status === 'rejected').length;
              const mock = round.list.some((a) => a.mock);
              return (
                <li key={round.runId}>
                  <strong>{round.runId}</strong>：{round.list.length} 篇（全部通过 {ok} / 部分通过 {partial} / 被拒绝 {rejected}），
                  最近一次 {formatTime(round.list[0].createdAt)}
                  {mock ? ' · 含 Mock' : ''}
                  <br />
                  <span className="hint-line">
                    样本：{round.list.map((a) => `${a.sampleId.slice(-6)} r${a.sampleRevision}`).join('、')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <h4 className="sub-title">规则历史（{data.rules.length} 条）</h4>
        {data.rules.length === 0 ? (
          <EmptyHint>还没有规则记录。</EmptyHint>
        ) : (
          <ul className="plain-list">
            {data.rules
              .slice()
              .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
              .map((rule) => (
                <li key={rule.id}>
                  [{rule.decision === 'accepted' ? '已接受' : rule.decision === 'rejected' ? '已拒绝' : '待确认'}
                  {rule.stale ? ' · 需重新确认' : ''}] {rule.statement}
                  <br />
                  <span className="hint-line">
                    {RULE_SCOPE_LABEL[rule.scope]} · 来源 {rule.origin === 'preference' ? '你的指定' : '样本归纳'} · 决定于{' '}
                    {formatTime(rule.decidedAt)} · {rule.derivedFrom.runId ?? '（无 runId）'}
                    {rule.mock ? ' · Mock' : ''}
                  </span>
                </li>
              ))}
          </ul>
        )}

        <h4 className="sub-title">Profile 版本（{data.profiles.length} 个）</h4>
        {data.profiles.length === 0 ? (
          <EmptyHint>还没有导出版本。每次导出都会在这里留下一条记录。</EmptyHint>
        ) : (
          <ul className="plain-list">
            {data.profiles
              .slice()
              .sort((a, b) => b.version - a.version)
              .map((profile) => (
                <li key={profile.id}>
                  v{profile.version} · {profile.rules.length} 条规则 · 样本 {profile.sampleSnapshot.length} 篇 ·{' '}
                  {formatTime(profile.createdAt)}
                  {profile.mock ? ' · Mock' : ''}
                  {profile.coveredScenes.length > 0 ? ` · 场景：${profile.coveredScenes.join('、')}` : ''}
                </li>
              ))}
          </ul>
        )}

        <h4 className="sub-title">试写记录（{data.evaluations.length} 次）</h4>
        {data.evaluations.length === 0 ? (
          <EmptyHint>还没有试写记录。</EmptyHint>
        ) : (
          <ul className="plain-list">
            {data.evaluations
              .slice()
              .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
              .map((evaluation) => (
                <li key={evaluation.id}>
                  「{evaluation.prompt}」· A={evaluation.abOrder.A === 'skill' ? 'Skill' : '基础'} / B=
                  {evaluation.abOrder.B === 'skill' ? 'Skill' : '基础'} ·{' '}
                  {evaluation.feedback
                    ? `更像：${PICK_LABEL[evaluation.feedback.closer]}（语气 ${evaluation.feedback.tone ? PICK_LABEL[evaluation.feedback.tone] : '未评'}，节奏 ${
                        evaluation.feedback.rhythm ? PICK_LABEL[evaluation.feedback.rhythm] : '未评'
                      }，细节 ${evaluation.feedback.detail ? PICK_LABEL[evaluation.feedback.detail] : '未评'}）`
                    : '未评价'}
                  <br />
                  <span className="hint-line">
                    {evaluation.revealed ? '已揭示' : '未揭示'} · {evaluation.model} · 用量{' '}
                    {formatUsage(evaluation.usage)} · {formatTime(evaluation.createdAt)}
                    {evaluation.mock ? ' · Mock' : ''}
                  </span>
                  {evaluation.feedback && <p className="hint-line">理由：{evaluation.feedback.reason}</p>}
                </li>
              ))}
          </ul>
        )}
        <p className="hint-line">
          一次 A/B 不能证明效果：这里的每一行都只是“一次阅读感受”，不构成统计结论。
        </p>
      </Card>

      <Card
        title="设置 · 本地服务状态"
        subtitle="API Key 只存在服务端；前端不保存、不显示密钥。"
        actions={<Button onClick={() => void refreshStatus()}>刷新状态</Button>}
      >
        {status === null ? (
          <Banner tone="warn" title="读不到服务状态">
            {statusError ?? '本地服务没有响应。请确认本地服务已启动（开发模式会由 Vite 代理 /api）。'}
          </Banner>
        ) : (
          <>
            {!status.apiKeyConfigured && (
              <Banner tone="danger" title="未配置真实分析">
                服务端没有读到 API Key，分析/归纳请求会被拒绝（错误码 CONFIG_MISSING_KEY）。上面对话框里显示的结果只可能来自 Mock。
              </Banner>
            )}
            <div className="stat-row">
              {status.mockEnabled ? <Badge tone="mock">Mock 模式开启</Badge> : <Badge tone="ok">Mock 关闭</Badge>}
              <Badge tone={status.apiKeyConfigured ? 'ok' : 'danger'}>
                {status.apiKeyConfigured ? 'API Key 已配置（前端不可见）' : 'API Key 未配置'}
              </Badge>
              <Badge tone="neutral">模型 {status.model}</Badge>
              <Badge tone="neutral">prompt {status.promptVersion}</Badge>
            </div>
            <KeyValue
              items={[
                { key: '单篇上限', value: `${status.limits.maxCharsPerSample} 字（含标点）` },
                { key: '单批样本数上限', value: `${status.limits.maxSamplesPerBatch} 篇` },
                { key: '单批总量上限', value: `${status.limits.maxTotalCharsPerBatch} 字` },
                { key: '重试额度', value: `${status.limits.maxExtraRetriesPerBatch} 次/批` },
                { key: '目标字数区间', value: `${status.limits.targetMinChars}—${status.limits.targetMaxChars} 字` },
                { key: '价格说明', value: status.priceNote ?? '未知（服务端未配置估价）' },
                { key: '前端工具版本', value: `${APP_VERSION}（数据 schemaVersion / prompt ${PROMPT_VERSION}）` },
              ]}
            />
          </>
        )}
      </Card>

      <Card
        title="设置 · 备份导出 / 导入"
        subtitle="备份包含你的私人正文（samples/sourceDocuments），和导出给别人用的 Skill 完全是两回事。"
        actions={
          <>
            <Button variant="primary" onClick={exportBackup}>
              导出备份 JSON
            </Button>
            <Button onClick={() => backupFileRef.current?.click()}>选择备份文件（先校验、先预览）</Button>
            <input
              ref={backupFileRef}
              type="file"
              accept="application/json,.json"
              className="hidden-file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void loadBackupFile(file);
              }}
            />
          </>
        }
      >
        <Banner tone="warn" title="备份 ≠ Skill">
          备份里含私人正文，只适合放在你自己的机器上（或你自己的私有备份里）；导出给别人的只有 SKILL.md / style-profile.json，
          以及你自己勾选后才生成的短摘录。
        </Banner>
        {importSummary && (
          <Banner tone="ok" onDismiss={() => setImportSummary(null)}>
            {importSummary}
          </Banner>
        )}
        {backupPreview === null ? (
          <EmptyHint>还没有选择备份文件。导入之前一定会先给你看预览，不会静默覆盖。</EmptyHint>
        ) : (
          <div className="import-preview">
            <div className="stat-row">
              <Badge tone={backupPreview.ok ? 'ok' : 'danger'}>
                {backupPreview.ok ? '校验通过（还没写入）' : '校验未通过'}
              </Badge>
              <Badge tone="neutral">schemaVersion {backupPreview.schemaVersion ?? '未知'}</Badge>
              {backupPreview.containsFullText && <Badge tone="warn">含完整正文</Badge>}
              <Badge tone="neutral">冲突 {backupPreview.conflicts.length} 项</Badge>
            </div>
            {backupPreview.errors.length > 0 && (
              <Banner tone="danger" title="校验错误">
                <ul className="plain-list">
                  {backupPreview.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </Banner>
            )}
            {backupPreview.counts && (
              <KeyValue
                items={Object.entries(backupPreview.counts).map(([key, value]) => ({
                  key,
                  value: String(value),
                }))}
              />
            )}
            {backupPreview.conflicts.length > 0 && (
              <details className="details" open>
                <summary>与本机现有数据的冲突（{backupPreview.conflicts.length}）</summary>
                <ul className="plain-list">
                  {backupPreview.conflicts.map((c, i) => (
                    <li key={i}>
                      {c.kind} · {c.id}：{c.note}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="radio-row">
              {(['skip', 'overwrite', 'duplicate'] as const).map((mode) => (
                <label key={mode} className="radio">
                  <input
                    type="radio"
                    checked={importMode === mode}
                    onChange={() => {
                      setImportMode(mode);
                      setOverwriteConfirmed(false);
                    }}
                  />
                  {mode === 'skip' ? '跳过冲突（保留本机现有条目）' : mode === 'overwrite' ? '覆盖冲突（用备份的版本替换本机）' : '重复保留（备份条目另存为副本）'}
                </label>
              ))}
            </div>
            {importMode === 'overwrite' && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={overwriteConfirmed}
                  onChange={(e) => setOverwriteConfirmed(e.target.checked)}
                />
                我确认用备份里的版本覆盖本机同 id 的条目
              </label>
            )}
            <div className="form-actions">
              <Button variant="primary" disabled={!backupPreview.ok} onClick={() => void runImport()}>
                按上面的模式导入
              </Button>
              <Button
                onClick={() => {
                  setBackupJson(null);
                  setImportSummary(null);
                }}
              >
                放弃这次导入
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card title="设置 · 危险操作" subtitle="这些操作不会询问服务端，直接就动本机数据。">
        <div className="form-actions">
          <Button variant="danger" onClick={() => void clearAll()}>
            清空本机全部数据（含草稿）
          </Button>
          <Button
            onClick={async () => {
              try {
                const draft = await readDraft('draft:free');
                setNotice(draft.trim() === '' ? '自由草稿是空的。' : `自由草稿当前 ${draft.length} 个字符。`);
              } catch (err) {
                setError(`读取草稿失败：${err instanceof Error ? err.message : '未知错误'}`);
              }
            }}
          >
            检查自由草稿
          </Button>
          <Button onClick={() => onNavigate('rules')}>回规则页</Button>
        </div>
      </Card>
    </div>
  );
}

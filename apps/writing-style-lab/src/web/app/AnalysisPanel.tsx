/**
 * 区域 4：分析进度、结果与原文依据。
 * - 先给作者看「这一批要发什么、为什么不发某几篇、最多会调用几次」；
 * - 点分析后逐篇顺序处理，逐项显示状态：进行中 / 成功 / 被拒绝及原因；
 * - 已有可用分析（revision + contentHash 都对得上）直接缓存命中，不重发；
 * - 结果里每条观察都能点开原文依据，并把对应段落高亮出来。
 */
import { useMemo, useState } from 'react';
import {
  CONSTRAINT_INFLUENCE_LABEL,
  DIMENSION_LABEL,
  SOURCE_TYPE_LABEL,
  type DistillSampleInput,
  type RejectedObservation,
  type Sample,
  type SampleAnalysis,
  type StyleRule,
} from '../../shared/schema';
import {
  MAX_CHARS_PER_SAMPLE,
  MAX_EXTRA_RETRIES_PER_BATCH,
  MAX_SAMPLES_PER_BATCH,
  MAX_TOTAL_CHARS_PER_BATCH,
  PROMPT_VERSION,
} from '../../shared/limits';
import { checkLengthLimits, countChars } from '../../shared/text';
import { crossCheckClaims } from '../../shared/stylometry';
import { describeExclusion, selectSendableSamples } from '../../shared/rules';
import { isAnalysisUsable } from '../../shared/verify';
import { ApiClientError, analyzeSample, distill } from '../api';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyHint,
  KeyValue,
  OBSERVATION_SCOPE_LABEL,
  formatUsage,
  newId,
  type PanelNavProps,
} from './common';
import { SampleTextView } from './SampleTextView';
import { LimitationList, StylometryView, useStylometryOf } from './StylometryView';
import {
  analysisStatusOf,
  findTask,
  sampleTitle,
  useLab,
} from './store';

export interface AnalysisPanelProps extends PanelNavProps {
  onSelectTask: (taskId: string | null) => void;
}

type Phase = 'pending' | 'running' | 'ok' | 'rejected' | 'skipped' | 'cached';

/**
 * 「程序统计与这条说法不一致」的识别与展示统一放在 ./StylometryView（LimitationList）里，
 * 保证分析结果与规则卡用的是同一套警示样式，也不会在这里出现第二份正则。
 */
interface ItemProgress {
  phase: Phase;
  message: string;
}

const PHASE_LABEL: Record<Phase, string> = {
  pending: '排队中',
  running: '进行中',
  ok: '成功',
  rejected: '被拒绝',
  skipped: '未发送',
  cached: '缓存命中',
};

const PHASE_TONE: Record<Phase, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = {
  pending: 'neutral',
  running: 'info',
  ok: 'ok',
  rejected: 'danger',
  skipped: 'warn',
  cached: 'ok',
};

export function AnalysisPanel({ onNavigate, onSelectTask }: AnalysisPanelProps) {
  const { data, status, save } = useLab();
  const [progress, setProgress] = useState<Record<string, ItemProgress>>({});
  const [running, setRunning] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ sampleId: string; paragraphId: string; quote: string } | null>(null);
  const [rejectedCandidates, setRejectedCandidates] = useState<RejectedObservation[]>([]);
  /** 只有服务端明确开了 Mock 开关时，才把这个选项放出来（默认不勾）。 */
  const [useMock, setUseMock] = useState(false);

  const limits = useMemo(
    () => ({
      maxCharsPerSample: status?.limits.maxCharsPerSample ?? MAX_CHARS_PER_SAMPLE,
      maxSamplesPerBatch: status?.limits.maxSamplesPerBatch ?? MAX_SAMPLES_PER_BATCH,
      maxTotalCharsPerBatch: status?.limits.maxTotalCharsPerBatch ?? MAX_TOTAL_CHARS_PER_BATCH,
      maxExtraRetriesPerBatch: status?.limits.maxExtraRetriesPerBatch ?? MAX_EXTRA_RETRIES_PER_BATCH,
    }),
    [status],
  );

  const sendable = useMemo(() => selectSendableSamples(data.samples), [data.samples]);
  const excluded = useMemo(
    () =>
      data.samples
        .map((sample) => ({ sample, reason: describeExclusion(sample) }))
        .filter((row): row is { sample: Sample; reason: string } => row.reason !== null),
    [data.samples],
  );

  const queue = useMemo(
    () => sendable.filter((sample) => !analysisStatusOf(sample, data.analyses).usable),
    [sendable, data.analyses],
  );

  const violations = useMemo(
    () => checkLengthLimits(sendable.map((s) => ({ chars: countChars(s.text) })), limits),
    [sendable, limits],
  );

  const plannedCalls = queue.length + 1 + limits.maxExtraRetriesPerBatch;
  const analysesForSendable = useMemo(
    () => data.analyses.filter((a) => sendable.some((s) => s.id === a.sampleId)),
    [data.analyses, sendable],
  );

  const selectedSample = useMemo(() => {
    const bySelection = selectedSampleId ? data.samples.find((s) => s.id === selectedSampleId) : undefined;
    if (bySelection) return bySelection;
    return sendable.find((s) => analysisStatusOf(s, data.analyses).usable) ?? sendable[0] ?? null;
  }, [selectedSampleId, data.samples, data.analyses, sendable]);

  const selectedAnalyses = useMemo(
    () =>
      selectedSample
        ? data.analyses
            .filter((a) => a.sampleId === selectedSample.id)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        : [],
    [selectedSample, data.analyses],
  );

  /**
   * 旧分析可能没有存档 stylometry（schema 里是可选的）。这时如果它对应的正文版本和当前一致，
   * 就用同一份 shared/stylometry.ts 现算一份，并明确标注「现算」而不是冒充存档值。
   */
  const fallbackStylometry = useStylometryOf(selectedSample ? selectedSample.text : null);

  const runAnalysis = async () => {
    if (queue.length === 0) {
      setRunNote('没有需要新分析的样本：全部都是缓存命中，不重发。');
      return;
    }
    if (violations.length > 0) {
      setError(
        `这批样本过不了长度门槛，先按提示调整（${violations.map((v) => v.message).join('；')}）。服务端会再验一次，前端不硬发。`,
      );
      return;
    }
    setRunning(true);
    setError(null);
    setRunNote(null);
    const runId = newId('run');
    const next: Record<string, ItemProgress> = {};
    for (const sample of queue) next[sample.id] = { phase: 'pending', message: '排队中' };
    setProgress(next);

    let okCount = 0;
    let failCount = 0;
    for (const sample of queue) {
      setProgress((prev) => ({ ...prev, [sample.id]: { phase: 'running', message: '已发送，等待返回…' } }));
      const task = findTask(data.tasks, sample.taskId);
      try {
        const res = await analyzeSample(
          {
            runId,
            taskId: sample.taskId,
            sampleId: sample.id,
            sampleRevision: sample.revision,
            contentHash: sample.contentHash,
            text: sample.text,
            sourceType: sample.sourceType,
            sceneTags: sample.sceneTags,
            backgroundContext: sample.backgroundContext,
            taskConstraints: task?.constraints ?? [],
            taskConstraintsHash: sample.taskConstraintsHash,
            constraintKnown: sample.entryMode === 'task' && task !== null,
          },
          useMock,
        );
        const saved = await save('analyses', [res.analysis]);
        if (!saved) {
          setProgress((prev) => ({
            ...prev,
            [sample.id]: { phase: 'rejected', message: '分析已返回，但写入本地数据库失败（页面顶部有原因）。' },
          }));
          failCount += 1;
          continue;
        }
        const usable = isAnalysisUsable(res.analysis);
        if (usable) okCount += 1;
        else failCount += 1;
        setProgress((prev) => ({
          ...prev,
          [sample.id]: {
            phase: usable ? 'ok' : 'rejected',
            message: usable
              ? `成功：${res.analysis.observations.length} 条观察${
                  res.analysis.rejectedObservations.length > 0
                    ? `，另有 ${res.analysis.rejectedObservations.length} 条因引用不通过被丢弃`
                    : ''
                }`
              : `被拒绝：${res.analysis.errorCode ?? '未知'} ${res.analysis.errorMessage ?? ''}`,
          },
        }));
      } catch (err) {
        failCount += 1;
        const detail =
          err instanceof ApiClientError
            ? `${err.errorCode}：${err.message}${err.retryable ? '（可重试）' : ''}`
            : err instanceof Error
              ? err.message
              : '未知错误';
        setProgress((prev) => ({ ...prev, [sample.id]: { phase: 'rejected', message: `被拒绝：${detail}` } }));
      }
    }
    setRunning(false);
    setRunNote(
      `本轮结束：成功 ${okCount} 篇，被拒绝 ${failCount} 篇，缓存命中未重发 ${sendable.length - queue.length} 篇。详细原因见下面的逐项状态。`,
    );
  };

  const runDistill = async () => {
    const usable = sendable
      .map((sample) => ({ sample, analysis: analysisStatusOf(sample, data.analyses) }))
      .filter((row) => row.analysis.usable && row.analysis.latest !== null)
      .map((row) => ({ sample: row.sample, analysis: row.analysis.latest as SampleAnalysis }));
    if (usable.length === 0) {
      setError('还没有任何可用的单篇分析，先做分析再归纳。');
      return;
    }
    setDistilling(true);
    setError(null);
    setRunNote(null);
    const runId = newId('run');
    try {
      const inputs: DistillSampleInput[] = usable.map(({ sample, analysis }) => ({
        sampleId: sample.id,
        revision: sample.revision,
        contentHash: sample.contentHash,
        entryMode: sample.entryMode,
        originDocumentId: sample.sourceDocumentId,
        sourceType: sample.sourceType,
        sceneTags: sample.sceneTags,
        chars: countChars(sample.text),
        authorNote: sample.authorNote,
        backgroundContext: sample.backgroundContext,
        // 只给归纳阶段用于判断样本是否近似重复的正文开头，按码点取，避免把扩展字符劈开。
        textSample: Array.from(sample.text).slice(0, 200).join(''),
        taskConstraints: findTask(data.tasks, sample.taskId)?.constraints ?? [],
        constraintKnown: sample.entryMode === 'task' && sample.taskId !== null,
        holdout: sample.holdout,
        partial: sample.partial,
        analysis,
      }));
      const res = await distill(
        {
          runId,
          samples: inputs,
          preferences: data.preferences
            .filter((p) => usable.some((u) => u.sample.id === p.sampleId))
            .map((p) => ({
              id: p.id,
              sampleId: p.sampleId,
              paragraphId: p.paragraphId,
              kind: p.kind,
              quote: p.quote,
              note: p.note,
            })),
          previousRules: data.rules.map((r) => ({ id: r.id, statement: r.statement, decision: r.decision })),
        },
        useMock,
      );
      const now = new Date().toISOString();
      const rules: StyleRule[] = res.candidates.map((candidate) => ({
        id: newId(`rule${candidate.candidateIndex}`),
        statement: candidate.statement,
        scope: candidate.scope,
        origin: candidate.origin,
        evidence: candidate.evidence,
        counterEvidence: candidate.counterEvidence,
        supportDescription: candidate.supportDescription,
        limitations: candidate.limitations,
        constraintInfluence: candidate.constraintInfluence,
        decision: 'pending',
        statementOriginal: null,
        userEditReason: null,
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
        derivedFrom: {
          model: res.model,
          promptVersion: res.promptVersion,
          runId,
          candidateIndex: candidate.candidateIndex,
        },
        stale: false,
        staleReason: null,
        mock: res.mock,
      }));
      const saved = rules.length === 0 ? true : await save('rules', rules);
      setRejectedCandidates(res.rejectedCandidates);
      setRunNote(
        `归纳完成：候选规则 ${rules.length} 条${res.rejectedCandidates.length > 0 ? `，另有 ${res.rejectedCandidates.length} 条候选被拒` : ''}。` +
          `用量 ${formatUsage(res.usage)}，耗时 ${res.elapsedMs} ms${res.mock ? '（Mock 数据，不能导出为正式 Skill）' : ''}。` +
          (saved ? '去「规则与 Skill」页逐条确认。' : '但本地写入失败（页面顶部有原因）。'),
      );
      if (!saved) setError('候选规则写入本地数据库失败（页面顶部有具体原因）。');
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? `归纳失败：${err.errorCode}：${err.message}`
          : `归纳失败：${err instanceof Error ? err.message : '未知错误'}`,
      );
    } finally {
      setDistilling(false);
    }
  };

  const analyzeOne = async (sample: Sample, task = findTask(data.tasks, sample.taskId)) => {
    setError(null);
    try {
      const res = await analyzeSample(
        {
          runId: newId('run'),
          taskId: sample.taskId,
          sampleId: sample.id,
          sampleRevision: sample.revision,
          contentHash: sample.contentHash,
          text: sample.text,
          sourceType: sample.sourceType,
          sceneTags: sample.sceneTags,
          backgroundContext: sample.backgroundContext,
          taskConstraints: task?.constraints ?? [],
          taskConstraintsHash: sample.taskConstraintsHash,
          constraintKnown: sample.entryMode === 'task' && task !== null,
        },
        useMock,
      );
      const saved = await save('analyses', [res.analysis]);
      setRunNote(
        saved
          ? `单篇重跑完成：状态 ${res.analysis.status}，观察 ${res.analysis.observations.length} 条。`
          : '单篇重跑返回了结果，但本地写入失败。',
      );
    } catch (err) {
      setError(
        err instanceof ApiClientError ? `单篇重跑失败：${err.errorCode}：${err.message}` : '单篇重跑失败：未知错误',
      );
    }
  };

  return (
    <div className="panel">
      <Card
        title="第 1 步 · 待发送清单"
        subtitle="默认只发送「本人本次写作 / 本人旧文」、已入选、非保留样本的篇目。"
        actions={
          <>
            <Button variant="primary" disabled={running} onClick={() => void runAnalysis()}>
              {running ? '分析进行中…' : `开始逐篇分析（${queue.length} 篇）`}
            </Button>
            <Button disabled={distilling} onClick={() => void runDistill()}>
              {distilling ? '归纳中…' : '只做归纳（跳过新分析）'}
            </Button>
          </>
        }
      >
        <div className="stat-row">
          <Badge tone="info">本轮计划最多调用 {plannedCalls} 次</Badge>
          <span className="hint-inline">
            = 新样本 {queue.length} 次 + 1 次归纳 + {limits.maxExtraRetriesPerBatch} 次重试额度
          </span>
          <Badge tone="ok">缓存命中 {sendable.length - queue.length} 篇（不重发）</Badge>
          <Badge tone="neutral">
            总计 {sendable.reduce((acc, s) => acc + countChars(s.text), 0)} 字 / 上限 {limits.maxTotalCharsPerBatch}
          </Badge>
          {status?.mockEnabled && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={useMock}
                onChange={(e) => setUseMock(e.target.checked)}
              />
              本次请求显式要 Mock 数据（服务端已开 ALLOW_MOCK_ANALYSIS；结果不能导出为 Skill）
            </label>
          )}
        </div>
        {useMock && (
          <Banner tone="mock" title="这一轮会拿 Mock 数据">
            请求体里带了 mock:true，返回的是服务端模拟数据。它会照常写入本地库并打上 Mock 徽章，
            但含 Mock 的结果一律不能导出为正式作者 Skill。
          </Banner>
        )}

        {runNote && (
          <Banner tone="ok" onDismiss={() => setRunNote(null)}>
            {runNote}{' '}
            <Button variant="ghost" onClick={() => onNavigate('rules')}>
              去「规则与 Skill」页
            </Button>
          </Banner>
        )}
        {error && (
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        {violations.length > 0 && (
          <Banner tone="danger" title="长度门槛未通过（不会发出去）">
            <ul className="plain-list">
              {violations.map((v) => (
                <li key={v.code + v.message}>{v.message}</li>
              ))}
            </ul>
          </Banner>
        )}

        {sendable.length === 0 ? (
          <EmptyHint>
            暂无可发送样本。只有来源为「本人本次写作 / 本人旧文」、已选中、非保留样本的篇目才会进入这一批。
          </EmptyHint>
        ) : (
          <ul className="send-list">
            {sendable.map((sample) => {
              const st = analysisStatusOf(sample, data.analyses);
              const item = progress[sample.id];
              const note = findTask(data.tasks, sample.taskId);
              return (
                <li key={sample.id} className="send-row">
                  <div className="send-row-main">
                    <strong>{sampleTitle(sample, data)}</strong>
                    <div className="sample-row-meta">
                      <span>{countChars(sample.text)} 字（含标点）</span>
                      <span>{SOURCE_TYPE_LABEL[sample.sourceType]}</span>
                      <span>{sample.entryMode === 'task' ? `题目：${note?.title ?? '任务卡已删'}` : '直接采样（约束未知）'}</span>
                      <span>r{sample.revision}</span>
                      {sample.fragment && (
                        <span>
                          片段 {sample.fragment.fragmentIndex}/{sample.fragment.fragmentCount}
                        </span>
                      )}
                    </div>
                    {st.usable && <Badge tone="ok">已有可用分析（缓存命中，不重发）</Badge>}
                    {st.rejected && <Badge tone="danger">上次分析被拒绝，本轮会重试</Badge>}
                    {st.outdated && <Badge tone="warn">分析过期（正文或版本变了）</Badge>}
                  </div>
                  <div className="send-row-actions">
                    {item && <Badge tone={PHASE_TONE[item.phase]}>{PHASE_LABEL[item.phase]}</Badge>}
                    <Button onClick={() => setSelectedSampleId(sample.id)}>看结果</Button>
                    <Button disabled={running} onClick={() => void analyzeOne(sample)}>
                      单篇重跑
                    </Button>
                    <Button
                      onClick={() => {
                        onSelectTask(sample.taskId);
                        onNavigate('editor');
                      }}
                    >
                      去改
                    </Button>
                  </div>
                  {item && item.message && <p className="hint-line">{item.message}</p>}
                </li>
              );
            })}
          </ul>
        )}

        {excluded.length > 0 && (
          <>
            <h4 className="sub-title">不发送的样本（{excluded.length} 篇）</h4>
            <ul className="plain-list">
              {excluded.map(({ sample, reason }) => (
                <li key={sample.id}>
                  {sampleTitle(sample, data)}（r{sample.revision}，{countChars(sample.text)} 字）：{reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card
        title="第 2 步 · 分析结果与原文依据"
        subtitle="每条观察都可以点开原文依据；点证据会把对应段落高亮出来。程序只保留引用能逐字对上的观察。"
      >
        {analysesForSendable.length === 0 ? (
          <EmptyHint>还没有分析结果。</EmptyHint>
        ) : (
          <div className="result-layout">
            <div className="result-list">
              <ul className="plain-list">
                {sendable
                  .filter((sample) => data.analyses.some((a) => a.sampleId === sample.id))
                  .map((sample) => {
                    const st = analysisStatusOf(sample, data.analyses);
                    return (
                      <li key={sample.id}>
                        <button
                          type="button"
                          className={selectedSample && selectedSample.id === sample.id ? 'link-btn link-btn-active' : 'link-btn'}
                          onClick={() => {
                            setSelectedSampleId(sample.id);
                            setFocus(null);
                          }}
                        >
                          {sampleTitle(sample, data)}（r{sample.revision}）
                        </button>{' '}
                        {st.usable && <Badge tone="ok">{st.latest?.observations.length ?? 0} 条观察</Badge>}
                        {st.rejected && <Badge tone="danger">被拒绝</Badge>}
                        {st.outdated && <Badge tone="warn">过期</Badge>}
                        {st.mock && <Badge tone="mock">Mock</Badge>}
                      </li>
                    );
                  })}
              </ul>
            </div>
            <div className="result-detail">
              {selectedSample === null ? (
                <EmptyHint>选中一篇样本查看详情。</EmptyHint>
              ) : selectedAnalyses.length === 0 ? (
                <EmptyHint>这篇样本还没有分析记录。</EmptyHint>
              ) : (
                selectedAnalyses.map((analysis) => (
                  <div key={analysis.id} className="analysis-block">
                    <div className="sample-row-title">
                      <strong>分析 {analysis.id}</strong>
                      <Badge tone={analysis.status === 'ok' ? 'ok' : analysis.status === 'partial' ? 'warn' : 'danger'}>
                        {analysis.status === 'ok' ? '全部通过' : analysis.status === 'partial' ? '部分通过' : '被拒绝'}
                      </Badge>
                      {analysis.mock && <Badge tone="mock">Mock</Badge>}
                      <span className="hint-inline">{analysis.model}</span>
                    </div>
                    <KeyValue
                      items={[
                        { key: '字数（含标点）', value: analysis.stats.chars },
                        { key: '段落 / 句', value: `${analysis.stats.paragraphs} / ${analysis.stats.sentences}` },
                        { key: '平均句长', value: `${analysis.stats.avgSentenceChars} 字` },
                        { key: '对白占比', value: `${Math.round(analysis.stats.dialogueCharRatio * 100)}%` },
                        { key: '温度 / 最大 token', value: `${analysis.temperature} / ${analysis.maxTokens}` },
                        { key: 'prompt 版本', value: analysis.promptVersion },
                        { key: '用量', value: formatUsage(analysis.usage) },
                        { key: '调用次数', value: analysis.attempts ? `${analysis.attempts} 次（含重试）` : '未知' },
                        { key: '耗时', value: `${analysis.elapsedMs} ms` },
                        { key: 'runId', value: analysis.runId ?? '—' },
                      ]}
                    />
                    {analysis.errorCode && (
                      <Banner tone="danger" title={`错误码 ${analysis.errorCode}`}>
                        {analysis.errorMessage ?? '（无补充说明）'}
                      </Banner>
                    )}
                    {(() => {
                      // stylometry 是可选字段（旧数据可能没有，也可能显式为 null）——两种都要保护。
                      const stored = analysis.stylometry ?? null;
                      const matchesCurrent =
                        analysis.sampleRevision === selectedSample.revision &&
                        analysis.contentHash === selectedSample.contentHash;
                      const stats = stored ?? (matchesCurrent ? fallbackStylometry : null);
                      if (stats === null) {
                        return (
                          <p className="hint-line">
                            这条分析没有本地统计（旧数据），而且它对应的正文版本已经变了，现算的数字对不上这次分析，因此不显示。
                          </p>
                        );
                      }
                      return (
                        <StylometryView
                          stylometry={stats}
                          title="程序统计（本地对同一份正文算出的实测值，不是模型判断）"
                          note={
                            stored
                              ? '这些数字在调用模型之前就已经算出来了；模型的观察会拿它们对照，对不上的地方会在「局限」里标出来。'
                              : '这条分析没有存档统计（旧数据）；下面是用当前正文现算的一份（正文版本与这次分析一致）。'
                          }
                        />
                      );
                    })()}
                    <ul className="obs-list">
                      {analysis.observations.map((obs) => {
                        // 服务端可能已经把「与实测不一致」写进 limitations；这里再用同一份本地统计核一遍，
                        // 两边说法一致时 LimitationList 会自动去重，不会出现重复条目。
                        const stats =
                          analysis.stylometry ?? (analysis.sampleRevision === selectedSample.revision &&
                          analysis.contentHash === selectedSample.contentHash
                            ? fallbackStylometry
                            : null);
                        const crossChecks = stats ? crossCheckClaims(obs.claim, obs.dimension, stats) : [];
                        return (
                        <li key={obs.id} className="obs-card">
                          <div className="obs-head">
                            <Badge tone="info">{DIMENSION_LABEL[obs.dimension]}</Badge>
                            <Badge tone="neutral">{OBSERVATION_SCOPE_LABEL[obs.scope]}</Badge>
                            <Badge
                              tone={
                                obs.constraintInfluence === 'author_choice'
                                  ? 'ok'
                                  : obs.constraintInfluence === 'unknown'
                                    ? 'warn'
                                    : 'neutral'
                              }
                            >
                              约束影响：{CONSTRAINT_INFLUENCE_LABEL[obs.constraintInfluence]}
                            </Badge>
                            {crossChecks.length > 0 && (
                              <Badge tone="danger">与本地实测不一致 {crossChecks.length} 处</Badge>
                            )}
                          </div>
                          <p className="obs-claim">{obs.claim}</p>
                          <LimitationList limitations={[...obs.limitations, ...crossChecks]} />
                          <div className="obs-evidence">
                            <span className="field-label">原文依据（点击高亮）</span>
                            {obs.evidence.map((e) => (
                              <button
                                key={`${e.sampleId}-${e.paragraphId}-${e.quote}`}
                                type="button"
                                className="quote-btn"
                                onClick={() => {
                                  setSelectedSampleId(e.sampleId);
                                  setFocus({ sampleId: e.sampleId, paragraphId: e.paragraphId, quote: e.quote });
                                }}
                              >
                                {e.paragraphId}：「{e.quote}」
                              </button>
                            ))}
                          </div>
                        </li>
                        );
                      })}
                    </ul>
                    {analysis.rejectedObservations.length > 0 && (
                      <details className="details">
                        <summary>被丢弃的观察（{analysis.rejectedObservations.length} 条）及原因</summary>
                        <ul className="plain-list">
                          {analysis.rejectedObservations.map((r, i) => (
                            <li key={i}>{r.reason}</li>
                          ))}
                        </ul>
                        <p className="hint-line">
                          这些观察没有进入规则依据 —— 引用必须逐字出现在对应段落里，对不上就丢弃，不修补。
                        </p>
                      </details>
                    )}
                  </div>
                ))
              )}

              {selectedSample && selectedAnalyses.length > 0 && (
                <div className="evidence-pane">
                  <h4 className="sub-title">
                    原文（{sampleTitle(selectedSample, data)} r{selectedSample.revision}）· 点击证据后对应段落高亮
                  </h4>
                  <SampleTextView
                    sample={selectedSample}
                    marks={data.preferences.filter((p) => p.sampleId === selectedSample.id)}
                    highlight={focus && focus.sampleId === selectedSample.id ? focus : null}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {rejectedCandidates.length > 0 && (
          <details className="details">
            <summary>上一轮归纳里被拒的候选规则（{rejectedCandidates.length} 条）</summary>
            <ul className="plain-list">
              {rejectedCandidates.map((r, i) => (
                <li key={i}>{r.reason}</li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card title="分析口径备忘" subtitle="这些是程序确定性执行的部分，不是模型自由发挥。">
        <ul className="plain-list">
          <li>字数：Unicode 码点、排除空白、含标点；所有统计都只读，不改变正文。</li>
          <li>当前 prompt 版本：{PROMPT_VERSION}；句长按终止标点（。！？!?…）切分，逗号与破折号不断句。</li>
          <li>引用校验：模型给的 quote 必须是该段落的连续子串，否则整条观察丢弃。</li>
          <li>直接采样的样本没有题目信息，约束影响一律按「未知」处理，避免把体裁要求当成你的习惯。</li>
          <li>失败记录只保留在本次会话的进度面板里；成功结果写入本地库，刷新后仍然是缓存命中。</li>
        </ul>
      </Card>
    </div>
  );
}

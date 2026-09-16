/**
 * 全局数据层：IndexedDB ←→ 内存状态 ←→ 各面板。
 *
 * 职责边界：
 * - 只有这里碰 db.ts；
 * - 所有写入失败都会写进 writeError，由 App 顶部的横幅显示（不允许静默失败）；
 * - 样本/分析/偏好一变，就用 shared/rules.ts 重算规则有效性并落盘（stale 必须是真的）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  type ProfileSampleRef,
  type Sample,
  type SampleAnalysis,
  type StatusResponse,
  type StyleProfile,
  type StyleRule,
  type WritingTask,
} from '../../shared/schema';
import { recomputeAllRules, stripEvidenceForSamples } from '../../shared/rules';
import { isAnalysisUsable } from '../../shared/verify';
import { countChars } from '../../shared/text';
import { fetchStatus } from '../api';
import * as db from '../db';
import { type DataStoreName, type EntityMap, type StoredData } from '../db';
import { newId } from './common';

export const APP_VERSION = '0.1.0';

/** 内置 6 张任务卡：题目只限定人物/目标/事件/长度，额外的框架约束由作者自己加。 */
export function createBuiltinTasks(now: string): WritingTask[] {
  const raw: { title: string; prompt: string; sceneTags: string[] }[] = [
    {
      title: '熟悉地点发生变化：叙述与细节',
      prompt:
        '写一个你熟悉的真实地点，但让它发生一处变化（拆迁、改造、搬迁、季节更替等）。人物与事件自定，只要求：写清变化前后各一处具体细节，不用“很美”“很怀念”这类直接评价。',
      sceneTags: ['叙述', '细节', '地点'],
    },
    {
      title: '两个人各自隐瞒信息：对话',
      prompt:
        '写两个人的一段对话，双方各隐瞒一件重要的事。人物与场合自定，只要求：对话不少于全篇一半，不直接写出他们隐瞒的内容，只靠语气、停顿和动作暗示。',
      sceneTags: ['对话', '信息差'],
    },
    {
      title: '原计划失败后的决定：行动与转折',
      prompt:
        '写一个角色按原计划行动却失败，随后做出新决定的过程。人物与目标自定，只要求：写清原计划是什么、失败发生在哪一步、新决定与旧计划的差别，转折落在一个具体动作上。',
      sceneTags: ['行动', '转折'],
    },
    {
      title: '收到消息却暂时不说：情绪表达',
      prompt:
        '写一个角色收到一条重要消息，却因为场合或对象没有立刻说出来。人物与消息内容自定，只要求：写清收到消息时的身体反应，不直接命名情绪（不写“他很愤怒”这类句子）。',
      sceneTags: ['情绪', '克制'],
    },
    {
      title: '根据同一组事实重新写作：表达选择',
      prompt:
        '给定同一组事实（例如一场雨、一次迟到、一笔钱），用两种不同方式各写一段。事实不许改，只改叙述顺序、详略与用词；两段各 150—300 字。',
      sceneTags: ['表达选择', '对照'],
    },
    {
      title: '作者自由写作：检查任务限制之外的风格',
      prompt:
        '自由写一段，题目不限定人物、目标与事件，只要求 300—600 字。写完后再回看：哪些特征是题目之外、真正属于你自己的。',
      sceneTags: ['自由写作'],
    },
  ];
  return raw.map((item, index) => ({
    id: `task_builtin_${index + 1}`,
    version: 1,
    title: item.title,
    prompt: item.prompt,
    constraints: [],
    targetMinChars: 300,
    targetMaxChars: 600,
    sceneTags: item.sceneTags,
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  }));
}

/* ------------------------------------------------------------ 纯派生工具 */

export function findTask(tasks: WritingTask[], taskId: string | null): WritingTask | null {
  if (!taskId) return null;
  return tasks.find((t) => t.id === taskId) ?? null;
}

export function taskConstraintsOf(tasks: WritingTask[], taskId: string | null): string[] {
  return findTask(tasks, taskId)?.constraints ?? [];
}

export function sampleTitle(sample: Sample, data: StoredData): string {
  const doc = sample.sourceDocumentId ? data.sourceDocuments.find((d) => d.id === sample.sourceDocumentId) : undefined;
  if (doc && doc.title.trim() !== '') return doc.title;
  const task = findTask(data.tasks, sample.taskId);
  if (task) return task.title;
  const flat = sample.text.replace(/\s+/gu, ' ').trim();
  return flat.length > 0 ? `${flat.slice(0, 18)}${flat.length > 18 ? '…' : ''}` : '（无标题样本）';
}

export interface SampleAnalysisStatus {
  latest: SampleAnalysis | null;
  /** 当前 revision + contentHash 有可用分析（缓存命中，不用重发）。 */
  usable: boolean;
  /** 曾经有可用分析，但正文/版本变了，已经过期。 */
  outdated: boolean;
  /** 最近一次分析本身被拒绝了（引用没通过、上游报错等）。 */
  rejected: boolean;
  mock: boolean;
  /** 需要作者留意（过期或被拒绝）。 */
  needsAttention: boolean;
}

export function analysisStatusOf(sample: Sample, analyses: SampleAnalysis[]): SampleAnalysisStatus {
  const mine = analyses
    .filter((a) => a.sampleId === sample.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const latest = mine[0] ?? null;
  if (!latest) {
    return { latest: null, usable: false, outdated: false, rejected: false, mock: false, needsAttention: false };
  }
  const usable =
    latest.sampleRevision === sample.revision &&
    latest.contentHash === sample.contentHash &&
    isAnalysisUsable(latest);
  const rejected = !isAnalysisUsable(latest);
  const outdated = !rejected && !usable;
  return {
    latest,
    usable,
    outdated,
    rejected,
    mock: latest.mock,
    needsAttention: outdated || rejected,
  };
}

export function buildProfile(input: {
  rules: StyleRule[];
  samples: Sample[];
  model: string;
  promptVersion: string;
  mock: boolean;
  version: number;
  now: string;
  coveredScenes: string[];
}): StyleProfile {
  const sampleSnapshot: ProfileSampleRef[] = input.samples.map((s) => ({
    sampleId: s.id,
    revision: s.revision,
    contentHash: s.contentHash,
    sceneTags: s.sceneTags,
    entryMode: s.entryMode,
    sourceType: s.sourceType,
    chars: countChars(s.text),
    fragmentIndex: s.fragment ? s.fragment.fragmentIndex : null,
  }));
  return {
    id: newId('prof'),
    version: input.version,
    model: input.model,
    promptVersion: input.promptVersion,
    sampleSnapshot,
    rules: input.rules,
    coveredScenes: input.coveredScenes,
    limitations: [
      '本文件由程序从你确认过的规则生成，不是对文风的客观测量。',
      '人工确认的规则只代表“你有意识地认可”，未覆盖的写法不会被写进去。',
      '样本数量少时，通用习惯的结论强度有限。',
    ],
    mock: input.mock,
    createdAt: input.now,
  };
}

/** 一组样本涉及到的场景标签。 */
export function collectScenes(samples: Sample[]): string[] {
  return Array.from(new Set(samples.flatMap((s) => s.sceneTags)));
}

/** 写作草稿在 meta 仓里的键：按任务各存一份，未绑定题目的存在 draft:free。 */
export function draftKeyFor(taskId: string | null): string {
  return taskId ? `draft:task:${taskId}` : 'draft:free';
}

export async function readDraft(key: string): Promise<string> {
  return (await db.getMeta(key)) ?? '';
}

export async function writeDraft(key: string, text: string): Promise<void> {
  await db.putMeta(key, text);
}

/* ------------------------------------------------------------------ 上下文 */

export interface LabStoreValue {
  data: StoredData;
  ready: boolean;
  fatalError: string | null;
  writeError: string | null;
  dismissWriteError: () => void;
  status: StatusResponse | null;
  statusError: string | null;
  refreshStatus: () => Promise<void>;
  save: <K extends DataStoreName>(store: K, values: EntityMap[K][]) => Promise<boolean>;
  remove: (store: DataStoreName, ids: string[]) => Promise<boolean>;
  /** 删除样本，并级联清掉它的分析、偏好标记，同时把引用它的规则依据清掉并标为需重新确认。 */
  removeSamples: (sampleIds: string[]) => Promise<boolean>;
  removeSourceDocuments: (docIds: string[]) => Promise<boolean>;
  replaceAll: (next: StoredData) => Promise<boolean>;
  reload: () => Promise<void>;
}

const LabContext = createContext<LabStoreValue | null>(null);

function setStoreRows(prev: StoredData, store: DataStoreName, rows: unknown[]): StoredData {
  const next = { ...prev } as Record<DataStoreName, unknown>;
  next[store] = rows;
  return next as unknown as StoredData;
}

function upsertRows(existing: { id: string }[], list: { id: string }[]): { id: string }[] {
  const rows = [...existing];
  const positions = new Map<string, number>();
  rows.forEach((row, index) => positions.set(row.id, index));
  for (const item of list) {
    const at = positions.get(item.id);
    if (at === undefined) {
      positions.set(item.id, rows.length);
      rows.push(item);
    } else {
      rows[at] = item;
    }
  }
  return rows;
}

export function LabProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<StoredData>(db.EMPTY_DATA);
  const [ready, setReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchStatus();
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      setStatus(null);
      setStatusError(err instanceof Error ? err.message : '未知错误');
    }
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const loaded = await db.loadAllData();
      setData(loaded);
      setFatalError(null);
    } catch (err) {
      setFatalError(db.describeError(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await db.loadAllData();
        if (cancelled) return;
        if (loaded.tasks.length === 0) {
          const now = new Date().toISOString();
          const builtins = createBuiltinTasks(now);
          await db.putMany('tasks', builtins);
          if (cancelled) return;
          setData({ ...loaded, tasks: builtins });
        } else {
          setData(loaded);
        }
        setFatalError(null);
      } catch (err) {
        if (!cancelled) setFatalError(db.describeError(err));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const save = useCallback(async <K extends DataStoreName>(store: K, values: EntityMap[K][]): Promise<boolean> => {
    if (values.length === 0) return true;
    try {
      await db.putMany(store, values);
    } catch (err) {
      setWriteError(db.describeError(err));
      return false;
    }
    setData((prev) =>
      setStoreRows(
        prev,
        store,
        upsertRows(prev[store] as unknown as { id: string }[], values as unknown as { id: string }[]),
      ),
    );
    return true;
  }, []);

  const remove = useCallback(async (store: DataStoreName, ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return true;
    try {
      await db.removeMany(store, ids);
    } catch (err) {
      setWriteError(db.describeError(err));
      return false;
    }
    setData((prev) => {
      const rows = (prev[store] as unknown as { id: string }[]).filter((row) => !ids.includes(row.id));
      return setStoreRows(prev, store, rows);
    });
    return true;
  }, []);

  const removeSamples = useCallback(
    async (sampleIds: string[]): Promise<boolean> => {
      if (sampleIds.length === 0) return true;
      const ids = new Set(sampleIds);
      const current = dataRef.current;
      const analysisIds = current.analyses.filter((a) => ids.has(a.sampleId)).map((a) => a.id);
      const preferenceIds = current.preferences.filter((p) => ids.has(p.sampleId)).map((p) => p.id);
      const touched = stripEvidenceForSamples(current.rules, sampleIds);
      const changedRules = touched.filter((rule, index) => rule !== current.rules[index]);
      try {
        await db.applyChanges([
          { store: 'samples', deletes: [...ids] },
          { store: 'analyses', deletes: analysisIds },
          { store: 'preferences', deletes: preferenceIds },
          { store: 'rules', puts: changedRules },
        ]);
      } catch (err) {
        setWriteError(db.describeError(err));
        return false;
      }
      setData((prev) => {
        let next = setStoreRows(
          prev,
          'samples',
          prev.samples.filter((s) => !ids.has(s.id)),
        );
        next = setStoreRows(
          next,
          'analyses',
          next.analyses.filter((a) => !ids.has(a.sampleId)),
        );
        next = setStoreRows(
          next,
          'preferences',
          next.preferences.filter((p) => !ids.has(p.sampleId)),
        );
        next = setStoreRows(
          next,
          'rules',
          upsertRows(next.rules as unknown as { id: string }[], changedRules as unknown as { id: string }[]),
        );
        return next;
      });
      return true;
    },
    [],
  );

  const removeSourceDocuments = useCallback(
    async (docIds: string[]): Promise<boolean> => {
      if (docIds.length === 0) return true;
      const current = dataRef.current;
      const docSet = new Set(docIds);
      const sampleIds = current.samples
        .filter((s) => s.sourceDocumentId !== null && docSet.has(s.sourceDocumentId))
        .map((s) => s.id);
      const samplesOk = await removeSamples(sampleIds);
      return (await remove('sourceDocuments', docIds)) && samplesOk;
    },
    [remove, removeSamples],
  );

  const replaceAll = useCallback(async (next: StoredData): Promise<boolean> => {
    try {
      await db.replaceAllData(next);
    } catch (err) {
      setWriteError(db.describeError(err));
      return false;
    }
    setData(next);
    return true;
  }, []);

  /** 数据一变就重算规则有效性：失效的必须真的变成 stale，不能靠界面假装。 */
  useEffect(() => {
    if (!ready) return;
    const ctx = { samples: data.samples, analyses: data.analyses, preferences: data.preferences };
    const recomputed = recomputeAllRules(data.rules, ctx);
    const changed = recomputed.filter((rule, index) => {
      const before = data.rules[index];
      if (!before) return true;
      return (
        before.stale !== rule.stale ||
        before.staleReason !== rule.staleReason ||
        before.scope !== rule.scope ||
        before.evidence.length !== rule.evidence.length
      );
    });
    if (changed.length === 0) return;
    void save('rules', changed);
  }, [ready, data.samples, data.analyses, data.preferences, data.rules, save]);

  const value = useMemo<LabStoreValue>(
    () => ({
      data,
      ready,
      fatalError,
      writeError,
      dismissWriteError: () => setWriteError(null),
      status,
      statusError,
      refreshStatus,
      save,
      remove,
      removeSamples,
      removeSourceDocuments,
      replaceAll,
      reload,
    }),
    [
      data,
      ready,
      fatalError,
      writeError,
      status,
      statusError,
      refreshStatus,
      save,
      remove,
      removeSamples,
      removeSourceDocuments,
      replaceAll,
      reload,
    ],
  );

  return <LabContext.Provider value={value}>{children}</LabContext.Provider>;
}

export function useLab(): LabStoreValue {
  const value = useContext(LabContext);
  if (!value) throw new Error('useLab 必须在 LabProvider 内使用');
  return value;
}

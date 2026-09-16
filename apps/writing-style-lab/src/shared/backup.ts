/**
 * 备份与恢复。
 *
 * 要求：备份 JSON 含 schemaVersion；导入先校验、预览并报告冲突；**不静默覆盖原有数据**；
 * 备份可能含私人正文，界面与导出 Skill 必须区分；备份里绝不包含 API Key。
 */
import { SCHEMA_VERSION } from './limits';
import {
  type Backup,
  type Evaluation,
  type PreferenceMark,
  type Sample,
  type SampleAnalysis,
  type SourceDocument,
  type StyleProfile,
  type StyleRule,
  type WritingTask,
  BackupSchema,
} from './schema';

export interface BackupState {
  tasks: WritingTask[];
  sourceDocuments: SourceDocument[];
  samples: Sample[];
  analyses: SampleAnalysis[];
  rules: StyleRule[];
  profiles: StyleProfile[];
  evaluations: Evaluation[];
  preferences: PreferenceMark[];
}

export function emptyState(): BackupState {
  return {
    tasks: [],
    sourceDocuments: [],
    samples: [],
    analyses: [],
    rules: [],
    profiles: [],
    evaluations: [],
    preferences: [],
  };
}

const COLLECTIONS = [
  'tasks',
  'sourceDocuments',
  'samples',
  'analyses',
  'rules',
  'profiles',
  'evaluations',
  'preferences',
] as const;
type CollectionName = (typeof COLLECTIONS)[number];

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '').slice(0, 16);
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

export function createBackup(state: BackupState, opts: { now?: Date } = {}): Backup {
  const now = opts.now ?? new Date();
  return {
    schemaVersion: SCHEMA_VERSION,
    app: 'writing-style-lab',
    exportedAt: now.toISOString(),
    containsFullText: true,
    tasks: state.tasks,
    sourceDocuments: state.sourceDocuments,
    samples: state.samples,
    analyses: state.analyses,
    rules: state.rules,
    profiles: state.profiles,
    evaluations: state.evaluations,
    preferences: state.preferences,
  };
}

export function serializeBackup(backup: Backup): string {
  return JSON.stringify(backup, null, 2);
}

export interface ImportConflict {
  kind: CollectionName;
  id: string;
  note: string;
}

export interface ImportPreview {
  ok: boolean;
  errors: string[];
  schemaVersion: number | null;
  counts: Record<string, number> | null;
  conflicts: ImportConflict[];
  containsFullText: boolean;
}

/** 疑似密钥字段：备份里出现这些顶层键就直接拒绝导入。 */
const SECRET_KEY_RE = /"(apiKey|api_key|DEEPSEEK_API_KEY|token|authorization)"\s*:/i;

function parseBackup(rawJson: string): { ok: true; backup: Backup } | { ok: false; errors: string[] } {
  if (SECRET_KEY_RE.test(rawJson)) {
    return { ok: false, errors: ['备份中疑似包含密钥字段，已拒绝导入（备份不应包含 API Key）'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { ok: false, errors: [`不是合法 JSON：${(err as Error).message}`] };
  }
  const res = BackupSchema.safeParse(parsed);
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || '(根)'}：${i.message}`),
    };
  }
  if (res.data.schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`备份 schemaVersion=${res.data.schemaVersion} 高于当前支持的 ${SCHEMA_VERSION}，请升级应用后再导入`],
    };
  }
  return { ok: true, backup: res.data };
}

export function previewImport(rawJson: string, current: BackupState): ImportPreview {
  const parsed = parseBackup(rawJson);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors, schemaVersion: null, counts: null, conflicts: [], containsFullText: false };
  }
  const backup = parsed.backup;
  const counts: Record<string, number> = {};
  const conflicts: ImportConflict[] = [];
  for (const name of COLLECTIONS) {
    const items = backup[name] as { id: string }[];
    counts[name] = items.length;
    const existing = new Set((current[name] as { id: string }[]).map((x) => x.id));
    for (const item of items) {
      if (existing.has(item.id)) {
        conflicts.push({ kind: name, id: item.id, note: '与现有数据 ID 相同，导入时需要你决定处理方式' });
      }
    }
  }
  return {
    ok: true,
    errors: [],
    schemaVersion: backup.schemaVersion,
    counts,
    conflicts,
    containsFullText: backup.containsFullText,
  };
}

export interface ApplyImportResult {
  state: BackupState;
  applied: Record<string, number>;
  skipped: string[];
  errors: string[];
}

/**
 * 导入。三种模式都不会静默覆盖：
 * - skip：冲突项保留现有数据，跳过导入项；
 * - overwrite：用导入项替换同 ID 现有项；
 * - duplicate：冲突项作为新副本导入，并改写导入批次内部的引用关系。
 */
export function applyImport(
  rawJson: string,
  current: BackupState,
  mode: 'skip' | 'overwrite' | 'duplicate',
): ApplyImportResult {
  const parsed = parseBackup(rawJson);
  if (!parsed.ok) {
    return { state: current, applied: {}, skipped: [], errors: parsed.errors };
  }
  const backup = parsed.backup;
  const next: BackupState = {
    tasks: [...current.tasks],
    sourceDocuments: [...current.sourceDocuments],
    samples: [...current.samples],
    analyses: [...current.analyses],
    rules: [...current.rules],
    profiles: [...current.profiles],
    evaluations: [...current.evaluations],
    preferences: [...current.preferences],
  };
  const applied: Record<string, number> = {};
  const skipped: string[] = [];

  type AnyItem = { id: string };
  const idMap = new Map<string, string>(); // old id -> new id（仅 duplicate 模式对冲突项生效）

  // 第一遍：决定每个集合里每一项的去留，并为 duplicate 模式建立 id 映射。
  const plan = new Map<CollectionName, { keep: AnyItem[]; drop: AnyItem[] }>();
  for (const name of COLLECTIONS) {
    const incoming = backup[name] as unknown as AnyItem[];
    const existingIds = new Set((next[name] as unknown as AnyItem[]).map((x) => x.id));
    const keep: AnyItem[] = [];
    const drop: AnyItem[] = [];
    for (const item of incoming) {
      const conflict = existingIds.has(item.id);
      if (!conflict) {
        keep.push(item);
        continue;
      }
      if (mode === 'skip') {
        drop.push(item);
        skipped.push(`${name}:${item.id}`);
        continue;
      }
      if (mode === 'overwrite') {
        // 直接替换同 ID 项
        const arr = next[name] as unknown as AnyItem[];
        const idx = arr.findIndex((x) => x.id === item.id);
        if (idx >= 0) arr[idx] = item;
        applied[name] = (applied[name] ?? 0) + 1;
        drop.push(item); // 已经处理，不再追加
        continue;
      }
      // duplicate
      const fresh = `${item.id}_${newId().slice(0, 6)}`;
      idMap.set(`${name}:${item.id}`, fresh);
      keep.push({ ...item, id: fresh });
    }
    plan.set(name, { keep, drop });
  }

  // 第二遍：duplicate 模式下改写批次内部引用，避免新副本指向旧记录。
  const remap = (name: CollectionName, id: string | null): string | null => {
    if (id === null) return null;
    return idMap.get(`${name}:${id}`) ?? id;
  };
  const remapEvidence = (list: { sampleId: string }[]) =>
    list.map((e) => ({ ...e, sampleId: remap('samples', e.sampleId) ?? e.sampleId }));

  for (const name of COLLECTIONS) {
    const { keep } = plan.get(name) ?? { keep: [] };
    if (keep.length === 0) continue;
    let prepared = keep;
    if (idMap.size > 0) {
      switch (name) {
        case 'samples':
          prepared = (keep as unknown as Sample[]).map((s) => ({
            ...s,
            taskId: remap('tasks', s.taskId),
            sourceDocumentId: remap('sourceDocuments', s.sourceDocumentId),
          })) as unknown as AnyItem[];
          break;
        case 'analyses':
          prepared = (keep as unknown as SampleAnalysis[]).map((a) => ({
            ...a,
            sampleId: remap('samples', a.sampleId) ?? a.sampleId,
          })) as unknown as AnyItem[];
          break;
        case 'rules':
          prepared = (keep as unknown as StyleRule[]).map((r) => ({
            ...r,
            evidence: remapEvidence(r.evidence),
            counterEvidence: remapEvidence(r.counterEvidence),
          })) as unknown as AnyItem[];
          break;
        case 'profiles':
          prepared = (keep as unknown as StyleProfile[]).map((p) => ({
            ...p,
            sampleSnapshot: p.sampleSnapshot.map((s) => ({
              ...s,
              sampleId: remap('samples', s.sampleId) ?? s.sampleId,
            })),
            rules: p.rules.map((r) => ({
              ...r,
              id: remap('rules', r.id) ?? r.id,
              evidence: remapEvidence(r.evidence),
              counterEvidence: remapEvidence(r.counterEvidence),
            })),
          })) as unknown as AnyItem[];
          break;
        case 'evaluations':
          prepared = (keep as unknown as Evaluation[]).map((e) => ({
            ...e,
            skillProfileId: remap('profiles', e.skillProfileId),
          })) as unknown as AnyItem[];
          break;
        case 'preferences':
          prepared = (keep as unknown as PreferenceMark[]).map((p) => ({
            ...p,
            sampleId: remap('samples', p.sampleId) ?? p.sampleId,
          })) as unknown as AnyItem[];
          break;
        default:
          prepared = keep;
      }
    }
    (next[name] as unknown as AnyItem[]).push(...prepared);
    applied[name] = (applied[name] ?? 0) + prepared.length;
  }

  // 最后整体校验一次，坏数据不落库。
  const check = BackupSchema.safeParse({ ...createBackup(next), containsFullText: true });
  if (!check.success) {
    return {
      state: current,
      applied: {},
      skipped,
      errors: ['导入后数据未通过校验，已放弃本次导入：' + check.error.issues.slice(0, 3).map((i) => i.path.join('.')).join('；')],
    };
  }
  return { state: next, applied, skipped, errors: [] };
}

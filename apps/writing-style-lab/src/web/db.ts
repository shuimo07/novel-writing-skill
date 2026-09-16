/**
 * IndexedDB 封装（原生 API，不引第三方库）。
 *
 * 原则：
 * 1. 所有写入都走同一个 `applyChanges`，一个 readwrite 事务，要么全成要么全不成，不做“写一半”的假成功；
 * 2. 任何失败都抛 `DbError`（带中文说明与原始异常），由界面显示出来 —— 不允许静默失败；
 * 3. 这里只负责存取，不做业务判断（业务规则在 src/shared/rules.ts）。
 */
import type {
  Evaluation,
  PreferenceMark,
  Sample,
  SampleAnalysis,
  SourceDocument,
  StyleProfile,
  StyleRule,
  WritingTask,
} from '../shared/schema';

/** 实体仓 → 实体类型映射。meta 单独处理，不参与备份。 */
export interface EntityMap {
  tasks: WritingTask;
  sourceDocuments: SourceDocument;
  samples: Sample;
  analyses: SampleAnalysis;
  rules: StyleRule;
  profiles: StyleProfile;
  evaluations: Evaluation;
  preferences: PreferenceMark;
}

export type DataStoreName = keyof EntityMap;

export const DATA_STORES: DataStoreName[] = [
  'tasks',
  'sourceDocuments',
  'samples',
  'analyses',
  'rules',
  'profiles',
  'evaluations',
  'preferences',
];

/** 全部业务数据（与 shared/backup.ts 的 BackupState 结构一致）。 */
export type StoredData = { [K in DataStoreName]: EntityMap[K][] };

export interface MetaRecord {
  key: string;
  value: string;
}

export const EMPTY_DATA: StoredData = {
  tasks: [],
  sourceDocuments: [],
  samples: [],
  analyses: [],
  rules: [],
  profiles: [],
  evaluations: [],
  preferences: [],
};

export class DbError extends Error {
  readonly operation: string;

  constructor(operation: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'DbError';
    this.operation = operation;
    if (cause !== undefined) this.cause = cause;
  }
}

const DB_NAME = 'writing-style-lab';
const DB_VERSION = 1;
const META_STORE = 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

export function describeError(err: unknown): string {
  if (err instanceof DbError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '未知错误';
}

function request<T>(req: IDBRequest<T>, operation: string, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new DbError(operation, `${what}失败：${describeError(req.error)}`, req.error));
  });
}

function openRaw(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new DbError('open', '当前浏览器环境不支持 IndexedDB，样本、规则与草稿都无法保存在本地。'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new DbError('open', `打开本地数据库失败：${describeError(err)}`, err));
      return;
    }
    req.onupgradeneeded = () => {
      const database = req.result;
      for (const name of DATA_STORES) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const database = req.result;
      // 其他标签页升级数据库时主动让路，避免事务长期阻塞。
      database.onversionchange = () => database.close();
      resolve(database);
    };
    req.onerror = () => reject(new DbError('open', `打开本地数据库失败：${describeError(req.error)}`, req.error));
    req.onblocked = () =>
      reject(new DbError('open', '本地数据库被本应用的另一个标签页占用（升级被阻塞），请关闭其他标签页后重试。'));
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openRaw().catch((err: unknown) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

export async function getAll<K extends DataStoreName>(store: K): Promise<EntityMap[K][]> {
  const database = await openDb();
  const t = database.transaction(store, 'readonly');
  const rows = await request(t.objectStore(store).getAll(), 'read', `读取 ${store}`);
  return rows as EntityMap[K][];
}

/** 一次读全：加载完毕后整个界面都基于内存状态渲染。 */
export async function loadAllData(): Promise<StoredData> {
  const [tasks, sourceDocuments, samples, analyses, rules, profiles, evaluations, preferences] = await Promise.all([
    getAll('tasks'),
    getAll('sourceDocuments'),
    getAll('samples'),
    getAll('analyses'),
    getAll('rules'),
    getAll('profiles'),
    getAll('evaluations'),
    getAll('preferences'),
  ]);
  return { tasks, sourceDocuments, samples, analyses, rules, profiles, evaluations, preferences };
}

export interface StoreChange {
  store: DataStoreName;
  deletes?: string[];
  puts?: unknown[];
}

/** 单事务批量写入：任何一步失败整批回滚，并把原因抛给界面。 */
export async function applyChanges(changes: StoreChange[]): Promise<void> {
  if (changes.length === 0) return;
  const database = await openDb();
  const names = Array.from(new Set(changes.map((c) => c.store)));
  return new Promise<void>((resolve, reject) => {
    let t: IDBTransaction;
    try {
      t = database.transaction(names, 'readwrite');
    } catch (err) {
      reject(new DbError('write', `开启写入事务失败：${describeError(err)}`, err));
      return;
    }
    let failure: DbError | null = null;
    t.oncomplete = () => {
      if (failure) reject(failure);
      else resolve();
    };
    t.onabort = () =>
      reject(failure ?? new DbError('write', `写入被中止（未写入任何数据）：${describeError(t.error)}`, t.error));
    t.onerror = () => {
      if (!failure) failure = new DbError('write', `写入失败（未写入任何数据）：${describeError(t.error)}`, t.error);
    };
    try {
      for (const change of changes) {
        const objectStore = t.objectStore(change.store);
        for (const id of change.deletes ?? []) objectStore.delete(id);
        for (const row of change.puts ?? []) objectStore.put(row);
      }
    } catch (err) {
      failure = failure ?? new DbError('write', `写入 ${names.join('、')} 失败：${describeError(err)}`, err);
      try {
        t.abort();
      } catch {
        /* abort 本身失败时，事务最终仍会以 onabort/onerror 收敛 */
      }
    }
  });
}

export async function putMany<K extends DataStoreName>(store: K, values: EntityMap[K][]): Promise<void> {
  await applyChanges([{ store, puts: values }]);
}

export async function removeMany(store: DataStoreName, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await applyChanges([{ store, deletes: ids }]);
}

/** 备份导入用：清空全部业务仓后整表写入（导入前必须先给作者看预览，绝不静默覆盖）。 */
export async function replaceAllData(data: StoredData): Promise<void> {
  const database = await openDb();
  return new Promise<void>((resolve, reject) => {
    let t: IDBTransaction;
    try {
      t = database.transaction(DATA_STORES, 'readwrite');
    } catch (err) {
      reject(new DbError('write', `开启导入事务失败：${describeError(err)}`, err));
      return;
    }
    let failure: DbError | null = null;
    t.oncomplete = () => {
      if (failure) reject(failure);
      else resolve();
    };
    t.onabort = () =>
      reject(failure ?? new DbError('write', `导入被中止，本地数据保持原样：${describeError(t.error)}`, t.error));
    t.onerror = () => {
      if (!failure) failure = new DbError('write', `导入失败，本地数据保持原样：${describeError(t.error)}`, t.error);
    };
    try {
      for (const name of DATA_STORES) {
        const objectStore = t.objectStore(name);
        objectStore.clear();
        const rows: unknown[] = data[name];
        for (const row of rows) objectStore.put(row);
      }
    } catch (err) {
      failure = failure ?? new DbError('write', `导入失败：${describeError(err)}`, err);
      try {
        t.abort();
      } catch {
        /* 同上 */
      }
    }
  });
}

/* ------------------------------------------------------------------ meta */

export async function getMeta(key: string): Promise<string | null> {
  const database = await openDb();
  const t = database.transaction(META_STORE, 'readonly');
  const row = await request(t.objectStore(META_STORE).get(key), 'read', `读取本地设置 ${key}`);
  const record = row as MetaRecord | undefined;
  return record && typeof record.value === 'string' ? record.value : null;
}

export async function putMeta(key: string, value: string): Promise<void> {
  const database = await openDb();
  return new Promise<void>((resolve, reject) => {
    const t = database.transaction(META_STORE, 'readwrite');
    t.oncomplete = () => resolve();
    t.onerror = () => reject(new DbError('write', `保存草稿/设置 ${key} 失败：${describeError(t.error)}`, t.error));
    t.onabort = () => reject(new DbError('write', `保存草稿/设置 ${key} 被中止：${describeError(t.error)}`, t.error));
    t.objectStore(META_STORE).put({ key, value });
  });
}

export async function deleteMeta(key: string): Promise<void> {
  const database = await openDb();
  return new Promise<void>((resolve, reject) => {
    const t = database.transaction(META_STORE, 'readwrite');
    t.oncomplete = () => resolve();
    t.onerror = () => reject(new DbError('write', `删除 ${key} 失败：${describeError(t.error)}`, t.error));
    t.onabort = () => reject(new DbError('write', `删除 ${key} 被中止：${describeError(t.error)}`, t.error));
    t.objectStore(META_STORE).delete(key);
  });
}

/** 危险操作：清空本应用的全部本地数据（含草稿），仅设置页在二次确认后调用。 */
export async function clearEverything(): Promise<void> {
  const database = await openDb();
  const names = [...DATA_STORES, META_STORE];
  return new Promise<void>((resolve, reject) => {
    const t = database.transaction(names, 'readwrite');
    t.oncomplete = () => resolve();
    t.onerror = () => reject(new DbError('write', `清空本地数据失败：${describeError(t.error)}`, t.error));
    t.onabort = () => reject(new DbError('write', `清空本地数据被中止：${describeError(t.error)}`, t.error));
    for (const name of names) t.objectStore(name).clear();
  });
}

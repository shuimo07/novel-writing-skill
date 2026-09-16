/**
 * 任务簿记：在飞任务去重 + 按 runId 计的额外重试账本。
 *
 * 为什么要集中在这里：
 * - 去重键是跨路由共享的（analyze-sample 用 `${runId}:${sampleId}`，tryout 用 `${runId}:tryout`），
 *   放在路由里会各写一套；
 * - 额外重试额度是**按批次（runId）**算的：同一批 10 篇样本共享 MAX_EXTRA_RETRIES_PER_BATCH，
 *   不能每篇各自重试到成功，所以账本必须跨请求共享。
 *
 * 这里只存标识与计数，不存正文、不存响应，也不会写日志。
 */
import { MAX_EXTRA_RETRIES_PER_BATCH } from '../shared/limits';

export interface InflightTask {
  /** 去重键，例如 `${runId}:${sampleId}`。 */
  key: string;
  startedAt: number;
}

const inflight = new Map<string, InflightTask>();

/** 账本条目的存活时间：超过就丢弃，避免长时间运行后 Map 无限增长。 */
const LEDGER_TTL_MS = 60 * 60 * 1000;

interface RetryLedgerEntry {
  count: number;
  firstAt: number;
}

const retryLedger = new Map<string, RetryLedgerEntry>();

function pruneRetryLedger(now: number): void {
  if (retryLedger.size < 500) return;
  for (const [runId, entry] of retryLedger) {
    if (now - entry.firstAt > LEDGER_TTL_MS) retryLedger.delete(runId);
  }
}

/**
 * 尝试占用一个任务键。
 * 返回 null 表示**同一个键已经在飞行中**：调用方必须返回 409 DUPLICATE_TASK 且不得再调上游。
 * 返回 ticket 则必须在 finally 里调用 endTask 释放。
 */
export function beginTask(key: string): InflightTask | null {
  if (inflight.has(key)) return null;
  const ticket: InflightTask = { key, startedAt: Date.now() };
  inflight.set(key, ticket);
  return ticket;
}

export function endTask(ticket: InflightTask | null | undefined): void {
  if (!ticket) return;
  const current = inflight.get(ticket.key);
  if (current && current.startedAt === ticket.startedAt) inflight.delete(ticket.key);
}

export function isTaskInflight(key: string): boolean {
  return inflight.has(key);
}

export function inflightCount(): number {
  return inflight.size;
}

export function inflightKeys(): string[] {
  return [...inflight.keys()];
}

/** 本批次已用掉的额外重试次数。 */
export function extraRetriesUsed(runId: string): number {
  return retryLedger.get(runId)?.count ?? 0;
}

/**
 * 申请一次额外重试（不含首次请求）。
 * 返回 false 表示本批次的额度已经用尽，调用方必须停止重试并返回 QUOTA_EXCEEDED，
 * **不得**继续尝试直到“碰巧成功”。
 */
export function consumeExtraRetry(runId: string, max: number = MAX_EXTRA_RETRIES_PER_BATCH): boolean {
  const now = Date.now();
  pruneRetryLedger(now);
  const entry = retryLedger.get(runId);
  if (!entry) {
    retryLedger.set(runId, { count: 1, firstAt: now });
    return max >= 1;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

/** 测试与批处理收尾用：清空在飞任务与重试账本。 */
export function resetTaskControl(): void {
  inflight.clear();
  retryLedger.clear();
}

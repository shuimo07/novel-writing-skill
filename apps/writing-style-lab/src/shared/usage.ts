/**
 * 合并多次调用的 usage。放在 shared 里，服务端与浏览器直连共用同一份实现，
 * 避免两边算法漂移（缺字段一律保持“未知”，绝不猜一个数字填上）。
 */
import type { Usage } from './schema';

export function sumUsage(a: Usage, b: Usage): Usage {
  const add = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return {
    promptTokens: add(a.promptTokens, b.promptTokens),
    completionTokens: add(a.completionTokens, b.completionTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
  };
}

/**
 * 对照试写的 A/B 排布。
 *
 * 要求：同一模型、同一题目、相同参数；页面随机排列；**评价前隐藏条件**；
 * 保存映射；作者评价后才揭示。这里只做纯函数，UI 负责“揭示前不渲染条件”。
 */

export interface ABItem {
  label: 'A' | 'B';
  text: string;
}
export interface ABPair {
  items: ABItem[];
  /** 条件映射，评价前不能展示。 */
  mapping: { A: 'base' | 'skill'; B: 'base' | 'skill' };
}

function defaultRng(): number {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] / 0x100000000;
  }
  return Math.random();
}

/** 随机把“基础版 / 加 Skill 版”排成 A、B，并保留映射。 */
export function createABPair(base: string, withSkill: string, rng: () => number = defaultRng): ABPair {
  const skillIsA = rng() < 0.5;
  const items: ABItem[] = skillIsA
    ? [
        { label: 'A', text: withSkill },
        { label: 'B', text: base },
      ]
    : [
        { label: 'A', text: base },
        { label: 'B', text: withSkill },
      ];
  return { items, mapping: { A: skillIsA ? 'skill' : 'base', B: skillIsA ? 'base' : 'skill' } };
}

export function revealCondition(pair: ABPair, label: 'A' | 'B'): 'base' | 'skill' {
  return pair.mapping[label];
}

export const CONDITION_LABEL: Record<'base' | 'skill', string> = {
  base: '基础版（未使用 Skill）',
  skill: '加入当前 Skill 版',
};

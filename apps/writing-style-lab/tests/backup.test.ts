import { describe, expect, it } from 'vitest';
import { applyImport, createBackup, emptyState, previewImport, serializeBackup } from '../src/shared/backup';
import { createABPair, revealCondition } from '../src/shared/ab';
import { makeAnalysis, makeObservation, makeRule, makeSample, makeTask } from './fixtures';
import type { BackupState } from '../src/shared/backup';

const TEXT = '推开门，屋里没有人。\n\n他把伞放在门边，没有开灯。';

async function sampleState() {
  const task = makeTask({ id: 'task1' });
  const sample = await makeSample({ id: 's1', text: TEXT, taskId: 'task1', taskVersion: 1 });
  const analysis = makeAnalysis(sample, [makeObservation(sample, 2, '他把伞放在门边，没有开灯')]);
  const rule = makeRule({
    id: 'r1',
    statement: '用动作代替情绪判断',
    decision: 'accepted',
    evidence: [{ sampleId: 's1', sampleRevision: 1, paragraphId: 'p2', quote: '他把伞放在门边，没有开灯' }],
  });
  const state: BackupState = {
    ...emptyState(),
    tasks: [task],
    samples: [sample],
    analyses: [analysis],
    rules: [rule],
    sourceDocuments: [
      {
        id: 'doc1',
        title: '旧稿',
        importMethod: 'paste',
        sourceFileName: null,
        text: TEXT,
        contentHash: sample.contentHash,
        receipt: { lineEnding: 'lf', hasBom: false, hasZeroWidth: false, hasTab: false, codePoints: 30, chars: 26, utf16Length: 30 },
        declaredSourceType: 'self_current',
        backgroundContext: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  return { state, sample };
}

describe('备份与恢复', () => {
  it('备份带 schemaVersion 并声明含完整正文', async () => {
    const { state } = await sampleState();
    const backup = createBackup(state);
    expect(backup.schemaVersion).toBe(1);
    expect(backup.app).toBe('writing-style-lab');
    expect(backup.containsFullText).toBe(true);
    expect(backup.samples[0].text).toBe(TEXT);
  });

  it('坏文件在预览阶段就被拒绝，不会碰到现有数据', async () => {
    const { state } = await sampleState();
    const preview = previewImport('{不是 JSON', state);
    expect(preview.ok).toBe(false);
    expect(preview.errors[0]).toContain('不是合法 JSON');
  });

  it('结构不符的 JSON 被拒绝并给出字段路径', async () => {
    const { state } = await sampleState();
    const preview = previewImport(JSON.stringify({ schemaVersion: 1, app: 'writing-style-lab' }), state);
    expect(preview.ok).toBe(false);
    expect(preview.errors.length).toBeGreaterThan(0);
  });

  it('备份里疑似含密钥时直接拒绝导入', async () => {
    const { state } = await sampleState();
    const json = JSON.stringify({ ...createBackup(state), apiKey: 'sk-abcdefgh' });
    const preview = previewImport(json, state);
    expect(preview.ok).toBe(false);
    expect(preview.errors[0]).toContain('疑似包含密钥');
  });

  it('schemaVersion 高于当前支持版本时拒绝', async () => {
    const { state } = await sampleState();
    const json = JSON.stringify({ ...createBackup(state), schemaVersion: 99 });
    const res = applyImport(json, state, 'skip');
    expect(res.errors[0]).toContain('高于当前支持');
    expect(res.state).toBe(state);
  });

  it('预览报告 ID 冲突数量，不静默覆盖', async () => {
    const { state } = await sampleState();
    const json = serializeBackup(createBackup(state));
    const preview = previewImport(json, state);
    expect(preview.ok).toBe(true);
    expect(preview.conflicts.map((c) => c.kind)).toContain('samples');
    expect(preview.counts?.samples).toBe(1);
    expect(preview.containsFullText).toBe(true);
  });

  it('skip 模式保留现有数据，冲突项被跳过', async () => {
    const { state } = await sampleState();
    const incoming = { ...state, tasks: [{ ...state.tasks[0], title: '导入的标题' }] };
    const res = applyImport(serializeBackup(createBackup(incoming)), state, 'skip');
    expect(res.state.tasks[0].title).toBe('测试任务');
    expect(res.skipped.some((s) => s.startsWith('tasks:'))).toBe(true);
  });

  it('overwrite 模式用导入项替换同 ID 数据', async () => {
    const { state } = await sampleState();
    const incoming = { ...state, tasks: [{ ...state.tasks[0], title: '导入的标题' }] };
    const res = applyImport(serializeBackup(createBackup(incoming)), state, 'overwrite');
    expect(res.state.tasks[0].title).toBe('导入的标题');
  });

  it('duplicate 模式生成新 ID 并改写批次内部引用', async () => {
    const { state } = await sampleState();
    const res = applyImport(serializeBackup(createBackup(state)), state, 'duplicate');
    expect(res.errors).toEqual([]);
    const sampleIds = res.state.samples.map((s) => s.id);
    expect(new Set(sampleIds).size).toBe(2);
    const copied = res.state.samples.find((s) => s.id !== 's1');
    expect(copied?.taskId).not.toBe('task1');
    expect(res.state.tasks.some((t) => t.id === copied?.taskId)).toBe(true);
    // 引用也要指向新副本，不能指向旧记录
    const copiedAnalysis = res.state.analyses.find((a) => a.sampleId === copied?.id);
    expect(copiedAnalysis).toBeDefined();
    const copiedRule = res.state.rules.find((r) => r.id !== 'r1');
    expect(copiedRule?.evidence[0].sampleId).toBe(copied?.id);
  });

  it('导入后整体校验失败时放弃本次导入，现有数据不变', async () => {
    const { state } = await sampleState();
    const broken = { ...createBackup(state), samples: [{ id: 'bad' }] };
    const res = applyImport(JSON.stringify(broken), state, 'overwrite');
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.state).toBe(state);
  });
});

describe('A/B 对照：评价前隐藏条件', () => {
  const base = '基础版文本';
  const skill = '加 Skill 版文本';

  it('两种随机结果都能正确复原映射', () => {
    const a = createABPair(base, skill, () => 0.1); // skill 排到 A
    expect(a.items.find((i) => i.label === 'A')?.text).toBe(skill);
    expect(revealCondition(a, 'A')).toBe('skill');
    expect(revealCondition(a, 'B')).toBe('base');

    const b = createABPair(base, skill, () => 0.9); // base 排到 A
    expect(b.items.find((i) => i.label === 'A')?.text).toBe(base);
    expect(revealCondition(b, 'A')).toBe('base');
    expect(revealCondition(b, 'B')).toBe('skill');
  });

  it('条目里只有 A/B 标签与正文，不含任何条件信息', () => {
    const pair = createABPair(base, skill, () => 0.3);
    for (const item of pair.items) {
      expect(Object.keys(item).sort()).toEqual(['label', 'text']);
    }
  });

  it('随机排布不是恒定顺序', () => {
    let skillFirst = 0;
    for (let i = 0; i < 200; i += 1) {
      const pair = createABPair(base, skill);
      if (revealCondition(pair, 'A') === 'skill') skillFirst += 1;
    }
    expect(skillFirst).toBeGreaterThan(50);
    expect(skillFirst).toBeLessThan(150);
  });
});

/**
 * 区域 5：规则确认与 Skill 预览。
 * - 候选规则必须由作者亲手决定：接受 / 修改说法（要填理由，原说法保留）/ 拒绝；
 * - 失效（stale）的规则醒目提示「需重新确认」，并且不进导出；
 * - Skill 预览与三个下载按钮都来自 shared/export.ts 的 compileExport，UI 只负责传 includeEvidence；
 * - 含 Mock 数据时导出按钮禁用并说明原因。
 */
import { useMemo, useState } from 'react';
import {
  CONSTRAINT_INFLUENCE_LABEL,
  RULE_SCOPE_LABEL,
  type RuleScope,
  type StyleRule,
} from '../../shared/schema';
import { PROMPT_VERSION } from '../../shared/limits';
import { recomputeAllRules, selectExportableRules, findPreviousConflicts } from '../../shared/rules';
import { compileExport } from '../../shared/export';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyHint,
  Field,
  HighlightedText,
  KeyValue,
  PlainText,
  TextArea,
  TextInput,
  downloadText,
  formatTime,
  newId,
  type PanelNavProps,
} from './common';
import { buildProfile, collectScenes, sampleTitle, useLab } from './store';

export interface RulesPanelProps extends PanelNavProps {}

function EvidenceList({
  rule,
  kind,
}: {
  rule: StyleRule;
  kind: 'support' | 'counter';
}) {
  const { data } = useLab();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const list = kind === 'support' ? rule.evidence : rule.counterEvidence;
  if (list.length === 0) {
    return <p className="hint-line">{kind === 'support' ? '没有原文依据。' : '没有反例记录。'}</p>;
  }
  return (
    <ul className="evidence-list">
      {list.map((ev) => {
        const key = `${ev.sampleId}-${ev.paragraphId}-${ev.quote}`;
        const sample = data.samples.find((s) => s.id === ev.sampleId);
        const paragraph = sample?.paragraphs.find((p) => p.id === ev.paragraphId);
        const alive = paragraph !== undefined && paragraph.text.includes(ev.quote);
        return (
          <li key={key}>
            <button type="button" className="quote-btn" onClick={() => setOpenKey(openKey === key ? null : key)}>
              {sample ? sampleTitle(sample, data) : '（样本已删除）'} · {ev.paragraphId} · r{ev.sampleRevision}：「{ev.quote}」
            </button>
            {!alive && <Badge tone="danger">依据已失效</Badge>}
            {openKey === key && (
              <div className="evidence-body">
                {paragraph && sample ? (
                  <>
                    <p className="paragraph-meta">
                      该段落全文（高亮处为被引用的文字）· {sampleTitle(sample, data)} r{sample.revision}
                    </p>
                    <p className="paragraph-text">
                      <HighlightedText text={paragraph.text} quote={ev.quote} />
                    </p>
                  </>
                ) : (
                  <p className="hint-line">样本或段落已经被删除，这条依据不再成立。</p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RuleCard({ rule }: { rule: StyleRule }) {
  const { data, save } = useLab();
  const [editing, setEditing] = useState(false);
  const [draftStatement, setDraftStatement] = useState(rule.statement);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** 与「别的、已经决定过的规则」讲的是不是同一件事（只提示差异，不覆盖作者决定）。 */
  const conflicts = useMemo(
    () =>
      findPreviousConflicts(
        rule.statement,
        data.rules
          .filter((other) => other.id !== rule.id && other.decision !== 'pending')
          .map((other) => ({ id: other.id, statement: other.statement, decision: other.decision })),
      ),
    [rule.statement, rule.id, data.rules],
  );

  const update = async (patch: Partial<StyleRule>, failureNote: string) => {
    const next: StyleRule = { ...rule, ...patch, updatedAt: new Date().toISOString() };
    const ok = await save('rules', [next]);
    if (!ok) setError(failureNote);
    return ok;
  };

  const decide = (decision: 'accepted' | 'rejected' | 'pending') =>
    void update(
      { decision, decidedAt: decision === 'pending' ? null : new Date().toISOString() },
      '决定没有保存成功（页面顶部有具体原因）。',
    );

  const saveEdit = async () => {
    if (draftStatement.trim() === '') {
      setError('改后的说法不能为空。');
      return;
    }
    if (reason.trim() === '') {
      setError('修改说法必须填写修改理由（原说法会保留，用来对照）。');
      return;
    }
    const ok = await update(
      {
        statement: draftStatement.trim(),
        statementOriginal: rule.statementOriginal ?? rule.statement,
        userEditReason: reason.trim(),
      },
      '修改没有保存成功（页面顶部有具体原因）。',
    );
    if (ok) {
      setEditing(false);
      setReason('');
      setError(null);
    }
  };

  return (
    <Card
      tone={rule.stale ? 'danger' : rule.decision === 'accepted' ? 'ok' : 'neutral'}
      title={
        <span className="task-title">
          {rule.statement}
          <Badge tone="neutral">{RULE_SCOPE_LABEL[rule.scope]}</Badge>
          <Badge tone={rule.origin === 'preference' ? 'info' : 'neutral'}>
            {rule.origin === 'preference' ? '你指定的偏好' : '从样本归纳'}
          </Badge>
          <Badge
            tone={rule.decision === 'accepted' ? 'ok' : rule.decision === 'rejected' ? 'danger' : 'warn'}
          >
            {rule.decision === 'accepted' ? '已接受' : rule.decision === 'rejected' ? '已拒绝' : '待确认'}
          </Badge>
          {rule.stale && <Badge tone="danger">需重新确认</Badge>}
          {rule.mock && <Badge tone="mock">Mock</Badge>}
        </span>
      }
      subtitle={
        rule.statementOriginal
          ? `已修改过说法；原说法保留在下面。修改理由：${rule.userEditReason ?? '（未填）'}`
          : `${rule.supportDescription}`
      }
      actions={
        <>
          <Button variant="primary" onClick={() => decide('accepted')}>
            接受
          </Button>
          <Button onClick={() => setEditing((v) => !v)}>{editing ? '取消修改' : '修改说法'}</Button>
          <Button variant="danger" onClick={() => decide('rejected')}>
            拒绝
          </Button>
          {rule.decision !== 'pending' && <Button onClick={() => decide('pending')}>撤回决定</Button>}
        </>
      }
    >
      {rule.stale && (
        <Banner tone="danger" title="这条规则现在不能导出">
          {rule.staleReason ?? '依据已失效，需要你重新确认。'}（规则本身没有被删掉，你可以改说法、重新接受，或者直接拒绝。）
        </Banner>
      )}
      {rule.statementOriginal && (
        <Banner tone="warn" title="原说法（保留对照，不会被改写）">
          {rule.statementOriginal}
        </Banner>
      )}
      <KeyValue
        items={[
          { key: '适用范围', value: RULE_SCOPE_LABEL[rule.scope] },
          { key: '约束影响', value: CONSTRAINT_INFLUENCE_LABEL[rule.constraintInfluence] },
          { key: '支持说明', value: rule.supportDescription },
          { key: '局限', value: rule.limitations.length > 0 ? rule.limitations.join('；') : '（未记录）' },
          { key: '来源轮次', value: `${rule.derivedFrom.model} · ${rule.derivedFrom.promptVersion} · ${rule.derivedFrom.runId ?? '（无 runId）'}` },
          { key: '决定时间', value: formatTime(rule.decidedAt) },
          { key: '创建 / 更新', value: `${formatTime(rule.createdAt)} / ${formatTime(rule.updatedAt)}` },
        ]}
      />
      {rule.evidence.length === 0 ? (
        <p className="hint-line">
          {rule.origin === 'preference'
            ? '这是你手工指定的偏好，本来就没有原文依据 —— 它代表你的声明，不是从样本里推出来的结论。'
            : '没有原文依据。'}
        </p>
      ) : (
        <>
          <h4 className="sub-title">原文依据（点击展开对应段落）</h4>
          <EvidenceList rule={rule} kind="support" />
        </>
      )}
      <h4 className="sub-title">反例 / 不完全一致的文本</h4>
      <EvidenceList rule={rule} kind="counter" />
      {conflicts.length > 0 && (
        <Banner tone="info" title="与上一轮决定的差异提示（只提示，不覆盖你的决定）">
          这条说法与下面这些你已经决定过的规则讲的很可能是同一件事：
          <ul className="plain-list">
            {conflicts.map((c) => (
              <li key={c.ruleId}>
                [{c.decision === 'accepted' ? '已接受' : c.decision === 'rejected' ? '已拒绝' : '待确认'}] {c.statement}
              </li>
            ))}
          </ul>
          如果这一条更准确，请手动处理上一条（重新确认或撤回），程序不会替你做决定。
        </Banner>
      )}
      {editing && (
        <div className="form-grid">
          <Field label="改后的说法" hint="原说法会保留在 statementOriginal 里，不会伪造支持它的证据。">
            <TextArea rows={3} value={draftStatement} onChange={(e) => setDraftStatement(e.target.value)} />
          </Field>
          <Field label="修改理由（必填）">
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：范围写大了，只在对话场景成立" />
          </Field>
          <div className="form-actions">
            <Button variant="primary" onClick={() => void saveEdit()}>
              保存修改
            </Button>
          </div>
        </div>
      )}
      {error && (
        <Banner tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
    </Card>
  );
}

export function RulesPanel({ onNavigate }: RulesPanelProps) {
  const { data, save } = useLab();
  const [includeEvidence, setIncludeEvidence] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prefStatement, setPrefStatement] = useState('');
  const [prefScope, setPrefScope] = useState<RuleScope>('general');
  const [prefNote, setPrefNote] = useState('');

  const liveRules = useMemo(
    () =>
      recomputeAllRules(data.rules, {
        samples: data.samples,
        analyses: data.analyses,
        preferences: data.preferences,
      }),
    [data.rules, data.samples, data.analyses, data.preferences],
  );

  const exportable = useMemo(() => selectExportableRules(liveRules), [liveRules]);
  const sendable = useMemo(
    () => data.samples.filter((s) => s.useForAnalysis && !s.holdout),
    [data.samples],
  );
  const mockPresent = useMemo(
    () => liveRules.some((r) => r.mock) || data.analyses.some((a) => a.mock),
    [liveRules, data.analyses],
  );
  const nextVersion = useMemo(
    () => (data.profiles.length === 0 ? 1 : Math.max(...data.profiles.map((p) => p.version)) + 1),
    [data.profiles],
  );

  const makeProfile = () =>
    buildProfile({
      rules: exportable,
      samples: sendable,
      model: data.profiles[0]?.model ?? '（无模型信息：尚未有真实分析）',
      promptVersion: PROMPT_VERSION,
      mock: mockPresent,
      version: nextVersion,
      now: new Date().toISOString(),
      coveredScenes: collectScenes(sendable),
    });

  const preview = useMemo(() => {
    const profile = makeProfile();
    return compileExport({
      profile,
      samples: sendable,
      rules: liveRules,
      options: { includeEvidence },
    });
    // makeProfile 依赖的输入已在下面列出
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportable, sendable, liveRules, includeEvidence, mockPresent, nextVersion]);

  const exportDisabled = mockPresent || preview.blocked !== null;

  const doExport = async (kind: 'skill' | 'json' | 'evidence') => {
    if (exportDisabled) return;
    try {
      const profile = makeProfile();
      const result = compileExport({
        profile,
        samples: sendable,
        rules: liveRules,
        options: { includeEvidence },
      });
      if (result.blocked) {
        setError(`导出被拒绝：${result.blocked.reason}`);
        return;
      }
      const saved = await save('profiles', [profile]);
      if (!saved) {
        setError('导出失败：Profile 版本没有写进本地数据库（页面顶部有具体原因）。');
        return;
      }
      if (kind === 'skill') {
        downloadText(`${result.fileNameBase}-SKILL.md`, result.skillMarkdown, 'text/markdown;charset=utf-8');
      } else if (kind === 'json') {
        downloadText(`${result.fileNameBase}-style-profile.json`, result.profileJson, 'application/json;charset=utf-8');
      } else {
        if (result.evidenceMarkdown === null) {
          setError('没有勾选「包含短摘录」，所以不会生成 references/evidence.md。');
          return;
        }
        downloadText(
          `${result.fileNameBase}-evidence.md`,
          result.evidenceMarkdown,
          'text/markdown;charset=utf-8',
        );
      }
      setNotice(`已导出，并把这一版记录为 Profile v${profile.version}（可在历史版本里查到）。`);
      setError(null);
    } catch (err) {
      setError(`导出失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const addPreference = async () => {
    if (prefStatement.trim() === '') {
      setError('手工偏好必须写清说法。');
      return;
    }
    const now = new Date().toISOString();
    const rule: StyleRule = {
      id: newId('rulepref'),
      statement: prefStatement.trim(),
      scope: prefScope,
      origin: 'preference',
      evidence: [],
      counterEvidence: [],
      supportDescription: prefNote.trim() === '' ? '由作者手工指定，没有原文依据。' : `由作者手工指定：${prefNote.trim()}`,
      limitations: [
        '这条偏好是你自己声明的，不是从样本里归纳出来的；它不参与“支持样本数”那类门槛判断。',
        '如果之后想让它变成有依据的规则，需要补上能对上的原文引用。',
      ],
      constraintInfluence: 'author_choice',
      decision: 'accepted',
      statementOriginal: null,
      userEditReason: null,
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
      derivedFrom: { model: 'author', promptVersion: PROMPT_VERSION, runId: null, candidateIndex: 0 },
      stale: false,
      staleReason: null,
      mock: false,
    };
    const ok = await save('rules', [rule]);
    if (!ok) setError('手工偏好保存失败（页面顶部有具体原因）。');
    else {
      setPrefStatement('');
      setPrefNote('');
      setNotice('已加入一条“你指定的偏好”，默认是已接受状态。');
    }
  };

  const groups: { key: string; title: string; hint: string; rules: StyleRule[] }[] = [
    {
      key: 'stale',
      title: '需重新确认（依据已失效，不能导出）',
      hint: '样本被删、正文改版、来源改成不可入选、或支持样本不够了，都会落到这里。',
      rules: liveRules.filter((r) => r.stale),
    },
    {
      key: 'pending',
      title: '待确认的候选规则',
      hint: '每条都要你亲手决定：接受 / 修改说法 / 拒绝。',
      rules: liveRules.filter((r) => !r.stale && r.decision === 'pending'),
    },
    {
      key: 'accepted',
      title: '已接受（会写进 SKILL.md）',
      hint: '只有「已接受 + 未失效 + 非 Mock」的规则才会进入导出。',
      rules: liveRules.filter((r) => !r.stale && r.decision === 'accepted'),
    },
    {
      key: 'rejected',
      title: '已拒绝 / 已撤回',
      hint: '拒绝的规则不会被删除，留在这里作为你的判断记录。',
      rules: liveRules.filter((r) => r.decision === 'rejected'),
    },
  ];

  return (
    <div className="panel">
      <Card
        title="第 3 步 · 规则确认"
        subtitle="程序只做确定性检查（引用能不能对上、支持样本够不够）；「这算不算你的风格」由你决定。"
        actions={
          <>
            <Button onClick={() => onNavigate('analysis')}>回分析页</Button>
            <Button onClick={() => onNavigate('tryout')}>去试写</Button>
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
        <div className="stat-row">
          <Badge tone="info">规则 {liveRules.length} 条</Badge>
          <Badge tone="warn">待确认 {groups[1].rules.length}</Badge>
          <Badge tone="ok">已接受 {groups[2].rules.length}</Badge>
          <Badge tone="danger">需重新确认 {groups[0].rules.length}</Badge>
          <Badge tone="neutral">已拒绝 {groups[3].rules.length}</Badge>
          {mockPresent && <Badge tone="mock">含 Mock 数据</Badge>}
        </div>
        {liveRules.length === 0 && (
          <EmptyHint>还没有候选规则。先去「分析」页做逐篇分析，再做一次归纳。</EmptyHint>
        )}

        <div className="form-grid">
          <h4 className="sub-title">手工新增：本人指定偏好</h4>
          <Field label="说法" hint="例如：我习惯让对话自己推进情节，不写解释性旁白。">
            <TextArea rows={2} value={prefStatement} onChange={(e) => setPrefStatement(e.target.value)} />
          </Field>
          <div className="form-row">
            <Field label="适用范围">
              <select
                className="input"
                value={prefScope}
                onChange={(e) => setPrefScope(e.target.value as RuleScope)}
              >
                <option value="general">{RULE_SCOPE_LABEL.general}</option>
                <option value="scenario_specific">{RULE_SCOPE_LABEL.scenario_specific}</option>
                <option value="preliminary">{RULE_SCOPE_LABEL.preliminary}</option>
              </select>
            </Field>
            <Field label="备注（可选）">
              <TextInput value={prefNote} onChange={(e) => setPrefNote(e.target.value)} />
            </Field>
          </div>
          <div className="form-actions">
            <Button variant="primary" onClick={() => void addPreference()}>
              加入偏好（默认已接受）
            </Button>
          </div>
        </div>
      </Card>

      {groups.map((group) =>
        group.rules.length === 0 ? null : (
          <div className="rule-group" key={group.key}>
            <h3 className="group-title">
              {group.title}（{group.rules.length}）
            </h3>
            <p className="hint-line">{group.hint}</p>
            {group.rules.map((rule) => (
              <RuleCard key={rule.id} rule={rule} />
            ))}
          </div>
        ),
      )}

      <Card
        title="第 4 步 · Skill 预览与导出"
        subtitle="SKILL.md 的内容由 shared/export.ts 的 compileExport 生成，界面只负责把 includeEvidence 传进去。"
        actions={
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeEvidence}
                onChange={(e) => setIncludeEvidence(e.target.checked)}
              />
              包含短摘录（references/evidence.md）
            </label>
            <Button variant="primary" disabled={exportDisabled} onClick={() => void doExport('skill')}>
              下载 SKILL.md
            </Button>
            <Button disabled={exportDisabled} onClick={() => void doExport('json')}>
              下载 style-profile.json
            </Button>
            <Button disabled={exportDisabled || !includeEvidence} onClick={() => void doExport('evidence')}>
              下载 references/evidence.md
            </Button>
          </>
        }
      >
        {mockPresent && (
          <Banner tone="danger" title="导出已禁用：当前数据里含 Mock 结果">
            至少有一条规则或一次分析来自 Mock（服务端没有配置真实分析或开了 Mock 开关）。Mock 数据不能当作作者风格的正式依据，
            导出按钮已禁用。配置好 API Key、重新分析并重新归纳后即可导出。
          </Banner>
        )}
        {preview.blocked && (
          <Banner tone="danger" title="compileExport 拒绝了这次导出">
            {preview.blocked.reason}
          </Banner>
        )}
        {preview.empty && (
          <Banner tone="warn" title="只能导出空模板">
            你还没有接受任何规则（或者已接受的规则都失效了）。这时导出的 SKILL.md 只是一份空模板：写明“暂无已确认规则”，
            不会凭空生成任何风格描述。
          </Banner>
        )}
        <div className="stat-row">
          <Badge tone="info">可导出规则 {exportable.length} 条</Badge>
          <Badge tone="neutral">将记录为 Profile v{nextVersion}</Badge>
          <Badge tone={includeEvidence ? 'warn' : 'neutral'}>
            {includeEvidence ? 'SKILL.md 会带短摘录引用' : 'SKILL.md 不含摘录链接'}
          </Badge>
          <Badge tone="neutral">文件前缀 {preview.fileNameBase}</Badge>
        </div>
        <p className="hint-line">
          未勾选「包含短摘录」时不会生成 references/evidence.md，SKILL.md 里也不会出现指向它的链接（这一点由 compileExport 保证）。
          备份文件（设置页）是另一回事：备份含私人正文，不能当 Skill 分发。
        </p>
        <h4 className="sub-title">SKILL.md 预览（纯文本）</h4>
        <PlainText text={preview.skillMarkdown} className="preview" />
        {includeEvidence && preview.evidenceMarkdown !== null && (
          <>
            <h4 className="sub-title">references/evidence.md 预览（纯文本）</h4>
            <PlainText text={preview.evidenceMarkdown} className="preview" />
          </>
        )}
        <div className="form-actions">
          <Button onClick={() => onNavigate('tasks')}>回样本库</Button>
          <Button onClick={() => onNavigate('tryout')}>去做 A/B 试写</Button>
        </div>
      </Card>
    </div>
  );
}

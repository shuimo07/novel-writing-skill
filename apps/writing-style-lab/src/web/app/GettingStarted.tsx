/**
 * 三分钟上手：只在「还没有任何样本」时出现在首屏。
 *
 * 目的有两个：
 * 1. 说清楚这工具怎么用（选题目 → 亲写或丢样本 → 分析并确认 → 导出 Skill）；
 * 2. 给一个「载入示例数据」的按钮，让人（尤其还没填 Key 的人）立刻能跑一遍完整流程。
 */
import { useState } from 'react';
import { Badge, Banner, Button, Card } from './common';
import { useLab } from './store';
import { EXAMPLE_DOC_IDS, EXAMPLE_SAMPLE_IDS, buildExampleData } from './exampleData';
import { STATIC_DEMO } from '../api';

export function GettingStarted() {
  const { data, save, removeSamples, removeSourceDocuments } = useLab();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const loadedExamples = data.samples.filter((sample) => EXAMPLE_SAMPLE_IDS.includes(sample.id));

  if (dismissed) return null;

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const { documents, samples } = await buildExampleData();
      const okDocs = await save('sourceDocuments', documents);
      const okSamples = await save('samples', samples);
      if (okDocs && okSamples) {
        setMessage(`已载入 ${samples.length} 篇示例样本。它们看起来跟真样本一样，你可以直接拿去分析，或者随手删掉。`);
      } else {
        setError('写入本地库失败（页面顶部有具体原因）。');
      }
    } catch (err) {
      setError(`载入示例失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeSamples(EXAMPLE_SAMPLE_IDS);
      await removeSourceDocuments(EXAMPLE_DOC_IDS);
      setMessage('示例数据已删除（你自己写的样本不受影响）。');
    } catch (err) {
      setError(`删除示例失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="三分钟上手"
      subtitle="这个工作台就干一件事：把你自己的文字变成一份可核查的文风指令。"
      actions={<Badge tone="info">第一次用？看这里</Badge>}
    >
      <ol className="guide-steps">
        <li>
          <strong>选题目</strong>：在「① 任务与样本库」挑一张任务卡（也可以自己改题目）。
          题目只管人物、目标、事件和长度——你额外加的「全用短句」这类要求会被单独记成框架约束，分析时会区别对待。
        </li>
        <li>
          <strong>写样本，或者直接丢样本</strong>：在「② 写作编辑区」按题目写；
          已经有写好的旧文，就走去「③ 直接采样」粘贴/导入——那一路是只读的，程序一个字都不会改你的原文。
          4—6 篇是建议，不是门槛；样本少也能分析，只是会标成「初步观察」。
        </li>
        <li>
          <strong>分析 → 确认规则 → 导出</strong>：在「④ 分析」看每条观察的原文依据；
          到「⑤ 规则与 Skill」逐条接受/修改/拒绝，再导出 <code>SKILL.md</code>。
          最后在「⑥ 试写」换个新题目做 A/B 盲评，看看到底像不像你。
        </li>
      </ol>

      <div className="action-row">
        <Button variant="primary" disabled={busy} onClick={() => void load()}>
          {busy ? '处理中…' : '载入示例数据'}
        </Button>
        {loadedExamples.length > 0 && (
          <Button variant="danger" disabled={busy} onClick={() => void clear()}>
            删除示例数据
          </Button>
        )}
        <Button disabled={busy} onClick={() => setDismissed(true)}>
          知道了，我自己写
        </Button>
      </div>

      {message && <p className="hint-line">{message}</p>}
      {error && (
        <Banner tone="danger" title="没能完成">
          {error}
        </Banner>
      )}

      <p className="hint-line">
        示例数据是内置的占位文本（不是你的作品），载入后可以直接点「分析」看看效果。
        {STATIC_DEMO
          ? ' 还没填 API Key 也没关系：在「④ 分析」勾上「试玩」就能用本机占位数据跑完整流程（不联网、不花钱，结果带 Mock 标记、不能导出为正式 Skill）。'
          : ' 本地版没有 Key 时同样可以在「④ 分析」勾「Mock」自检链路。'}
      </p>
    </Card>
  );
}

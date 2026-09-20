/**
 * 内置示例数据：让第一次打开的人（尤其是没填 Key 的人）也能立刻看到完整流程。
 *
 * 全部是本机生成的真实结构（走同一套 schema 与 hash 计算），不联网、不调模型。
 * 每篇都标了「示例数据」备注与醒目标题，作者可以随手删掉。
 */
import { contentHash, receiptFeatures, splitParagraphs } from '../../shared/text';
import type { Sample, SourceDocument } from '../../shared/schema';

export const EXAMPLE_NOTE = '示例数据：内置占位文本，可随时删除';

const nowIso = () => new Date().toISOString();

interface ExampleText {
  key: string;
  title: string;
  scene: string;
  text: string;
}

/** 刻意写成三种不同质感，方便看出「归纳」在干什么。 */
const EXAMPLES: ExampleText[] = [
  {
    key: 'rain',
    title: '示例 · 雨天等车（短句、动作多）',
    scene: '熟悉地点',
    text: `雨小了。他把伞收起来，抖了两下，靠在站牌边。

车还没来。他掏出手机，看了一眼，又塞回兜里。

旁边的老太太挪了挪脚。他往边上让了半步。

路灯亮着，水面上浮着一层黄。他盯着那层黄，没动。

车来了。他最后一个上去。\n`,
  },
  {
    key: 'secret',
    title: '示例 · 两个人心照不宣（对话多）',
    scene: '对话',
    text: `「你昨天几点回来的？」

「不记得了。」

她把碗放进水池，水开着，没关。

「我给你留了饭。」

「我看见了。」他站在门口，没往里走，「我先去洗个澡。」

水声停了。她擦着手，抬了一下眼睛。

「行。」她说，「锅在灶上，凉了你自己热。」\n`,
  },
  {
    key: 'oldplace',
    title: '示例 · 旧地重游（长句、叙述视角）',
    scene: '情绪表达',
    text: `再一次站在那条巷口的时候，他才发现原本贴着墙根长的那排爬山虎早就被人铲干净了，只剩下几道颜色发白的印子，像谁用手指在灰墙上划过。

午后的光斜斜地切进来，把整条巷子分成明暗两半，他站在暗的那边，看着尽头那扇重新刷过漆的木门，忽然想不起自己当年到底为什么要在这扇门前坐那么久。

风从背后过来，带着一点油烟味。他往前走了两步，又停下，最后转身走了。\n`,
  },
];

export interface ExampleData {
  documents: SourceDocument[];
  samples: Sample[];
}

/**
 * 生成示例数据。ID 固定，重复点击是幂等的（save 按 id 覆盖，不会越点越多）。
 */
export async function buildExampleData(): Promise<ExampleData> {
  const documents: SourceDocument[] = [];
  const samples: Sample[] = [];
  const timestamp = nowIso();

  for (const [index, example] of EXAMPLES.entries()) {
    const text = example.text;
    const hash = await contentHash(text);
    const docId = `demo-doc-${example.key}`;
    documents.push({
      id: docId,
      title: example.title,
      importMethod: 'paste',
      sourceFileName: null,
      text,
      contentHash: hash,
      receipt: receiptFeatures(text),
      declaredSourceType: 'self_old',
      backgroundContext: EXAMPLE_NOTE,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    samples.push({
      id: `demo-sample-${example.key}`,
      revision: 1,
      entryMode: 'direct',
      taskId: null,
      taskVersion: null,
      taskConstraintsHash: null,
      sourceDocumentId: docId,
      fragment: null,
      sourceType: 'self_old',
      text,
      contentHash: hash,
      paragraphs: splitParagraphs(text),
      sceneTags: [example.scene],
      useForAnalysis: true,
      holdout: false,
      partial: false,
      partialNote: null,
      backgroundContext: EXAMPLE_NOTE,
      authorNote: `${EXAMPLE_NOTE}（第 ${index + 1} 篇）`,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  return { documents, samples };
}

export const EXAMPLE_SAMPLE_IDS = EXAMPLES.map((example) => `demo-sample-${example.key}`);
export const EXAMPLE_DOC_IDS = EXAMPLES.map((example) => `demo-doc-${example.key}`);

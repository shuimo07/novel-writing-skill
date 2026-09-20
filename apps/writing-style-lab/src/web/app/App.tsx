/**
 * 应用外壳：任务导航（6 个区域）+ 全局错误横幅。
 * 不是聊天界面：每个区域是一屏任务，按钮是明确的动作。
 */
import { useState } from 'react';
import { Badge, Banner, Button, type TabKey } from './common';
import { AnalysisPanel } from './AnalysisPanel';
import { ApiKeyPanel } from './ApiKeyPanel';
import { DirectSamplingPanel } from './DirectSamplingPanel';
import { EditorPanel } from './EditorPanel';
import { GettingStarted } from './GettingStarted';
import { RulesPanel } from './RulesPanel';
import { TasksPanel } from './TasksPanel';
import { TryoutPanel } from './TryoutPanel';
import { LabProvider, useLab } from './store';
import { STATIC_DEMO } from '../api';
import { hasCredentials } from '../directCredentials';

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'tasks', label: '① 任务与样本库', hint: '内置任务卡、样本清单、两个写作入口' },
  { key: 'editor', label: '② 写作编辑区', hint: '按题目写、自动保存、提交为样本' },
  { key: 'direct', label: '③ 直接采样', hint: '把已经写好的文字丢进来' },
  { key: 'analysis', label: '④ 分析', hint: '待发送清单、逐篇分析、原文依据' },
  { key: 'rules', label: '⑤ 规则与 Skill', hint: '逐条确认规则、预览与导出' },
  { key: 'tryout', label: '⑥ 试写·历史·设置', hint: '盲评 A/B、历史版本、备份与状态' },
];

function Shell() {
  const { ready, fatalError, writeError, dismissWriteError, status, statusError, data } = useLab();
  const [tab, setTab] = useState<TabKey>('tasks');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [draftSignal, setDraftSignal] = useState(0);
  // 默认收起：首屏先让人看到工具本身，别一进来就像在配置机器。
  const [showKeyPanel, setShowKeyPanel] = useState(false);
  const keyReady = STATIC_DEMO && hasCredentials();

  const navigate = (next: TabKey) => setTab(next);
  const bumpDraft = () => setDraftSignal((n) => n + 1);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <h1>文风采样器</h1>
          <p className="app-subtitle">
            作者亲写样本 → 逐篇分析 → 可核查的规则 → 你自己确认 → 导出 SKILL.md。数据全部存在本机浏览器里。
          </p>
        </div>
        <div className="app-status">
          {status === null ? (
            <Badge tone="warn" title={statusError ?? ''}>
              本地服务状态未知
            </Badge>
          ) : (
            <>
              <Badge tone={status.apiKeyConfigured ? 'ok' : STATIC_DEMO ? 'warn' : 'danger'}>
                {status.apiKeyConfigured
                  ? 'API Key 已配置'
                  : STATIC_DEMO
                    ? '未填 Key（分析/试写需要）'
                    : '未配置真实分析'}
              </Badge>
              {status.mockEnabled && <Badge tone="mock">Mock 模式</Badge>}
              <Badge tone="neutral">{status.model}</Badge>
              <Badge tone="neutral">prompt {status.promptVersion}</Badge>
            </>
          )}
          {!ready && <Badge tone="neutral">正在读取本地数据…</Badge>}
        </div>
      </header>

      <nav className="app-nav" aria-label="区域导航">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={tab === item.key ? 'nav-btn nav-btn-active' : 'nav-btn'}
            title={item.hint}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <p className="nav-hint">{TABS.find((item) => item.key === tab)?.hint}</p>

      {STATIC_DEMO && (
        <>
          {/* 首屏只留一行：先让人看到工具本身；长说明与 Key 输入都收在面板里。 */}
          <div className="demo-strip">
            <span className="demo-strip-text">
              在线版（无服务端）：写作、样本库、直接采样、备份与导出开箱可用；
              <strong>分析与试写</strong>需要你自己的 API Key——它只存在你的浏览器里，不会发给本站。
            </span>
            <span className="demo-strip-actions">
              {keyReady && <Badge tone="ok">Key 已配置</Badge>}
              <Button variant={keyReady ? 'default' : 'primary'} onClick={() => setShowKeyPanel((value) => !value)}>
                {showKeyPanel ? '收起' : keyReady ? '更换 Key' : '填 API Key'}
              </Button>
            </span>
          </div>
          {showKeyPanel && <ApiKeyPanel />}
        </>
      )}
      {fatalError && (
        <Banner tone="danger" title="本地数据读取失败">
          {fatalError}
          <br />
          这样界面上的任何改动都不会被保存。请检查浏览器是否禁用了 IndexedDB（隐私模式常见），修复后刷新页面。
        </Banner>
      )}
      {writeError && (
        <Banner tone="danger" title="写入本地数据库失败" onDismiss={dismissWriteError}>
          {writeError}
        </Banner>
      )}
      {statusError && (
        <Banner tone="warn" title="本地服务没有响应">
          {statusError}（分析、归纳与试写暂时不可用；样本编辑与规则确认不受影响。）
        </Banner>
      )}

      <main className="app-main">
        {ready && data.samples.length === 0 && <GettingStarted />}
        {tab === 'tasks' && (
          <TasksPanel
            onNavigate={navigate}
            activeTaskId={activeTaskId}
            onSelectTask={setActiveTaskId}
            onDraftLoaded={bumpDraft}
          />
        )}
        {tab === 'editor' && (
          <EditorPanel
            onNavigate={navigate}
            activeTaskId={activeTaskId}
            onSelectTask={setActiveTaskId}
            draftSignal={draftSignal}
          />
        )}
        {tab === 'direct' && <DirectSamplingPanel onNavigate={navigate} onDraftLoaded={bumpDraft} />}
        {tab === 'analysis' && <AnalysisPanel onNavigate={navigate} onSelectTask={setActiveTaskId} />}
        {tab === 'rules' && <RulesPanel onNavigate={navigate} />}
        {tab === 'tryout' && <TryoutPanel onNavigate={navigate} />}
      </main>

      <footer className="app-footer">
        {STATIC_DEMO ? (
          <p>
            静态直连模式：本页只有前端，没有服务端，也不含任何密钥。模型调用由你填的 Key 直连 DeepSeek 完成，
            花的是你自己的额度；Key 只存在浏览器内存里（勾选后也只到本标签页），不进 localStorage、不进备份、不进导出。
            你的正文与规则只存在你自己浏览器的 IndexedDB 里。想用服务端托管 Key 的本地版，请跑 `npm run dev`。
          </p>
        ) : (
          <p>
            本地单用户工具：没有账号、没有云端同步，数据只在这台机器的浏览器里。API Key 只保存在服务端进程的环境变量里，
            前端不发、不存。所有正文一律按纯文本处理。
          </p>
        )}
      </footer>
    </div>
  );
}

export function App() {
  return (
    <LabProvider>
      <Shell />
    </LabProvider>
  );
}

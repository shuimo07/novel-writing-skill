/**
 * 模型凭据面板（只在静态直连模式显示）。
 *
 * 这里做的事很少，但每一条都是刻意的：
 * - Key 默认只进内存；勾选「本标签页内记住」才进 sessionStorage（关标签页即失效），**永不进 localStorage**；
 * - 界面只回显末 4 位，不提供「显示完整 Key」；
 * - 清除按钮立刻从内存与本标签页抹掉；
 * - 说明里写清：只发给 api.deepseek.com，不经过任何中转，也不写进备份与导出。
 */
import { useState } from 'react';
import { Badge, Banner, Button, Card, Field, TextInput } from './common';
import {
  DEFAULT_BASE_URL,
  DIRECT_MODEL_DEFAULT,
  clearCredentials,
  getCredentials,
  isCustomEndpoint,
  isRememberedForThisTab,
  maskKey,
  normalizeBaseUrl,
  saveCredentials,
} from '../directCredentials';
import { useLab } from './store';

export function ApiKeyPanel() {
  const { refreshStatus } = useLab();
  const [keyInput, setKeyInput] = useState('');
  const [modelInput, setModelInput] = useState(getCredentials()?.model ?? DIRECT_MODEL_DEFAULT);
  const [baseUrlInput, setBaseUrlInput] = useState(getCredentials()?.baseUrl ?? DEFAULT_BASE_URL);
  const [remember, setRemember] = useState(isRememberedForThisTab());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = getCredentials();
  const customEndpoint = isCustomEndpoint(baseUrlInput);

  const handleSave = async () => {
    setError(null);
    if (keyInput.trim() === '') {
      setError('请先粘贴你自己的 API Key。');
      return;
    }
    if (normalizeBaseUrl(baseUrlInput) === null) {
      setError('端点地址必须以 https:// 开头（明文 http 会把 Key 暴露在链路上，本工具不接受）。');
      return;
    }
    saveCredentials({ apiKey: keyInput, model: modelInput, baseUrl: baseUrlInput, rememberForThisTab: remember });
    setKeyInput('');
    setMessage(
      remember
        ? '已保存在本标签页：关掉标签页就会失效，不会写进 localStorage。'
        : '已保存在本页内存：刷新页面即失效。',
    );
    await refreshStatus();
  };

  const handleClear = async () => {
    clearCredentials();
    setKeyInput('');
    setMessage('已从内存与本标签页清除。');
    setError(null);
    await refreshStatus();
  };

  return (
    <Card
      title="模型凭据（静态直连模式）"
      subtitle="这个页面没有服务端，所以分析、归纳、试写要用你自己的 API Key（默认 DeepSeek，也能换成任何 OpenAI 兼容端点）。"
      actions={
        current ? (
          <Badge tone="ok">已配置 {maskKey(current.apiKey)}</Badge>
        ) : (
          <Badge tone="warn">未填写 Key</Badge>
        )
      }
    >
      <Banner tone="info" title="Key 会去哪里">
        {customEndpoint ? (
          <>
            Key 只会发给上面这个自定义端点。本站没有服务端，也没有任何中转；它不会写进 localStorage、IndexedDB、
            备份文件或导出的 Skill，也不会出现在界面回显与错误信息里。
          </>
        ) : (
          <>
            Key 只发给 <code>https://api.deepseek.com</code>，不经过本站或任何第三方中转；它不会写进
            localStorage、IndexedDB、备份文件、导出的 Skill，也不会出现在界面回显与错误信息里。页面不加载任何第三方脚本。
          </>
        )}
      </Banner>

      <div className="key-grid">
        <Field label="API Key">
          <TextInput
            type="password"
            value={keyInput}
            autoComplete="off"
            spellCheck={false}
            placeholder={current ? `已配置 ${maskKey(current.apiKey)}，要更换就粘贴新的` : 'sk-...'}
            onChange={(e) => setKeyInput(e.target.value)}
          />
        </Field>
        <Field label="模型名" hint="默认 deepseek-flash；换端点时这里也要改成对方支持的模型名。">
          <TextInput value={modelInput} spellCheck={false} onChange={(e) => setModelInput(e.target.value)} />
        </Field>
      </div>

      <Field
        label="端点（OpenAI 兼容）"
        hint="默认 DeepSeek 官方。要换成别的服务，填它的基础地址即可（会自动拼 /chat/completions）。"
      >
        <TextInput value={baseUrlInput} spellCheck={false} onChange={(e) => setBaseUrlInput(e.target.value)} />
      </Field>

      {customEndpoint && (
        <Banner tone="warn" title="你改了端点：Key 会发给这个地址">
          「{normalizeBaseUrl(baseUrlInput) ?? baseUrlInput}」会收到你的 Key，并且请求内容（含你的正文）也会发给它。
          只填你自己信任的服务；公共免费代理不建议用于私人稿件。另外该服务必须允许浏览器跨域调用（CORS），
          否则请求会被浏览器拦下——那种情况请改用本地版（服务端转发）。
        </Banner>
      )}

      <label className="check-line">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        在本标签页内记住（sessionStorage；关掉标签页即失效，刷新还在）
      </label>

      <div className="action-row">
        <Button variant="primary" onClick={() => void handleSave()}>
          保存到本页
        </Button>
        <Button onClick={() => void handleClear()} disabled={current === null && keyInput === ''}>
          清除 Key
        </Button>
      </div>

      {message && <p className="hint-line">{message}</p>}
      {error && <Banner tone="danger" title="没能保存">{error}</Banner>}

      <p className="hint-line">
        用你自己的 Key，花的是你自己的额度，和本站（以及原作者）无关。不填 Key 也能用：写作、样本库、直接采样、
        本地统计、备份恢复、规则确认、Skill 预览与导出——这些都不调用模型。
      </p>
    </Card>
  );
}

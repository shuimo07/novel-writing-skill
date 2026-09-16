/**
 * 通用 UI 片段与纯工具函数。
 * 注意：正文与 Markdown 一律按纯文本渲染（<pre> / 文本节点），全项目不使用 dangerouslySetInnerHTML。
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import type { Usage } from '../../shared/schema';

/* --------------------------------------------------------------- 基础组件 */

export type TabKey = 'tasks' | 'editor' | 'direct' | 'analysis' | 'rules' | 'tryout';

export interface PanelNavProps {
  onNavigate: (tab: TabKey) => void;
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'mock';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Button({
  variant = 'default',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  return (
    <button type="button" className={`btn btn-${variant}`} {...rest}>
      {children}
    </button>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  tone = 'neutral',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <section className={`card card-${tone}`}>
      {(title || actions) && (
        <header className="card-head">
          <div className="card-head-text">
            {title && <h3 className="card-title">{title}</h3>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  onDismiss,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <div className="banner-body">
        {title && <strong className="banner-title">{title}</strong>}
        {children && <div className="banner-text">{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="banner-close" onClick={onDismiss} aria-label="关闭提示">
          ×
        </button>
      )}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input textarea ${props.className ?? ''}`} />;
}

/** 纯文本展示块：不解析 Markdown，不注入 HTML。 */
export function PlainText({ text, className }: { text: string; className?: string }) {
  return <pre className={`plain-text ${className ?? ''}`}>{text}</pre>;
}

/** 把 paragraph 文本里的一段 quote 高亮出来，其余仍是纯文本节点。 */
export function HighlightedText({ text, quote }: { text: string; quote: string | null }) {
  if (!quote || quote.length === 0) return <>{text}</>;
  const at = text.indexOf(quote);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="hl">{quote}</mark>
      {text.slice(at + quote.length)}
    </>
  );
}

export function KeyValue({ items }: { items: { key: string; value: ReactNode }[] }) {
  return (
    <dl className="kv">
      {items.map((item) => (
        <div className="kv-row" key={item.key}>
          <dt>{item.key}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="empty-hint">{children}</p>;
}

/* ------------------------------------------------------------------ 工具 */

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatUsage(usage: Usage): string {
  const { promptTokens, completionTokens, totalTokens } = usage;
  if (promptTokens === null && completionTokens === null && totalTokens === null) return '未知（服务端未返回用量）';
  return `输入 ${promptTokens ?? '未知'} / 输出 ${completionTokens ?? '未知'} / 合计 ${totalTokens ?? '未知'}`;
}

/** 场景标签输入：中英文逗号、顿号、分号、换行都能分，去空去重。 */
export function parseSceneTags(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[,，、;；\n\r\t]+/u)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
}

export function downloadText(fileName: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立刻回收会让部分浏览器来不及下载，延迟一点。
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export interface ReadTextResult {
  text: string;
  encodingNote: string | null;
}

/**
 * 读本地文本文件。
 * 用 `ignoreBOM: true` 解码，才能如实保留并显示「含 BOM」这一接收特征（Blob.text() 会悄悄吃掉 BOM）。
 * 先按严格 UTF-8 解；失败再按 GBK 退一次（中文 Windows 的 TXT 常见），仍失败则宽松 UTF-8。
 */
export async function readTextFile(file: File): Promise<ReadTextResult> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encodingNote: null };
  } catch {
    try {
      const text = new TextDecoder('gbk', { ignoreBOM: true }).decode(bytes);
      return {
        text,
        encodingNote: `「${file.name}」不是合法 UTF-8，已按 GBK 解码。若显示乱码，请另存为 UTF-8 后重新导入。`,
      };
    } catch {
      return {
        text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
        encodingNote: `「${file.name}」编码无法确定，已按 UTF-8 宽松解码，个别字符可能已损坏。`,
      };
    }
  }
}

/** 正文摘要，用于列表标题（不改变原文）。 */
export function summarizeText(text: string, maxChars = 24): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length === 0) return '（空正文）';
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

export const OBSERVATION_SCOPE_LABEL: Record<'sample_only' | 'scenario' | 'cross_sample', string> = {
  sample_only: '仅本篇',
  scenario: '该场景',
  cross_sample: '跨样本',
};

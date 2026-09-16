/**
 * BYOK（访客自带 Key）凭据保管。
 *
 * 硬规则：
 * - **绝不写进 localStorage / IndexedDB / 备份 / 导出 / 日志**。原项目要求「Key 不进浏览器持久存储」，
 *   这里是唯一被允许的例外场景（静态站点没有服务端），因此做了三重收口：
 *   默认只放内存；勾选「本标签页内记住」才进 sessionStorage（关标签页即失效）；不提供长期保存。
 * - 只发给 `https://api.deepseek.com`，不经过任何第三方中继。
 * - 任何地方都不打印、不回显完整 Key（界面只显示末 4 位）。
 */

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DIRECT_ENDPOINT = `${DEFAULT_BASE_URL}/chat/completions`;
export const DIRECT_MODEL_DEFAULT = 'deepseek-flash';
export const SESSION_STORAGE_KEY = 'wsl.direct.credentials';

export interface DirectCredentials {
  apiKey: string;
  model: string;
  /** OpenAI 兼容端点的基础地址；默认 DeepSeek 官方。 */
  baseUrl: string;
}

/**
 * 规范化端点地址：只接受 https；空值回落默认；结尾斜杠去掉；
 * 允许用户直接粘完整的 `.../chat/completions`（不会重复拼接）。
 */
export function normalizeBaseUrl(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (raw === '') return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** 由基础地址拼出 chat/completions；已经带了就直接用。 */
export function chatCompletionsUrl(baseUrl: string | null | undefined): string {
  const base = normalizeBaseUrl(baseUrl) ?? DEFAULT_BASE_URL;
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

/** 非默认端点时的提醒文案（用于界面警告）。 */
export function isCustomEndpoint(baseUrl: string | null | undefined): boolean {
  return (normalizeBaseUrl(baseUrl) ?? DEFAULT_BASE_URL) !== DEFAULT_BASE_URL;
}

let inMemory: DirectCredentials | null = null;

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readSession(): DirectCredentials | null {
  const store = sessionStore();
  if (!store) return null;
  const raw = store.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DirectCredentials>;
    if (typeof parsed.apiKey !== 'string' || parsed.apiKey.trim() === '') return null;
    return {
      apiKey: parsed.apiKey,
      model: typeof parsed.model === 'string' && parsed.model.trim() !== '' ? parsed.model : DIRECT_MODEL_DEFAULT,
      baseUrl: normalizeBaseUrl(parsed.baseUrl) ?? DEFAULT_BASE_URL,
    };
  } catch {
    return null;
  }
}

/** 当前凭据：内存优先，其次（仅当作者勾选了记住）本标签页的 sessionStorage。 */
export function getCredentials(): DirectCredentials | null {
  if (inMemory) return inMemory;
  const fromSession = readSession();
  if (fromSession) inMemory = fromSession;
  return inMemory;
}

export function hasCredentials(): boolean {
  return getCredentials() !== null;
}

export function saveCredentials(input: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  rememberForThisTab: boolean;
}): DirectCredentials {
  const credentials: DirectCredentials = {
    apiKey: input.apiKey.trim(),
    model: (input.model ?? DIRECT_MODEL_DEFAULT).trim() || DIRECT_MODEL_DEFAULT,
    baseUrl: normalizeBaseUrl(input.baseUrl) ?? DEFAULT_BASE_URL,
  };
  inMemory = credentials;
  const store = sessionStore();
  if (store) {
    if (input.rememberForThisTab) store.setItem(SESSION_STORAGE_KEY, JSON.stringify(credentials));
    else store.removeItem(SESSION_STORAGE_KEY);
  }
  return credentials;
}

export function clearCredentials(): void {
  inMemory = null;
  const store = sessionStore();
  if (store) store.removeItem(SESSION_STORAGE_KEY);
}

export function isRememberedForThisTab(): boolean {
  return sessionStore()?.getItem(SESSION_STORAGE_KEY) !== null;
}

/** 只用于界面显示，绝不返回完整 Key。 */
export function maskKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}

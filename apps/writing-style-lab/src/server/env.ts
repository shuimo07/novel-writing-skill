/**
 * 服务端配置装配 + 唯一的日志入口。
 *
 * 四条不可破的规则：
 * 1. 这里是**唯一**读取 process.env 的地方；`DEEPSEEK_API_KEY` 的值只在本模块内部使用，
 *    对外只暴露 `apiKeyConfigured` 布尔值 —— 绝不返回密钥、密钥片段或密钥长度。
 * 2. 上游端点固定在 https://api.deepseek.com/chat/completions。不接受任何来自请求的目标地址；
 *    环境变量覆盖（DEEPSEEK_BASE_URL）也只允许 api.deepseek.com，否则忽略并给出提醒，
 *    避免本服务被做成“任意目标地址的通用转发代理”。
 * 3. 监听地址固定为 shared/limits.ts 的 LOCAL_HOST（127.0.0.1），不可被环境变量改写。
 * 4. `logMeta` 是本服务唯一的日志出口，只写元信息（路由、状态码、模型、token 数、耗时、错误码），
 *    永远不写请求正文、模型输出正文或密钥。放在这里的理由：deepseek.ts 与 routes.ts 都要用，
 *    放在任何一侧都会形成循环依赖，而本模块不 import 任何其它服务端模块。
 */
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_PORT,
  DEFAULT_TEMPERATURE,
  LOCAL_HOST,
  MAX_CHARS_PER_SAMPLE,
  MAX_EXTRA_RETRIES_PER_BATCH,
  MAX_SAMPLES_PER_BATCH,
  MAX_TOTAL_CHARS_PER_BATCH,
  PRICE_NOTE_CONFIGURED,
  TRYOUT_TARGET_MAX,
  TRYOUT_TARGET_MIN,
} from '../shared/limits';
import type { ErrorCode, StatusResponse, Usage } from '../shared/schema';

/** 固定上游端点：拼接请勿接受外部输入。 */
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
/** baseUrl 覆盖时唯一允许的主机名。 */
const DEEPSEEK_BASE_HOST = 'api.deepseek.com';
/** 默认模型（DEEPSEEK_MODEL 可覆盖）。 */
export const DEFAULT_MODEL = 'deepseek-flash';
/** 试写固定参数：max_tokens=2048、temperature 默认 1.0（基础版与加 Skill 版必须完全一致）。 */
export const TRYOUT_MAX_TOKENS = 2048;
export const DEFAULT_TRYOUT_TEMPERATURE = 1.0;
/** 请求体上限。 */
export const JSON_BODY_LIMIT = '1mb';
/** 退避重试的等待区间。 */
export const RETRY_BASE_DELAY_MS = 800;
export const RETRY_MAX_DELAY_MS = 8_000;
/** Retry-After 超过这个值就不再干等，直接按额度不足返回（避免请求悬挂）。 */
export const RETRY_AFTER_MAX_MS = 60_000;
/** 没有 dist/web 时给浏览器的一句提示。 */
export const HINT_WITHOUT_WEB_BUILD =
  '未找到前端构建产物 dist/web：请先在 apps/writing-style-lab 目录运行 npm run build（开发时运行 npm run dev，由 Vite 提供前端并代理 /api）。';

export interface ServerEnv {
  /** 仅本模块内部与 deepseek.ts 的调用内部使用，**不得**进入任何响应体或日志。 */
  apiKey: string | null;
  apiKeyConfigured: boolean;
  mockEnabled: boolean;
  model: string;
  endpoint: string;
  analyzeTemperature: number;
  analyzeMaxTokens: number;
  tryoutTemperature: number;
  tryoutMaxTokens: number;
  /** 固定回环地址。 */
  host: string;
  port: number;
  /** 未配置估价时恒为 null（界面显示“未知”）。 */
  priceNote: string | null;
  /** 配置提醒（不含任何敏感值）。 */
  warnings: string[];
}

function readString(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function envNumber(name: string, fallback: number, min: number): number {
  const raw = readString(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return value;
}

function envInt(name: string, fallback: number, min: number): number {
  return Math.floor(envNumber(name, fallback, min));
}

/** 解析上游端点：只允许 api.deepseek.com 的 https。 */
function resolveEndpoint(): { endpoint: string; warning: string | null } {
  const raw = readString('DEEPSEEK_BASE_URL');
  if (raw === null) return { endpoint: DEEPSEEK_ENDPOINT, warning: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { endpoint: DEEPSEEK_ENDPOINT, warning: 'DEEPSEEK_BASE_URL 已忽略：不是合法 URL，继续使用固定端点。' };
  }
  if (url.protocol !== 'https:') {
    return { endpoint: DEEPSEEK_ENDPOINT, warning: 'DEEPSEEK_BASE_URL 已忽略：必须是 https，继续使用固定端点。' };
  }
  if (url.hostname.toLowerCase() !== DEEPSEEK_BASE_HOST) {
    return {
      endpoint: DEEPSEEK_ENDPOINT,
      warning: `DEEPSEEK_BASE_URL 已忽略：只允许主机名 ${DEEPSEEK_BASE_HOST}（本服务不是通用转发代理），继续使用固定端点。`,
    };
  }
  return { endpoint: `${url.origin}/chat/completions`, warning: null };
}

function isMockSwitchOn(): boolean {
  const raw = readString('ALLOW_MOCK_ANALYSIS');
  if (raw === null) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * 每次调用都重新读环境（不做模块级缓存）。这样测试与 `tsx watch` 重启前后拿到的是同一份真实配置，
 * 也不会出现“改了 env 但服务还用旧值”的错觉。
 */
export function readEnv(): ServerEnv {
  const warnings: string[] = [];
  const { endpoint, warning } = resolveEndpoint();
  if (warning) warnings.push(warning);

  const apiKey = readString('DEEPSEEK_API_KEY');
  const port = envInt('PORT', DEFAULT_PORT, 1);
  if (port > 65535) warnings.push(`PORT 超出范围，已回退到 ${DEFAULT_PORT}。`);

  return {
    apiKey,
    apiKeyConfigured: apiKey !== null,
    mockEnabled: isMockSwitchOn(),
    model: readString('DEEPSEEK_MODEL') ?? DEFAULT_MODEL,
    endpoint,
    analyzeTemperature: envNumber('DEEPSEEK_TEMPERATURE', DEFAULT_TEMPERATURE, 0),
    analyzeMaxTokens: envInt('DEEPSEEK_MAX_TOKENS', DEFAULT_MAX_TOKENS, 1),
    tryoutTemperature: envNumber('TRYOUT_TEMPERATURE', DEFAULT_TRYOUT_TEMPERATURE, 0),
    tryoutMaxTokens: envInt('TRYOUT_MAX_TOKENS', TRYOUT_MAX_TOKENS, 1),
    host: LOCAL_HOST,
    port: port > 65535 ? DEFAULT_PORT : port,
    // 只有配置了估价才展示定价说明；limits.ts 里 PRICE_NOTE_CONFIGURED=false，所以现在恒为 null。
    priceNote: PRICE_NOTE_CONFIGURED ? (readString('PRICE_NOTE') ?? '按 DeepSeek 官方定价估算') : null,
    warnings,
  };
}

export function apiKeyConfigured(): boolean {
  return readEnv().apiKeyConfigured;
}

export function mockEnabled(): boolean {
  return readEnv().mockEnabled;
}

/** GET /api/status 的 limits 字段：全部来自 shared/limits.ts，不在这里另写数字。 */
export function statusLimits(): StatusResponse['limits'] {
  return {
    maxCharsPerSample: MAX_CHARS_PER_SAMPLE,
    maxSamplesPerBatch: MAX_SAMPLES_PER_BATCH,
    maxTotalCharsPerBatch: MAX_TOTAL_CHARS_PER_BATCH,
    maxExtraRetriesPerBatch: MAX_EXTRA_RETRIES_PER_BATCH,
    targetMinChars: TRYOUT_TARGET_MIN,
    targetMaxChars: TRYOUT_TARGET_MAX,
  };
}

/** 缺 Key 时的说明：只讲怎么配置，不伪造任何分析结果。 */
export function configMissingKeyMessage(): string {
  return (
    '未配置 DeepSeek API Key：分析、归纳、试写都需要真实调用上游。' +
    '请设置环境变量 DEEPSEEK_API_KEY 后重启服务，例如 PowerShell：' +
    '$env:DEEPSEEK_API_KEY="你的key"; npm run dev:api。' +
    '若只想自检接口链路，可用 $env:ALLOW_MOCK_ANALYSIS=1 启动并在请求体里带 "mock": true（Mock 结果不能作为正式文风结论）。'
  );
}

export interface LogMeta {
  /** 固定文案，例如 'POST /api/analyze-sample'。 */
  route: string;
  status: number;
  model?: string;
  mock?: boolean;
  elapsedMs?: number;
  usage?: Usage;
  errorCode?: ErrorCode | null;
  /** 上游调用尝试次数（含重试）。 */
  attempts?: number;
  /** 本批次的额外重试计数（按 runId）。 */
  extraRetries?: number;
  /** 去重键或批次 id（客户端生成的标识，不是敏感信息）。 */
  taskKey?: string;
  /** 固定短语，例如 'deepseek.retry:rate_limited'。绝不填写正文。 */
  note?: string;
}

/** 唯一日志出口：一行 JSON 元信息，不含任何正文或密钥。 */
export function logMeta(meta: LogMeta): void {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), kind: 'wsl.meta', ...meta };
  console.log(JSON.stringify(line));
}

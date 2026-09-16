/**
 * 全局常量与调用控制默认值。
 * 数值口径与《文风采样器开发提示词》第七节保持一致；前后端同时引用这里，避免两边写死不同数字。
 */

/** 备份 JSON 结构版本（第四节要求备份包含 schemaVersion）。 */
export const SCHEMA_VERSION = 1;

/** 提示词版本：提示词一改就要变，缓存与规则失效判定都依赖它。 */
export const PROMPT_VERSION = 'wsl-p1';

/** 单篇样本参与分析的最大非空白字符数（码点口径）。 */
export const MAX_CHARS_PER_SAMPLE = 6000;

/** 单批最多样本数。 */
export const MAX_SAMPLES_PER_BATCH = 10;

/** 单批样本非空白字符总量上限。 */
export const MAX_TOTAL_CHARS_PER_BATCH = 30000;

/** 分析请求默认生成参数（非思考模式）。 */
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.2;

/** 一个批次允许的额外重试总量（不含首次请求）。 */
export const MAX_EXTRA_RETRIES_PER_BATCH = 2;

/** 对照试写目标字数区间。 */
export const TRYOUT_TARGET_MIN = 300;
export const TRYOUT_TARGET_MAX = 500;

/** 单次上游请求超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** 归纳候选规则条数上限。 */
export const MAX_CANDIDATE_RULES = 12;

/** 通用规则需要的最少非重复样本数（工程门槛，不是统计保证）。 */
export const MIN_GENERAL_SUPPORT = 2;

/** 本地服务监听地址：只绑定回环。 */
export const LOCAL_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

/** 允许的同源来源（严格校验，拒绝任意目标地址的通用转发）。 */
export const ALLOWED_ORIGIN_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** 定价说明仅在配置了估价时展示；未配置时界面必须显示“未知”。 */
export const PRICE_NOTE_CONFIGURED = false;

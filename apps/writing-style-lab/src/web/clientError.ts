/**
 * 客户端错误类型。单独成文件是为了避免 api.ts ↔ directClient.ts 循环依赖。
 * api.ts 会重新导出它，界面代码仍然可以从 '../api' 引入。
 */
import type { ErrorCode } from '../shared/schema';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'CLIENT_SCHEMA_MISMATCH' | 'STATIC_DEMO' | 'NO_CREDENTIALS';

export class ApiClientError extends Error {
  readonly errorCode: ClientErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly path: string;

  constructor(
    errorCode: ClientErrorCode,
    message: string,
    options: { path: string; retryable?: boolean; httpStatus?: number | null },
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.errorCode = errorCode;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
    this.path = options.path;
  }
}

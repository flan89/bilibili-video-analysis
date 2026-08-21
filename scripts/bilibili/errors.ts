/** B站数据访问层的基础错误。 */
export class BilibiliError extends Error {
  /** 便于 Tool/Agent 程序化判断的稳定错误码。 */
  readonly code: string;
  /** 是否值得在相同参数下稍后重试。 */
  readonly retryable: boolean;
  /** HTTP 状态码；只有网络请求已经返回响应时才有。 */
  readonly httpStatus?: number;
  /** B站 JSON envelope 中的业务 code；HTTP 200 也可能返回非 0 code。 */
  readonly apiCode?: number;

  constructor(options: {
    code: string;
    message: string;
    retryable?: boolean;
    httpStatus?: number;
    apiCode?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "BilibiliError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.apiCode = options.apiCode;
  }
}

/** 将未知异常统一转换为 Tool 可以稳定返回的 BilibiliError。 */
export function toBilibiliError(error: unknown): BilibiliError {
  if (error instanceof BilibiliError) {
    return error;
  }

  if (error instanceof Error) {
    return new BilibiliError({
      code: "unexpected_error",
      message: error.message,
      cause: error,
    });
  }

  return new BilibiliError({
    code: "unexpected_error",
    message: String(error),
    cause: error,
  });
}

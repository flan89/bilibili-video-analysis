import { z } from "zod";
import { AcquisitionRecordSchema } from "../models/acquisition.js";
import {
  VideoMetadataSchema,
  VideoRefSchema,
} from "./model.js";
import { BilibiliClient, type BilibiliApiClient } from "../bilibili/client.js";
import { toBilibiliError } from "../bilibili/errors.js";
import { fetchVideoMetadata } from "./bilibili-adapter.js";
import { resolveBilibiliVideoInput } from "../bilibili/url.js";

/** Tool 输入：支持普通 B站 URL、BV号、av号；短链会在 Client 中展开。 */
export const GetMetadataInputSchema = z.object({
  /** B站视频 URL、BV号或 av号。 */
  video: z.string().min(1),
  /** 是否额外获取视频标签；默认 true。标签失败只会导致 partial，不会让核心 metadata 失败。 */
  includeTags: z.boolean().default(true),
});
export type GetMetadataInput = z.input<typeof GetMetadataInputSchema>;

/** Tool 失败时返回的稳定错误结构。 */
export const MetadataToolErrorSchema = z.object({
  /** 稳定程序错误码。 */
  code: z.string().min(1),
  /** 给人和 Agent 阅读的错误说明。 */
  message: z.string().min(1),
  /** 是否建议稍后重试。 */
  retryable: z.boolean(),
  /** 可选 HTTP 状态。 */
  httpStatus: z.number().int().optional(),
  /** 可选 B站业务 code。 */
  apiCode: z.number().int().optional(),
});
export type MetadataToolError = z.infer<typeof MetadataToolErrorSchema>;

/** Metadata Tool 的无状态独立结果。 */
export const GetMetadataOutputSchema = z.object({
  /** Tool 是否得到可用的核心 metadata。 */
  success: z.boolean(),
  /** 成功时返回规范化视频身份；视频级结果不携带 cid。 */
  video: VideoRefSchema.optional(),
  /** 成功/部分成功时返回标准化元信息。 */
  metadata: VideoMetadataSchema.optional(),
  /** 无论成功失败都必须返回本次 metadata 采集记录。 */
  acquisition: AcquisitionRecordSchema,
  /** 失败时的结构化错误；成功时为空。 */
  error: MetadataToolErrorSchema.optional(),
}).superRefine((output, context) => {
  if (output.success && (!output.video || !output.metadata)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata"],
      message: "元信息成功结果必须包含 video 和 metadata",
    });
  }
  if (output.video && output.metadata && output.video.bvid !== output.metadata.bvid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["video", "bvid"],
      message: "video.bvid 必须与 metadata.bvid 一致",
    });
  }
  if (!output.success && !output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "元信息失败结果必须包含 error",
    });
  }
});
export type GetMetadataOutput = z.infer<typeof GetMetadataOutputSchema>;

/** 依赖注入主要用于单元测试，未来也方便替换代理 Client。 */
export interface GetMetadataDependencies {
  client?: BilibiliApiClient;
}

/**
 * `bilibili.get_metadata` 的框架无关实现。
 *
 * Agent 框架只需要把输入映射到本函数，再把返回 JSON 交给模型即可。
 * 这里刻意不绑定 OpenAI SDK、Pi、MCP 等具体协议。
 */
export async function getBilibiliMetadata(
  rawInput: GetMetadataInput,
  dependencies: GetMetadataDependencies = {},
): Promise<GetMetadataOutput> {
  const input = GetMetadataInputSchema.parse(rawInput);
  const client = dependencies.client ?? new BilibiliClient();
  const requestedAt = new Date().toISOString();

  try {
    const videoInput = await resolveBilibiliVideoInput(input.video, client);
    const { metadata, warnings } = await fetchVideoMetadata(client, videoInput, {
      includeTags: input.includeTags,
    });
    const completedAt = new Date().toISOString();

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "metadata",
      status: warnings.length > 0 ? "partial" : "success",
      source: "bilibili_web_api",
      requestedAt,
      completedAt,
      itemCount: 1,
      message: warnings.length > 0
        ? "视频核心元信息获取成功，但存在非核心字段缺口"
        : "视频元信息获取成功",
      warnings,
    });

    return GetMetadataOutputSchema.parse({
      success: true,
      video: { bvid: metadata.bvid },
      metadata,
      acquisition,
    });
  } catch (error) {
    const normalized = toBilibiliError(error);
    const completedAt = new Date().toISOString();

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "metadata",
      status: "failed",
      source: "bilibili_web_api",
      requestedAt,
      completedAt,
      reasonCode: normalized.code,
      message: normalized.message,
      warnings: [],
      metadata: {
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
        retryable: normalized.retryable,
      },
    });

    return GetMetadataOutputSchema.parse({
      success: false,
      acquisition,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
      },
    });
  }
}

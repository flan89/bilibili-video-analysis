/**
 * scripts/comments/bilibili-raw-schema.ts: B 站评论 JSON 原始 schema.
 *
 * 协议:
 * - x/v2/reply/wbi/main: 一级评论列表 (需要 WBI 签名)
 * - x/v2/reply/reply: 某条根评论的完整回复树 (需要 WBI 签名)
 *
 * 重要: B 站协议在响应里同时包含 "replies" 数组, 但含义不同:
 * - main 响应的 replies 是**根评论列表**
 * - reply 响应的 replies 是**某条根评论下的所有回复**
 * - 根评论对象的 replies 字段是**热门回复预览** (0-3 条, 不完整)
 *
 * D12 边界: 本文件只描述 B 站原始字段, 业务标准化 (成员摘要 / 时间戳 / 表情过滤
 * / 树结构) 在 comments-adapter.ts 完成, 不在这里混入业务逻辑.
 */
import { z } from "zod";

/* -------- 公共子结构 -------- */

/**
 * 用户公开信息 (B 站 member 字段).
 * 字段全可选, 因为部分 API (老接口) 可能 null.
 */
export const RawMemberSchema = z.object({
  mid: z.string().optional(),
  mid_str: z.string().optional(),
  uname: z.string().optional(),
  avatar: z.string().optional(),
  level_info: z
    .object({
      current_level: z.number().int().optional(),
    })
    .optional(),
  vip: z
    .object({
      vipType: z.number().int().optional(),
      vipStatus: z.number().int().optional(),
    })
    .optional(),
  following: z.boolean().optional(),
});
export type RawMember = z.infer<typeof RawMemberSchema>;

/**
 * 评论正文 (B 站 content 字段).
 *
 * `message` 是纯文本, 表情 (emote) 是另一对象结构, 留 metadata 给 adapter.
 */
export const RawContentSchema = z.object({
  message: z.string().default(""),
  emote: z.record(z.string(), z.unknown()).optional(),
  members: z.array(z.unknown()).optional(),
  jump_url: z.record(z.string(), z.unknown()).optional(),
  max_line: z.number().int().optional(),
});
export type RawContent = z.infer<typeof RawContentSchema>;

/**
 * 单条评论/回复 (B 站 reply 字段).
 *
 * 关键字段 (按用途):
 * - 标识: rpid / rpid_str
 * - 父子: root / parent / dialog (都可能是 0 = 根评论)
 * - 数量: count / rcount (B 站报告 vs 实际), like (点赞)
 * - 时间: ctime (Unix 秒)
 * - 状态: state (0=正常, 2=UP主置顶, ...)
 * - 内嵌: member / content / replies (热门回复预览)
 */
export interface RawComment {
  rpid?: number | string;
  rpid_str?: string;
  oid?: number | string;
  type?: number;
  mid?: number | string;
  mid_str?: string;
  root?: number | string;
  parent?: number | string;
  dialog?: number | string;
  root_str?: string;
  parent_str?: string;
  dialog_str?: string;
  count?: number;
  rcount?: number;
  like?: number;
  floor?: number;
  state?: number;
  fansgrade?: number;
  attr?: number;
  ctime?: number;
  member?: z.infer<typeof RawMemberSchema>;
  content?: z.infer<typeof RawContentSchema>;
  replies?: (RawComment | null | undefined)[] | null | undefined;
  reply_control?: Record<string, unknown>;
  up_action?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  show_follow?: boolean;
  invisible?: boolean;
  assist?: number;
  card_label?: unknown[];
}

export const RawCommentSchema: z.ZodType<RawComment, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    rpid: z.union([z.number(), z.string()]).optional(),
    rpid_str: z.string().optional(),
    oid: z.union([z.number(), z.string()]).optional(),
    type: z.number().int().optional(),
    mid: z.union([z.number(), z.string()]).optional(),
    mid_str: z.string().optional(),

    root: z.union([z.number(), z.string()]).optional(),
    parent: z.union([z.number(), z.string()]).optional(),
    dialog: z.union([z.number(), z.string()]).optional(),
    root_str: z.string().optional(),
    parent_str: z.string().optional(),
    dialog_str: z.string().optional(),

    count: z.number().int().optional(),
    rcount: z.number().int().optional(),
    like: z.number().int().optional(),
    floor: z.number().int().optional(),

    state: z.number().int().optional(),
    fansgrade: z.number().int().optional(),
    attr: z.number().int().optional(),
    ctime: z.number().int().optional(),

    member: RawMemberSchema.optional(),
    content: RawContentSchema.optional(),
    replies: z.array(RawCommentSchema.nullish()).nullish(),

    reply_control: z.record(z.string(), z.unknown()).optional(),
    up_action: z.record(z.string(), z.unknown()).optional(),
    folder: z.record(z.string(), z.unknown()).optional(),
    show_follow: z.boolean().optional(),
    invisible: z.boolean().optional(),
    assist: z.number().int().optional(),
    card_label: z.array(z.unknown()).optional(),
  }),
);

/* -------- x/v2/reply/wbi/main 响应 -------- */

/**
 * 游标分页信息.
 *
 * B 站实际使用 `pagination_reply.next_offset` 作为下一页游标 (字符串),
 * 其它字段 (prev / next / is_end) 是兼容字段.
 */
export const CursorSchema = z.object({
  is_begin: z.boolean().optional(),
  prev: z.number().int().optional(),
  next: z.number().int().optional(),
  is_end: z.boolean().optional(),
  pagination_reply: z
    .object({
      next_offset: z.string().optional(),
    })
    .optional(),
  session_id: z.string().optional(),
  mode: z.number().int().optional(),
  mode_text: z.string().optional(),
  all_count: z.number().int().optional(),
  support_mode: z.array(z.number().int()).optional(),
  name: z.string().optional(),
});
export type Cursor = z.infer<typeof CursorSchema>;

export const RawMainRepliesResponseSchema = z.object({
  code: z.number().int(),
  message: z.string().optional(),
  ttl: z.number().int().optional(),
  data: z
    .object({
      cursor: CursorSchema.optional(),
      replies: z.array(RawCommentSchema.nullish()).nullish().default([]),
      // hots 顶级热评列表 (跟 replies 类似结构, 但排序不同)
      hots: z.array(RawCommentSchema.nullish()).optional(),
      // upper 置顶 + notice 公告 + top 置顶信息, 业务层按需用
      upper: z.object({ mid: z.union([z.number(), z.string()]).optional() }).optional(),
      top: z.record(z.string(), z.unknown()).optional(),
      notice: z.record(z.string(), z.unknown()).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      control: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type RawMainRepliesResponse = z.infer<typeof RawMainRepliesResponseSchema>;

/* -------- x/v2/reply/reply 响应 (单条根评论的完整回复树) -------- */

export const RawReplyThreadResponseSchema = z.object({
  code: z.number().int(),
  message: z.string().optional(),
  ttl: z.number().int().optional(),
  data: z
    .object({
      page: z
        .object({
          num: z.number().int().optional(),
          size: z.number().int().optional(),
          count: z.number().int().optional(),
        })
        .optional(),
      // reply 接口有时也会返 cursor.is_end 标记最后一页, 优先用它.
      // 大多数 B 站 reply 接口实际不返 cursor, 这种情况下 lastPageReached 严格保守 (false).
      cursor: z
        .object({
          is_end: z.boolean().optional(),
          pagination_str: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
      upper: z.object({ mid: z.union([z.number(), z.string()]).optional() }).optional(),
      replies: z.array(RawCommentSchema.nullish()).nullish().default([]),
      // 根评论对象 (API 顺手返的, 业务层可参考)
      root: RawCommentSchema.optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      control: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type RawReplyThreadResponse = z.infer<typeof RawReplyThreadResponseSchema>;

/* -------- 解析函数: 验 JSON 字符串 → typed raw -------- */

/** 解析 x/v2/reply/wbi/main 响应. */
export function decodeMainReplies(rawJson: unknown): RawMainRepliesResponse {
  return RawMainRepliesResponseSchema.parse(rawJson);
}

/** 解析 x/v2/reply/reply 响应. */
export function decodeReplyThread(rawJson: unknown): RawReplyThreadResponse {
  return RawReplyThreadResponseSchema.parse(rawJson);
}

/* -------- 评论状态枚举 (B 站 state 字段) -------- */

/**
 * 评论 state 字段常见值:
 * - 0: 正常
 * - 1: 折叠
 * - 2: UP 主置顶
 * - 4: 折叠 (跟 1 区分场景, 文档不全)
 * - 6: 热评推荐
 * - 7: 热评推荐 + 折叠 ?
 * - 8: 已删除 (但仍在树里, 文本空)
 */
export const CommentState = {
  Normal: 0,
  Folded: 1,
  UpPinned: 2,
  Hot: 6,
  Deleted: 8,
} as const;
export type CommentStateValue = (typeof CommentState)[keyof typeof CommentState];

/** 是否置顶 (UP 主置顶). */
export function isUpPinned(state: number | undefined): boolean | undefined {
  if (state === undefined) return undefined;
  return state === CommentState.UpPinned;
}

/** 是否已删除 (state=8 但 content.message 为空). */
export function isDeleted(state: number | undefined, contentMessage: string): boolean {
  if (state === CommentState.Deleted) return true;
  return contentMessage === "" && state === 0;
}

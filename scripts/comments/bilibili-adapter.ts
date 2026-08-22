/**
 * scripts/comments/bilibili-adapter.ts: B 站评论 raw → 标准化 Comment 转换.
 *
 * 职责:
 * 1. x/v2/reply/wbi/main 响应 → 一级评论列表 (含 0-3 条热门回复预览, repliesComplete=false)
 * 2. x/v2/reply/reply 响应 → 某条根评论的完整回复树 (repliesComplete=true)
 * 3. WBI 签名 + fetch 拉取原始 JSON
 *
 * D12 边界: B 站字段 (rpid/rcount/state/...) 不暴露到 Tool 层.
 * 标准化后只剩 Comment (M1 D08) + cursor/page 等内部概念.
 *
 * 抽样 (D16 三维: 热度+时间+长度) 不在 Adapter, 留给 Tool / Agent 层.
 * Adapter 只负责"把数据可靠地拿到" (跟 §8 temp_doc.md 一致).
 */
import { z } from "zod";

import { BilibiliError } from "../bilibili/errors.js";
import {
  type RawComment,
  type RawMainRepliesResponse,
  type RawReplyThreadResponse,
  decodeMainReplies,
  decodeReplyThread,
  isUpPinned,
} from "./bilibili-raw-schema.js";
import {
  type Comment,
  type CommentCollection,
  CommentCollectionSchema,
  CommentSchema,
} from "../models/comment.js";
import { PublicUserRefSchema } from "../models/common.js";
import type { WbiSigner } from "../bilibili/wbi.js";

/* -------- 字段映射工具 -------- */

/** 把 B 站 rpid (number|string) 转成统一字符串 id. */
function rpidToId(rpid: number | string | undefined): string | undefined {
  if (rpid === undefined) return undefined;
  if (typeof rpid === "string") return rpid;
  return String(rpid);
}

/** root/parent 0 = 根评论自身 (无父), 转 undefined. */
function parentIdFromRaw(value: number | string | undefined): string | undefined {
  const id = rpidToId(value);
  if (id === undefined || id === "0") return undefined;
  return id;
}

/** 把 B 站 RawMember 映射到标准化 PublicUserRef.
 *
 * 之前传 {mid, name, avatar, level}, 但 PublicUserRefSchema 是
 * {userId, name, avatarUrl, badge}, 字段名不匹配导致 Zod strip 静默丢失.
 * Agent 读 c.user.userId 一直是 undefined.
 */
function userFromRaw(raw: RawComment["member"]): z.infer<typeof PublicUserRefSchema> | undefined {
  if (!raw) return undefined;
  const mid = rpidToId(raw.mid) ?? raw.mid_str;
  if (!mid) return undefined;
  return PublicUserRefSchema.parse({
    userId: mid,
    name: raw.uname,
    avatarUrl: raw.avatar,
    // B 站 level_info 数字 (0-6) 当作公开徽章 (压缩成字符串)
    badge: raw.level_info?.current_level !== undefined
      ? `level_${raw.level_info.current_level}`
      : undefined,
  });
}

/* -------- 单条 raw → 标准 Comment -------- */

/**
 * 把 B 站 RawComment 递归转成标准 Comment.
 *
 * 关键映射:
 * - rpid → id (字符串保留大数)
 * - rcount → replyCount
 * - like → likeCount
 * - ctime → publishedAt
 * - state === 2 → isPinned
 * - floor → floor
 * - member → user (PublicUserRef)
 * - content.message → content (空字符串视为已删除)
 * - replies (preview) → 递归, 但 repliesComplete 强制 false
 *
 * 不会失败的解析: B 站字段全 optional, 缺失当无.
 *
 * 顶层 commentFromRaw 调用方传的 repliesComplete 永远应该是 false,
 * 因为 B 站 reply 接口里嵌套的 `replies` 字段是 0-3 热门预览, 不是完整子树.
 * 完整子树需要再调 get_comment_replies(root=reply_rpid).
 * 顶层 reply 列表是否完整由 NormalizedReplyThread.complete 表达, 跟 replies[].repliesComplete 不同.
 */
function commentFromRaw(
  raw: RawComment,
  oid: string,
  repliesComplete: boolean,
): Comment {
  const message = raw.content?.message ?? "";
  // B 站对已删除评论 message 返 "" 但 state 仍是 0, 这两种情况都当 deleted.
  const isDeleted = message === "";
  const text = isDeleted ? "[已删除]" : message;

  const input: z.input<typeof CommentSchema> = {
    id: rpidToId(raw.rpid) ?? raw.rpid_str ?? "0",
    rootId: parentIdFromRaw(raw.root),
    parentId: parentIdFromRaw(raw.parent),
    oid,
    user: userFromRaw(raw.member),
    content: text,
    likeCount: raw.like,
    replyCount: raw.rcount,
    publishedAt: raw.ctime,
    floor: raw.floor,
    isPinned: isUpPinned(raw.state),
    repliesComplete: repliesComplete && !isDeleted,
    replies: (raw.replies ?? [])
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => commentFromRaw(r, oid, /*repliesComplete*/ false)),
    metadata: {
      state: raw.state,
      attr: raw.attr,
      mid: raw.mid ?? raw.mid_str,
      dialog: raw.dialog,
      ...(isDeleted ? { deleted: true } : {}),
    },
  };
  return CommentSchema.parse(input);
}

/* -------- x/v2/reply/wbi/main 响应 → CommentCollection -------- */

export interface NormalizedMainReplies {
  comments: Comment[];
  /** 下一页游标 (字符串, B 站 pagination_reply.next_offset). undefined = 没更多. */
  nextCursor: string | undefined;
  /** 是否已加载全部根评论. */
  complete: boolean;
  /** B 站报告的总评论数 (含已删); 不等于 comments.length. */
  allCount: number | undefined;
  /** 排序方式 (3 = 热度, 2 = 时间). */
  mode: number;
}

/**
 * 把 x/v2/reply/wbi/main 响应 → 标准 CommentCollection 的根评论列表.
 *
 * 不抽样, 不分页, 一次响应就这一页. 多页由 Tool / Agent 层用 nextCursor 翻.
 */
export function normalizeMainReplies(
  raw: RawMainRepliesResponse,
  oid: string,
): NormalizedMainReplies {
  const replies = (raw.data?.replies ?? []).filter(
    (r): r is NonNullable<typeof r> => r != null,
  );
  const comments: Comment[] = replies.map((r) =>
    commentFromRaw(r, oid, /*repliesComplete*/ false),
  );
  const cursor = raw.data?.cursor;
  return {
    comments,
    nextCursor: cursor?.pagination_reply?.next_offset,
    // 严格 === true 才认为 complete. cursor 缺失 / API 字段变化 / 风控触发
    // 等情况不再错误地默认 complete=true, 避免 Agent 误判 Coverage 后写错总体结论.
    complete: cursor?.is_end === true,
    allCount: cursor?.all_count,
    mode: cursor?.mode ?? 3,
  };
}

/* -------- x/v2/reply/reply 响应 → 完整回复树 -------- */

export interface NormalizedReplyThread {
  replies: Comment[];
  /** 当前 page 翻页信息. */
  page: { num: number; size: number; count: number };
  /** 根评论 ID (从 root 字段拿, 也可从入参传). */
  rootId: string;
  /** B 站 page.count 是整条根评论的回复总数; 用作 "totalReported". */
  totalReported: number;
  /**
   * 改名为 lastPageReached, 语义更准确.
   * 旧 complete 公式 (pageNum-1)*pageSize+len >= pageCount 把"最后一页"误当"线程完整",
   * 实际无状态 Tool 直接 page=2 拿后 10 条, 旧公式会算成 complete=true, Agent 误以为读完.
   *
   * 严格语义: B 站 page.count 是"应得总数", 当前 page 是否最后一页
   * (即 pageNum 之后的页已经没有 reply) 应该用 B 站 cursor.is_end 字段判断
   * (跟 改 Comments Tool cursor 同款严格逻辑), 不要用 (pageNum-1)*size+len 推.
   */
  lastPageReached: boolean;
  /** 下一页号; lastPageReached=true 时 undefined. */
  nextPage?: number;
  /**
   * 新增 hasMore, 跟 lastPageReached 互补.
   * lastPageReached 严格基于 B 站 cursor.is_end, hasMore 是 lastPageReached 的反义,
   * 让 Agent 看代码时更直观.
   */
  hasMore: boolean;
}

/**
 * 把 x/v2/reply/reply 响应 → 标准 Comment 列表.
 *
 * 返回的 Comment.repliesComplete 反映"当前 page 的顶层 reply 是否完整",
 * 由调用方传 (默认 false, 单页响应内 reply 嵌套 children 永远 false).
 *
 * lastPageReached 严格基于 B 站 cursor.is_end, 不再用
 * (pageNum-1)*pageSize+len >= pageCount 推 (旧公式把"最后一页"误当"线程完整",
 * 无状态 Tool 直接 page=2 拿后 10 条也会被误判为 complete=true, 误导 Agent).
 */
export function normalizeReplyThread(
  raw: RawReplyThreadResponse,
  rootRpid: string,
  options: { topLevelRepliesLastPageReached?: boolean; aid?: number | string } = {},
): NormalizedReplyThread {
  const replies = (raw.data?.replies ?? []).filter(
    (r): r is NonNullable<typeof r> => r != null,
  );
  const pageNum = raw.data?.page?.num ?? 1;
  const pageSize = raw.data?.page?.size ?? 20;
  const pageCount = raw.data?.page?.count ?? replies.length;
  // 严格基于 B 站 cursor.is_end 字段判断本 Tool 单页是否最后一页
  // (跟 Comments Tool cursor 同款逻辑: 缺失 / 风控 / API 字段变化时
  // 不再默认 true, 避免 Agent 误判 Coverage).
  const lastPageReached = options.topLevelRepliesLastPageReached
    ?? (raw.data?.cursor?.is_end === true);
  return {
    // 顶层 reply 列表完整性由 NormalizedReplyThread 表达,
    // 每条 reply 自己的 repliesComplete 永远为 false (B 站 reply 接口嵌套的 replies
    // 字段是 0-3 热门预览, 不是完整子树).
    replies: replies.map((r) =>
      commentFromRaw(r, options.aid !== undefined ? String(options.aid) : "", /*repliesComplete*/ false),
    ),
    page: {
      num: pageNum,
      size: pageSize,
      count: pageCount,
    },
    rootId: rpidToId(raw.data?.root?.rpid) ?? raw.data?.root?.rpid_str ?? rootRpid,
    totalReported: pageCount,
    lastPageReached,
    hasMore: !lastPageReached,
    ...(lastPageReached ? {} : { nextPage: pageNum + 1 }),
  };
}

/* -------- WBI 签名 + fetch 直接拉取 -------- */

/** x/v2/reply/wbi/main 接口参数. */
export interface GetMainRepliesParams {
  aid: number;
  /** 排序: 3 = 热度 (默认), 2 = 时间. */
  mode?: 2 | 3;
  /** 游标, 首次 undefined, 后续用上一次 nextCursor. */
  next?: string;
  /** 每页项数, 默认 20, 最大 30. */
  ps?: number;
}

/** x/v2/reply/reply 接口参数. */
export interface GetReplyRepliesParams {
  aid: number;
  /** 根评论 rpid (字符串或数字, B 站文档说 int64). */
  root: number | string;
  /** 页码, 1 开始. */
  pn?: number;
  /** 每页项数, 默认 20, 最大 49 (实际 B 站限制 20). */
  ps?: number;
}

export interface FetchContext {
  signer: WbiSigner;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  cookie?: string;
  baseUrl?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const DEFAULT_BASE = "https://api.bilibili.com/";

/**
 * 拉取 x/v2/reply/wbi/main 一页响应, 已 parse + verify.
 */
export async function getMainRepliesPage(
  ctx: FetchContext,
  params: GetMainRepliesParams,
): Promise<RawMainRepliesResponse> {
  const signed = await ctx.signer.signRequest(undefined, {
    type: 1,
    oid: params.aid,
    mode: params.mode ?? 3,
    ...(params.next !== undefined ? { pagination_str: JSON.stringify({ offset: params.next }) } : {}),
    ps: params.ps ?? 20,
  });
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE;
  const url = `${baseUrl}x/v2/reply/wbi/main?${signed}`;
  return await fetchAndParse(ctx, url, decodeMainReplies);
}

/**
 * 拉取 x/v2/reply/reply 一页响应, 已 parse + verify.
 */
export async function getReplyRepliesPage(
  ctx: FetchContext,
  params: GetReplyRepliesParams,
): Promise<RawReplyThreadResponse> {
  const signed = await ctx.signer.signRequest(undefined, {
    type: 1,
    oid: params.aid,
    root: params.root,
    pn: params.pn ?? 1,
    ps: params.ps ?? 20,
  });
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE;
  const url = `${baseUrl}x/v2/reply/reply?${signed}`;
  return await fetchAndParse(ctx, url, decodeReplyThread);
}

async function fetchAndParse<T extends { code: number; message?: string }>(
  ctx: FetchContext,
  url: string,
  decoder: (raw: unknown) => T,
): Promise<T> {
  const r = await (ctx.fetchImpl ?? fetch)(url, {
    headers: {
      "User-Agent": ctx.userAgent ?? DEFAULT_UA,
      ...(ctx.cookie ? { cookie: ctx.cookie } : {}),
      Referer: "https://www.bilibili.com/",
    },
  });
  if (!r.ok) {
    throw new BilibiliError({
      code: "comments_http_error",
      message: `${url} HTTP ${r.status}`,
      httpStatus: r.status,
    });
  }
  const json = await r.json() as unknown;
  const decoded = decoder(json);
  if (decoded.code !== 0) {
    throw new BilibiliError({
      code: "comments_api_error",
      message: `B 站评论接口返 code=${decoded.code}: ${decoded.message ?? "未知错误"}`,
      apiCode: decoded.code,
    });
  }
  return decoded;
}

/* -------- 工具: 把 NormalizedMainReplies 包装成 CommentCollection -------- */

/**
 * 把 normalizeMainReplies 结果套成标准 CommentCollection (M1 schema).
 * 抽样 (samplingStrategy) 留给调用方, 这里默认 "fetched_all_in_page".
 */
export function wrapMainRepliesAsCollection(
  normalized: NormalizedMainReplies,
  sortLabel: string,
): CommentCollection {
  return CommentCollectionSchema.parse({
    comments: normalized.comments,
    complete: normalized.complete,
    samplingStrategy: `wbi_main_${sortLabel}_single_page`,
    totalReported: normalized.allCount,
    metadata: {
      nextCursor: normalized.nextCursor,
      mode: normalized.mode,
    },
  });
}

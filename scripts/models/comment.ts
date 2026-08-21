import { z } from "zod";
import {
  EntityIdSchema,
  ExtraMetadataSchema,
  PublicUserRefSchema,
  UnixTimeSecondsSchema,
} from "./common.js";

/**
 * 评论与回复统一为同一个 Comment 模型。
 *
 * 设计意图：
 * - 顶级评论：parentId/rootId 为空；
 * - 回复：parentId 指向直接父节点，rootId 指向根评论；
 * - 不把 Reply 做成完全不同的类型，避免线程分析写两套逻辑。
 */
export interface Comment {
  /** 评论或回复在来源平台中的唯一 ID。 */
  id: string;
  /** 所属根评论 ID；根评论自身通常留空。 */
  rootId?: string;
  /** 直接父节点 ID，用于恢复真实对话关系。 */
  parentId?: string;
  /** 评论目标对象 ID，例如视频 aid；保留给后续分页/回查使用。 */
  oid?: string;
  /** 发表评论的公开用户最小引用。 */
  user?: z.infer<typeof PublicUserRefSchema>;
  /** 评论或回复原始文本。 */
  content: string;
  /** 点赞数，仅表示平台热度信号，不等同于观点代表性。 */
  likeCount?: number;
  /** 平台报告的直接/总回复数量；具体含义取决于来源接口，必要时在 metadata 说明。 */
  replyCount?: number;
  /** 评论发布时间，Unix 秒。 */
  publishedAt?: number;
  /** 平台楼层号；部分接口可能不再提供，因此允许缺省。 */
  floor?: number;
  /** 是否为置顶评论；未能确认时不要默认 false，可留空。 */
  isPinned?: boolean;
  /** 当前 replies 是否已覆盖本次目标范围内的全部回复。 */
  repliesComplete: boolean;
  /** 子回复集合；即使为空也需要结合 repliesComplete 判断是否真的“无更多回复”。 */
  replies: Comment[];
  /** 暂未稳定建模的来源字段。 */
  metadata?: Record<string, unknown>;
}

/**
 * CommentSchema 接受的输入结构。
 *
 * `repliesComplete` 和 `replies` 在外部输入中允许缺省，由 Schema 补上默认值；
 * 解析完成后的 Comment 仍保证这两个字段始终存在，避免业务层反复判断 undefined。
 */
export interface CommentInput {
  /** 评论或回复在来源平台中的唯一 ID。 */
  id: string;
  /** 所属根评论 ID；根评论自身通常留空。 */
  rootId?: string;
  /** 直接父节点 ID，用于恢复真实对话关系。 */
  parentId?: string;
  /** 评论目标对象 ID，例如视频 aid。 */
  oid?: string;
  /** 发表评论的公开用户最小引用。 */
  user?: z.input<typeof PublicUserRefSchema>;
  /** 评论或回复原始文本。 */
  content: string;
  /** 点赞数。 */
  likeCount?: number;
  /** 来源平台报告的回复数量。 */
  replyCount?: number;
  /** 评论发布时间，Unix 秒。 */
  publishedAt?: number;
  /** 平台楼层号。 */
  floor?: number;
  /** 是否为置顶评论。 */
  isPinned?: boolean;
  /** 输入可缺省；解析后默认 false。 */
  repliesComplete?: boolean;
  /** 输入可缺省；解析后默认空数组。 */
  replies?: CommentInput[];
  /** 暂未稳定建模的来源字段。 */
  metadata?: Record<string, unknown>;
}

export const CommentSchema: z.ZodType<Comment, z.ZodTypeDef, CommentInput> = z.lazy(() => z.object({
  /** 评论/回复唯一 ID。 */
  id: EntityIdSchema,
  /** 根评论 ID；根评论自身可不填。 */
  rootId: EntityIdSchema.optional(),
  /** 直接父评论 ID，用于恢复真实对话关系。 */
  parentId: EntityIdSchema.optional(),
  /** B站评论对象目标 ID，按实际接口能力填。 */
  oid: z.string().optional(),
  /** 评论用户的最小公开引用。 */
  user: PublicUserRefSchema.optional(),
  /** 评论原始文本，不在采集层改写或总结。 */
  content: z.string(),
  /** 点赞数量；只能作为热度特征之一。 */
  likeCount: z.number().int().nonnegative().optional(),
  /** 来源平台报告的回复数量。 */
  replyCount: z.number().int().nonnegative().optional(),
  /** 发布时间，Unix 秒。 */
  publishedAt: UnixTimeSecondsSchema.optional(),
  /** 平台楼层号。 */
  floor: z.number().int().nonnegative().optional(),
  /** 是否置顶。 */
  isPinned: z.boolean().optional(),

  /**
   * 非常重要：replies 为空并不代表“没有更多回复”。
   * 当公开接口只返回部分回复、分页没走完、浏览器 fallback 失败时应为 false。
   * 分析层做“共识/频率”判断时必须知道这个证据缺口。
   */
  repliesComplete: z.boolean().default(false),
  /** 已获取的子回复；递归使用同一个 Comment 模型。 */
  replies: z.array(CommentSchema).default([]),
  /** 暂未稳定建模的来源字段。 */
  metadata: ExtraMetadataSchema.optional(),
}));

/**
 * 根评论集合。
 * complete 表示“本次目标范围内是否抓全”，而不是宣称平台永久没有更多评论。
 */
export const CommentCollectionSchema = z.object({
  /** 当前已经获取到的根评论集合。 */
  comments: z.array(CommentSchema),
  /** 当前目标范围内是否已完整获取。 */
  complete: z.boolean().default(false),

  /**
   * 保存本次排序/抽样策略，避免后续把“热评样本”误认为全体评论。
   * 例如：stratified_time_popularity_random。
   */
  samplingStrategy: z.string().optional(),
  /** 平台报告的评论总量；不等于 comments.length，尤其在采样场景下。 */
  totalReported: z.number().int().nonnegative().optional(),
  /** 集合级的来源、分页、抽样等补充信息。 */
  metadata: ExtraMetadataSchema.optional(),
});
export type CommentCollection = z.infer<typeof CommentCollectionSchema>;

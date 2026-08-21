import type { VideoMetadata } from "./model.js";
import { VideoMetadataSchema } from "./model.js";
import type { BilibiliApiClient } from "../bilibili/client.js";
import {
  RawTagListSchema,
  RawVideoViewDataSchema,
  type RawTagList,
  type RawVideoViewData,
} from "./bilibili-raw-schema.js";
import type { ParsedBilibiliVideoInput } from "../bilibili/url.js";

/** Metadata 获取结果；tags 失败不会让核心 metadata 整体失败。 */
export interface FetchMetadataResult {
  /** 已标准化并通过 VideoMetadataSchema 校验的视频元信息。 */
  metadata: VideoMetadata;
  /** 非致命缺口，例如标签接口失败。 */
  warnings: string[];
}

/**
 * 调用 B站视频详情与标签接口，并转换成 Skill 自己的 VideoMetadata。
 *
 * 注意：这里是 Adapter 边界。后面的 Tool 和确定性处理模块不应该再依赖 `stat.view`、
 * `owner.mid`、`pages[].part` 这类 B站原始字段。
 */
export async function fetchVideoMetadata(
  client: BilibiliApiClient,
  input: Exclude<ParsedBilibiliVideoInput, { kind: "short_url" }>,
  options: { includeTags?: boolean } = {},
): Promise<FetchMetadataResult> {
  const query = input.kind === "bvid"
    ? { bvid: input.bvid }
    : { aid: input.aid };

  const view = await client.getApiData(
    "/x/web-interface/view",
    query,
    RawVideoViewDataSchema,
  );

  const warnings: string[] = [];
  let tags: RawTagList = [];

  if (options.includeTags ?? true) {
    try {
      tags = await client.getApiData(
        "/x/tag/archive/tags",
        query,
        RawTagListSchema,
      );
    } catch (error) {
      // 标签不是 metadata 任务成立的核心字段，因此采用“部分成功”而不是让整次 Tool 失败。
      warnings.push(`标签获取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const metadata = normalizeVideoMetadata(view, input.canonicalUrl, tags);
  return { metadata, warnings };
}

/**
 * 将 B站原始详情转换为内部模型。
 * 该函数纯计算、无网络，非常适合使用 fixture 做稳定单元测试。
 */
export function normalizeVideoMetadata(
  view: RawVideoViewData,
  sourceUrl: string,
  tags: RawTagList = [],
): VideoMetadata {
  const rawPages = view.pages ?? [];
  const pages = rawPages.length > 0
    ? rawPages.map((page) => ({
        page: page.page,
        cid: String(page.cid),
        // B站 part 是最接近“分P显示标题”的字段；若缺失则生成一个稳定兜底标题。
        title: page.part?.trim() || `${view.title} P${page.page}`,
        durationSeconds: page.duration,
        part: page.part,
        metadata: {
          from: page.from,
          vid: page.vid,
          weblink: page.weblink,
          dimension: page.dimension,
        },
      }))
    : view.cid !== undefined
      ? [{
          page: 1,
          cid: String(view.cid),
          title: view.title,
          durationSeconds: view.duration ?? 0,
          part: view.title,
          metadata: {},
        }]
      : [];

  return VideoMetadataSchema.parse({
    bvid: view.bvid,
    aid: String(view.aid),
    sourceUrl,
    title: view.title,
    description: view.desc,
    author: view.owner
      ? {
          userId: String(view.owner.mid),
          name: view.owner.name,
          avatarUrl: view.owner.face,
        }
      : undefined,
    publishedAt: view.pubdate,
    durationSeconds: view.duration,
    coverUrl: view.pic,
    tags: tags.map((tag) => tag.tag_name),
    stats: view.stat
      ? {
          viewCount: view.stat.view,
          likeCount: view.stat.like,
          coinCount: view.stat.coin,
          favoriteCount: view.stat.favorite,
          shareCount: view.stat.share,
          commentCount: view.stat.reply,
          danmakuCount: view.stat.danmaku,
        }
      : undefined,
    pages,
    metadata: {
      categoryId: view.tid,
      categoryName: view.tname,
      copyright: view.copyright,
      createdAt: view.ctime,
      videosReported: view.videos,
    },
  });
}

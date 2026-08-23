import type { AcquisitionRecord } from "../../models/acquisition.js";
import type { VideoCandidate } from "../../models/discovery.js";
import type { SearchVideosOutput } from "../../discovery/search-videos.js";
import type { PopularVideosOutput } from "../../discovery/popular-videos.js";
import type { HotSearchesOutput } from "../../discovery/hot-searches.js";
import type { RelatedVideosOutput } from "../../discovery/related-videos.js";

/** Agent 初筛候选所需的最小结构；省略长简介、封面和头像，避免输出被截断。 */
function compactCandidate(candidate: VideoCandidate): unknown {
  return {
    video: candidate.video,
    title: candidate.title,
    author: candidate.author
      ? { userId: candidate.author.userId, name: candidate.author.name }
      : undefined,
    publishedAt: candidate.publishedAt,
    durationSeconds: candidate.durationSeconds,
    tags: candidate.tags,
    stats: candidate.stats,
    position: candidate.position,
    sourceUrl: candidate.sourceUrl,
    category: candidate.category,
    discoveryReason: candidate.discoveryReason,
  };
}

/** 必须保留 partial / missing / failed 及 warnings，精简输出不能削弱 Coverage。 */
function compactAcquisition(acquisition: AcquisitionRecord): unknown {
  return {
    status: acquisition.status,
    reasonCode: acquisition.reasonCode,
    message: acquisition.message,
    itemCount: acquisition.itemCount,
    warnings: acquisition.warnings,
  };
}

export function toAgentSearchVideosOutput(result: SearchVideosOutput): unknown {
  return {
    success: result.success,
    query: result.query,
    candidates: result.candidates.map(compactCandidate),
    pageInfo: result.pageInfo,
    reportedTotal: result.reportedTotal,
    observedAt: result.observedAt,
    acquisition: compactAcquisition(result.acquisition),
    error: result.error,
  };
}

export function toAgentPopularVideosOutput(result: PopularVideosOutput): unknown {
  return {
    success: result.success,
    candidates: result.candidates.map(compactCandidate),
    pageInfo: result.pageInfo,
    observedAt: result.observedAt,
    acquisition: compactAcquisition(result.acquisition),
    error: result.error,
  };
}

export function toAgentHotSearchesOutput(result: HotSearchesOutput): unknown {
  return {
    success: result.success,
    topics: result.topics,
    observedAt: result.observedAt,
    platformObservedAt: result.platformObservedAt,
    reportedTotal: result.reportedTotal,
    acquisition: compactAcquisition(result.acquisition),
    error: result.error,
  };
}

export function toAgentRelatedVideosOutput(result: RelatedVideosOutput): unknown {
  return {
    success: result.success,
    seedVideo: result.seedVideo,
    candidates: result.candidates.map(compactCandidate),
    returnedCount: result.returnedCount,
    observedAt: result.observedAt,
    acquisition: compactAcquisition(result.acquisition),
    error: result.error,
  };
}

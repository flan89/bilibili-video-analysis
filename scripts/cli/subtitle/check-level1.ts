/**
 * 临时脚本: 只查 Level 1 字幕轨, 不触发 ASR fallback.
 * 用途: 在一批 B 站视频里筛出"真 missing" 走 ASR 路径的候选.
 *
 * 跑法: npx tsx scripts/cli/subtitle/check-level1.ts BV1xxx BV1yyy ...
 */
import { BilibiliClient } from "../../bilibili/client.js";
import { discoverOfficialSubtitleTracks } from "../../subtitle/bilibili-adapter.js";
import { getBilibiliMetadata } from "../../metadata/get.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("用法: tsx scripts/cli/subtitle/check-level1.ts <BV1...> [BV2...]");
  process.exitCode = 2;
} else {
  const client = new BilibiliClient();
  for (const bvid of args) {
    try {
      const meta = await getBilibiliMetadata(
        { video: bvid, includeTags: false },
        { client },
      );
      if (!meta.success || !meta.metadata) {
        console.log(`${bvid} meta 失败: ${meta.error?.message ?? "unknown"}`);
        continue;
      }
      const aid = meta.metadata.aid;
      if (!aid) {
        console.log(`${bvid} 无 aid`);
        continue;
      }
      const p1 = meta.metadata.pages[0];
      if (!p1) {
        console.log(`${bvid} 无分P`);
        continue;
      }
      const discovery = await discoverOfficialSubtitleTracks(client, { aid, cid: p1.cid });
      const tracks = discovery.tracks;
      console.log(
        `${bvid} (${p1.durationSeconds}s) tracks=${tracks.length}` +
        (tracks.length > 0
          ? ` [${tracks.map((t) => `${t.language}/${t.source}`).join(", ")}]`
          : " → missing, 应走 ASR"),
      );
    } catch (e) {
      console.log(`${bvid} 异常: ${(e as Error).message}`);
    }
  }
}

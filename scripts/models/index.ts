/**
 * models 对外统一出口.
 *
 * 只导出跨能力共享的模型:
 *   - common: VideoRef / MediaTime / PublicUserRef 等基础定义
 *   - acquisition: DataKind / AcquisitionState / AcquisitionRecord
 *   - task: DataPlan / Task
 *   - frame / danmaku / comment: 暂留 models/,待对应能力目录落地后内聚
 *
 * 字幕数据模型 (transcript) 已在 subtitle/model.ts 落地,
 * 视频元数据模型 (video) 已在 metadata/model.ts 落地,
 * 不再从 models 顶层 re-export.
 */
export * from "./common.js";
export * from "./acquisition.js";
export * from "./task.js";
export * from "./frame.js";
export * from "./danmaku.js";
export * from "./comment.js";
export * from "./discovery.js";

/**
 * 字幕确定性预处理 (清洗 + 分块).
 *
 * 合并自原 scripts/preprocessing/{transcript-cleaner, transcript-chunker, preprocess-transcript}.ts
 * 三个文件按"内聚到字幕能力"原则合并到字幕能力目录.
 *
 * 职责：
 * 1. 程序规则负责空白清理、保守去重、技术性分页、范围读取、来源覆盖和原文核对
 * 2. 当前 Agent 负责语义章节、内容结论、重要来源选择和最终回答
 *
 * 不做:
 * - 模糊匹配删除相似字幕
 * - 改写词语、数字、术语
 * - 判断哪些内容重要
 * - 把所有文本块转换成统一 Evidence 对象
 */
import { z } from "zod";
import {
  PreparedTranscriptSchema,
  TranscriptSchema,
  TranscriptSegmentSchema,
  TranscriptChunkSchema,
  TranscriptCleaningStatsSchema,
  type PreparedTranscript,
  type Transcript,
  type TranscriptChunk,
  type TranscriptCleaningStats,
  type TranscriptProcessingWarning,
} from "./model.js";

/** 字幕清洗只接受保守、确定性的配置. */
export const TranscriptCleaningOptionsSchema = z.object({
  /**
   * 相邻相同文本允许合并的最大时间间隔,单位:秒.
   * 超过该间隔时保留为两次独立表达,避免误删真正的重复发言.
   */
  duplicateMaxGapSeconds: z.number().nonnegative().default(0.75),
});
export type TranscriptCleaningOptions = z.input<typeof TranscriptCleaningOptionsSchema>;

/** 清洗后参与技术性分段的最小字幕单元. */
export interface CleanedTranscriptUnit {
  /** 清洗后的非空文本. */
  text: string;
  /** 单元覆盖的开始秒数. */
  startSeconds: number;
  /** 单元覆盖的结束秒数. */
  endSeconds: number;
  /** 单元对应的全部原始字幕 ID. */
  segmentIds: string[];
  /** 原字幕存在说话人信息时保留,用于避免跨说话人合并. */
  speaker?: string;
}

/** 清洗阶段的纯计算结果. */
export interface CleanTranscriptSegmentsResult {
  /** 按时间排序、去除空白并保守去重后的字幕单元. */
  units: CleanedTranscriptUnit[];
  /** 清洗过程中发现的结构化问题. */
  warnings: TranscriptProcessingWarning[];
  /** 清洗后为空而丢弃的原始片段数. */
  emptySegmentCount: number;
  /** 被并入相邻相同文本的原始片段数. */
  duplicateSegmentCount: number;
}

/** 返回给 Agent 的干净 Transcript 及可观察处理信息. */
export interface CleanedTranscriptResult {
  /** 保留来源、时间和完整性语义的清理后字幕. */
  transcript: Transcript;
  /** 清理过程中产生的结构化说明. */
  warnings: TranscriptProcessingWarning[];
  /** 清理前后的数量变化. */
  stats: TranscriptCleaningStats;
}

/**
 * 只清理确定性的格式噪声,不修改词语、数字、术语或表达含义.
 */
export function normalizeTranscriptText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n+ */gu, " ")
    .trim();
}

/** 保守清洗字幕,并保留每一个非空来源片段 ID. */
export function cleanTranscriptSegments(
  transcript: Transcript,
  rawOptions: TranscriptCleaningOptions = {},
): CleanTranscriptSegmentsResult {
  const options = TranscriptCleaningOptionsSchema.parse(rawOptions);
  const validatedTranscript = TranscriptSchema.parse(transcript);
  const indexedSegments = validatedTranscript.segments
    .map((segment, index) => ({ segment, index }));
  const sortedSegments = [...indexedSegments].sort((left, right) =>
    left.segment.startSeconds - right.segment.startSeconds
      || left.segment.endSeconds - right.segment.endSeconds
      || left.index - right.index
  );
  const warnings: TranscriptProcessingWarning[] = [];

  if (sortedSegments.some((item, index) => item.index !== index)) {
    warnings.push({
      code: "segments_reordered",
      message: "输入字幕未按时间排序,预处理已在副本中重新排序",
      segmentIds: sortedSegments.map((item) => item.segment.id),
    });
  }

  const emptySegmentIds: string[] = [];
  const duplicateSegmentIds: string[] = [];
  const units: CleanedTranscriptUnit[] = [];

  for (const { segment } of sortedSegments) {
    const text = normalizeTranscriptText(segment.text);
    if (text.length === 0) {
      emptySegmentIds.push(segment.id);
      continue;
    }

    const previous = units.at(-1);
    const gapSeconds = previous
      ? segment.startSeconds - previous.endSeconds
      : Number.POSITIVE_INFINITY;
    const sameSpeaker = previous?.speaker === segment.speaker;
    const canMergeDuplicate = previous !== undefined
      && previous.text === text
      && sameSpeaker
      && gapSeconds <= options.duplicateMaxGapSeconds;

    if (canMergeDuplicate) {
      previous.startSeconds = Math.min(previous.startSeconds, segment.startSeconds);
      previous.endSeconds = Math.max(previous.endSeconds, segment.endSeconds);
      previous.segmentIds.push(segment.id);
      duplicateSegmentIds.push(segment.id);
      continue;
    }

    units.push({
      text,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      segmentIds: [segment.id],
      speaker: segment.speaker,
    });
  }

  if (emptySegmentIds.length > 0) {
    warnings.push({
      code: "empty_segments_dropped",
      message: `已丢弃 ${emptySegmentIds.length} 条清洗后为空的字幕片段`,
      segmentIds: emptySegmentIds,
    });
  }
  if (duplicateSegmentIds.length > 0) {
    warnings.push({
      code: "adjacent_duplicates_merged",
      message: `已合并 ${duplicateSegmentIds.length} 条时间相邻且文本完全相同的字幕,来源 ID 已保留`,
      segmentIds: duplicateSegmentIds,
    });
  }

  return {
    units,
    warnings,
    emptySegmentCount: emptySegmentIds.length,
    duplicateSegmentCount: duplicateSegmentIds.length,
  };
}

/**
 * 生成可直接返回给 Agent 的干净 Transcript.
 *
 * 合并相邻完全重复字幕时,使用第一条来源 ID 作为片段 ID,并在 metadata 中保留
 * 全部 sourceSegmentIds,避免清理后无法回查被合并的原始片段.
 */
export function cleanTranscript(
  transcript: Transcript,
  rawOptions: TranscriptCleaningOptions = {},
): CleanedTranscriptResult {
  const source = TranscriptSchema.parse(transcript);
  const cleaned = cleanTranscriptSegments(source, rawOptions);
  const segmentById = new Map(source.segments.map((segment) => [segment.id, segment]));
  const segments = cleaned.units.map((unit) => {
    const primaryId = unit.segmentIds[0];
    const primary = primaryId ? segmentById.get(primaryId) : undefined;
    if (!primaryId || !primary) {
      throw new Error("字幕清理结果缺少可回查的来源片段");
    }

    return TranscriptSegmentSchema.parse({
      id: primaryId,
      startSeconds: unit.startSeconds,
      endSeconds: unit.endSeconds,
      text: unit.text,
      confidence: primary.confidence,
      speaker: unit.speaker,
      metadata: {
        ...(primary.metadata ?? {}),
        sourceSegmentIds: unit.segmentIds,
      },
    });
  });
  const stats = TranscriptCleaningStatsSchema.parse({
    inputSegmentCount: source.segments.length,
    outputSegmentCount: segments.length,
    emptySegmentCount: cleaned.emptySegmentCount,
    duplicateSegmentCount: cleaned.duplicateSegmentCount,
  });

  return {
    transcript: TranscriptSchema.parse({
      ...source,
      segments,
      metadata: {
        ...(source.metadata ?? {}),
        cleaningMethod: "deterministic_v1",
      },
    }),
    warnings: cleaned.warnings,
    stats,
  };
}

/** 技术性文本块的确定性分段配置. */
export const TranscriptChunkingOptionsSchema = z.object({
  /** 达到该字符数后,强标点可以结束当前文本块. */
  minCharacters: z.number().int().positive().default(48),
  /** 文本块目标最大字符数;单条原字幕已经超长时不会截断原文. */
  maxCharacters: z.number().int().positive().default(220),
  /** 文本块目标最大时长,单位:秒. */
  maxDurationSeconds: z.number().positive().default(45),
  /** 相邻字幕超过该间隔时结束当前文本块,单位:秒. */
  maxGapSeconds: z.number().nonnegative().default(2),
  /** 是否在达到最小长度后使用句末强标点结束文本块. */
  breakOnStrongPunctuation: z.boolean().default(true),
}).refine((options) => options.maxCharacters >= options.minCharacters, {
  message: "maxCharacters 必须大于等于 minCharacters",
  path: ["maxCharacters"],
});
export type TranscriptChunkingOptions = z.input<typeof TranscriptChunkingOptionsSchema>;

/** 分段阶段的纯计算结果. */
export interface ChunkTranscriptResult {
  /** 按时间排序的技术性文本块. */
  chunks: TranscriptChunk[];
  /** 超长单片段等无法在不改写原文的前提下消除的问题. */
  warnings: TranscriptProcessingWarning[];
}

type BoundaryReason =
  | "gap"
  | "speaker_change"
  | "max_characters"
  | "max_duration"
  | "strong_punctuation"
  | "end_of_transcript";

function characterCount(text: string): number {
  return Array.from(text).length;
}

function endsWithStrongPunctuation(text: string): boolean {
  return /[。！？!?；;….]$/u.test(text);
}

function appendText(current: string, next: string): string {
  if (current.length === 0) return next;
  const needsAsciiSpace = /[A-Za-z0-9,.;:!?)\]]$/u.test(current)
    && /^[A-Za-z0-9(\[]/u.test(next);
  return `${current}${needsAsciiSpace ? " " : ""}${next}`;
}

function chunkId(cid: string | undefined, units: CleanedTranscriptUnit[]): string {
  const firstId = units[0]?.segmentIds[0] ?? "unknown";
  const lastUnit = units.at(-1);
  const lastId = lastUnit?.segmentIds.at(-1) ?? firstId;
  return `transcript-chunk:${cid ?? "unknown"}:${firstId}:${lastId}`;
}

/**
 * 将清洗后的字幕单元合并为适合后续分析的技术性文本块.
 * 规则只处理时间、长度、说话人和标点,不尝试判断语义章节.
 */
export function chunkTranscriptUnits(
  units: CleanedTranscriptUnit[],
  cid: string | undefined,
  rawOptions: TranscriptChunkingOptions = {},
): ChunkTranscriptResult {
  const options = TranscriptChunkingOptionsSchema.parse(rawOptions);
  const chunks: TranscriptChunk[] = [];
  const warnings: TranscriptProcessingWarning[] = [];
  let currentUnits: CleanedTranscriptUnit[] = [];
  let currentText = "";

  const finalize = (boundaryReason: BoundaryReason): void => {
    if (currentUnits.length === 0) return;
    const first = currentUnits[0];
    const last = currentUnits.at(-1);
    if (!first || !last) return;

    chunks.push(TranscriptChunkSchema.parse({
      id: chunkId(cid, currentUnits),
      cid,
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
      text: currentText,
      segmentIds: currentUnits.flatMap((unit) => unit.segmentIds),
      metadata: {
        cleanedUnitCount: currentUnits.length,
        boundaryReason,
      },
    }));
    currentUnits = [];
    currentText = "";
  };

  for (const unit of units) {
    const previous = currentUnits.at(-1);
    if (previous) {
      const gapSeconds = unit.startSeconds - previous.endSeconds;
      const speakerChanged = previous.speaker !== undefined
        && unit.speaker !== undefined
        && previous.speaker !== unit.speaker;
      const candidateText = appendText(currentText, unit.text);
      const candidateDuration = unit.endSeconds - (currentUnits[0]?.startSeconds ?? unit.startSeconds);

      if (gapSeconds > options.maxGapSeconds) {
        finalize("gap");
      } else if (speakerChanged) {
        finalize("speaker_change");
      } else if (characterCount(candidateText) > options.maxCharacters) {
        finalize("max_characters");
      } else if (candidateDuration > options.maxDurationSeconds) {
        finalize("max_duration");
      }
    }

    currentUnits.push(unit);
    currentText = appendText(currentText, unit.text);

    const currentDuration = unit.endSeconds - (currentUnits[0]?.startSeconds ?? unit.startSeconds);
    const currentCharacters = characterCount(currentText);
    if (currentCharacters > options.maxCharacters || currentDuration > options.maxDurationSeconds) {
      warnings.push({
        code: "single_unit_exceeds_chunk_limit",
        message: "单条清洗字幕已超过文本块限制,为避免截断原文仍完整保留",
        segmentIds: [...unit.segmentIds],
      });
      finalize(currentCharacters > options.maxCharacters ? "max_characters" : "max_duration");
    } else if (
      options.breakOnStrongPunctuation
      && currentCharacters >= options.minCharacters
      && endsWithStrongPunctuation(currentText)
    ) {
      finalize("strong_punctuation");
    }
  }

  finalize("end_of_transcript");
  return { chunks, warnings };
}

/** 字幕预处理的可选规则配置. */
export interface PreprocessTranscriptOptions {
  /** 空白清理与相邻完全重复字幕处理配置. */
  cleaning?: TranscriptCleaningOptions;
  /** 技术性文本块的时间、长度与标点配置. */
  chunking?: TranscriptChunkingOptions;
}

/**
 * 对 Transcript 做确定性预处理.
 *
 * 函数不会修改原始 Transcript,也不生成语义章节或判断内容重要性.
 */
export function preprocessTranscript(
  transcript: Transcript,
  options: PreprocessTranscriptOptions = {},
): PreparedTranscript {
  const sourceTranscript = TranscriptSchema.parse(transcript);
  const cleaningOptions = TranscriptCleaningOptionsSchema.parse(options.cleaning ?? {});
  const chunkingOptions = TranscriptChunkingOptionsSchema.parse(options.chunking ?? {});
  const cleaned = cleanTranscriptSegments(sourceTranscript, cleaningOptions);
  const chunked = chunkTranscriptUnits(cleaned.units, sourceTranscript.cid, chunkingOptions);
  const warnings: TranscriptProcessingWarning[] = [
    ...cleaned.warnings,
    ...chunked.warnings,
  ];

  if (sourceTranscript.segments.length === 0) {
    warnings.push({
      code: "transcript_empty",
      message: "输入 Transcript 没有字幕片段",
      segmentIds: [],
    });
  }
  if (!sourceTranscript.complete) {
    warnings.push({
      code: "source_transcript_incomplete",
      message: "原始 Transcript 未覆盖完整目标范围,预处理结果不能视为全片内容",
      segmentIds: [],
    });
  }

  const meaningfulSegmentIds = sourceTranscript.segments
    .filter((segment) => normalizeTranscriptText(segment.text).length > 0)
    .map((segment) => segment.id);
  const expectedSegmentIds = new Set(meaningfulSegmentIds);
  const seenSegmentIds = new Set<string>();
  const duplicateSourceIdSet = new Set<string>();
  for (const id of meaningfulSegmentIds) {
    if (seenSegmentIds.has(id)) duplicateSourceIdSet.add(id);
    seenSegmentIds.add(id);
  }
  const duplicateSourceIds = [...duplicateSourceIdSet];
  const mappedSegmentIds = new Set(chunked.chunks.flatMap((chunk) => chunk.segmentIds));
  const coverageComplete = duplicateSourceIds.length === 0
    && expectedSegmentIds.size === mappedSegmentIds.size
    && [...expectedSegmentIds].every((id) => mappedSegmentIds.has(id));

  if (duplicateSourceIds.length > 0) {
    warnings.push({
      code: "duplicate_segment_ids",
      message: "原始 Transcript 存在重复字幕 ID,无法保证每条来源的唯一回查关系",
      segmentIds: duplicateSourceIds,
    });
  }

  if (!coverageComplete && duplicateSourceIds.length === 0) {
    const missingIds = [...expectedSegmentIds].filter((id) => !mappedSegmentIds.has(id));
    warnings.push({
      code: "chunk_coverage_incomplete",
      message: "部分非空原始字幕没有映射到技术性文本块",
      segmentIds: missingIds,
    });
  }

  return PreparedTranscriptSchema.parse({
    source: sourceTranscript.source,
    language: sourceTranscript.language,
    cid: sourceTranscript.cid,
    sourceComplete: sourceTranscript.complete,
    coverageComplete,
    complete: sourceTranscript.complete && coverageComplete && chunked.chunks.length > 0,
    chunks: chunked.chunks,
    warnings,
    stats: {
      inputSegmentCount: sourceTranscript.segments.length,
      emptySegmentCount: cleaned.emptySegmentCount,
      duplicateSegmentCount: cleaned.duplicateSegmentCount,
      cleanedUnitCount: cleaned.units.length,
      chunkCount: chunked.chunks.length,
      mappedSegmentCount: mappedSegmentIds.size,
    },
    metadata: {
      processingVersion: "v1",
      cleaningOptions,
      chunkingOptions,
    },
  });
}

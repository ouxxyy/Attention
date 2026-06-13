import {
  computeMetrics,
  matchesKeywordRules,
  resolveMainTaskKeys,
  type MetricsSummary
} from '../shared/metrics.js';
import { normalizeEvents, type NormalizationEvent } from '../shared/normalize.js';
import type { Config, TaskSegment } from '../shared/types.js';
import type { ActivityWatchBucketGroup, DayEventsResponse } from './activitywatch.js';

export type DataStatus = 'ok' | 'sparse' | 'missing';

export interface DataSufficiency {
  status: DataStatus;
  rawEventCount: number;
  normalizedSegmentCount: number;
  activeTimeSec: number;
  notes: string[];
}

export interface MergedItem {
  app: string;
  title: string;
  durationSec: number;
}

export interface TaskDuration {
  taskKey: string;
  app: string;
  title: string;
  source: TaskSegment['source'];
  domain?: string;
  url?: string;
  durationSec: number;
  segmentCount: number;
  firstSeen: string;
  lastSeen: string;
  /** 合并前各原始活动的明细（仅当该 task 由多条不同活动合并时有值） */
  mergedItems?: MergedItem[];
}

export interface SwitchTimelineEntry {
  at: string;
  start: string;
  end: string;
  durationSec: number;
  taskKey: string;
  app: string;
  title: string;
  source: TaskSegment['source'];
  domain?: string;
  url?: string;
  fromTaskKey?: string;
  taskGroupKey: string;
  fromTaskGroupKey?: string;
  gapSec: number;
  isSwitch: boolean;
}

export interface DailySummaryResponse {
  date: string;
  range: DayEventsResponse['range'];
  dataStatus: DataStatus;
  dataSufficiency: DataSufficiency;
  metrics: MetricsSummary;
  flowBlocks: ReturnType<typeof computeMetrics>['flowBlocks'];
  confidence: TaskSegment['confidence'];
  warnings: string[];
  topTasks: TaskDuration[];
  switchTimeline: SwitchTimelineEntry[];
  unclassifiedActivityCandidates: TaskDuration[];
}

export interface TrendDayEntry {
  date: string;
  dataStatus: DataStatus;
  dataSufficiency: DataSufficiency;
  metrics: MetricsSummary;
  confidence: TaskSegment['confidence'];
  warnings: string[];
  flowBlockCount: number;
  flowDurationSec: number;
  topTasks: TaskDuration[];
  unclassifiedActivityCandidates: TaskDuration[];
}

export interface TrendsResponse {
  days: number;
  end: string;
  entries: TrendDayEntry[];
}

const relevantTypes: ActivityWatchBucketGroup[] = ['currentwindow', 'web.tab.current', 'afkstatus'];
const SWITCH_GAP_MAX_SEC = 300;
const MEANINGFUL_SWITCH_MIN_SEGMENT_SEC = 15;

export function buildDailySummary(dayEvents: DayEventsResponse, config: Config): DailySummaryResponse {
  const input = toNormalizationInput(dayEvents);
  const rawEventCount = countRawEvents(dayEvents);
  const segments = normalizeEvents(input, config);
  const metricsResult = computeMetrics(segments, config);
  const dataSufficiency = buildDataSufficiency(rawEventCount, segments.length, metricsResult.metrics.activeTimeSec);
  const resolvedTaskKeys = resolveMainTaskKeys(orderedSegments(segments), config);
  const topTasks = aggregateTasks(segments, resolvedTaskKeys);
  const rawTopTasks = aggregateRawTasks(segments);
  const response: DailySummaryResponse = {
    date: dayEvents.date,
    range: dayEvents.range,
    dataStatus: dataSufficiency.status,
    dataSufficiency,
    metrics: metricsResult.metrics,
    flowBlocks: metricsResult.flowBlocks,
    confidence: metricsResult.confidence,
    warnings: uniqueStrings([...dayEvents.warnings, ...metricsResult.warnings]),
    topTasks,
    switchTimeline: buildSwitchTimeline(segments, resolvedTaskKeys),
    unclassifiedActivityCandidates: rawTopTasks.filter(
      task => !matchesKeywordRules(task, config.mainTaskKeywords, config.sharedKeywords)
    )
  };

  return sanitizeFinite(response);
}

export function buildTrendEntry(summary: DailySummaryResponse): TrendDayEntry {
  return sanitizeFinite({
    date: summary.date,
    dataStatus: summary.dataStatus,
    dataSufficiency: summary.dataSufficiency,
    metrics: summary.metrics,
    confidence: summary.confidence,
    warnings: summary.warnings,
    flowBlockCount: summary.flowBlocks.length,
    flowDurationSec: summary.flowBlocks.reduce((sum, block) => sum + block.activeDurationSec, 0),
    topTasks: summary.topTasks.slice(0, 5),
    unclassifiedActivityCandidates: summary.unclassifiedActivityCandidates.slice(0, 5)
  });
}

export function buildTrendsResponse(days: number, end: string, summaries: DailySummaryResponse[]): TrendsResponse {
  return sanitizeFinite({
    days,
    end,
    entries: summaries.map(buildTrendEntry)
  });
}

export function dateRangeEnding(end: string, days: number): string[] {
  const [year, month, day] = end.split('-').map(Number);
  const endDate = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Array.from({ length: days }, (_unused, index) => {
    const date = new Date(endDate);
    date.setDate(endDate.getDate() - (days - 1 - index));
    return toLocalDateString(date);
  });
}

export function todayLocalDate(): string {
  return toLocalDateString(new Date());
}

function toNormalizationInput(dayEvents: DayEventsResponse): {
  windowEvents: NormalizationEvent[];
  webEvents: NormalizationEvent[];
  afkEvents: NormalizationEvent[];
} {
  return {
    windowEvents: flattenEvents(dayEvents, 'currentwindow'),
    webEvents: flattenEvents(dayEvents, 'web.tab.current'),
    afkEvents: flattenEvents(dayEvents, 'afkstatus')
  };
}

function flattenEvents(dayEvents: DayEventsResponse, type: ActivityWatchBucketGroup): NormalizationEvent[] {
  return dayEvents.events[type].flatMap(bucketEvents =>
    bucketEvents.events.map(event => ({
      bucketId: bucketEvents.bucket.id,
      bucketType: type,
      timestamp: event.timestamp,
      duration: event.duration,
      data: event.data,
      id: event.id,
      day: dayEvents.date
    }))
  );
}

function countRawEvents(dayEvents: DayEventsResponse): number {
  return relevantTypes.reduce(
    (sum, type) => sum + dayEvents.events[type].reduce((bucketSum, bucketEvents) => bucketSum + bucketEvents.events.length, 0),
    0
  );
}

function buildDataSufficiency(rawEventCount: number, normalizedSegmentCount: number, activeTimeSec: number): DataSufficiency {
  if (rawEventCount === 0) {
    return {
      status: 'missing',
      rawEventCount,
      normalizedSegmentCount,
      activeTimeSec,
      notes: ['当天没有 currentwindow/web/afk ActivityWatch 事件，无法计算真实活动指标']
    };
  }

  if (normalizedSegmentCount === 0 || activeTimeSec < 60) {
    return {
      status: 'sparse',
      rawEventCount,
      normalizedSegmentCount,
      activeTimeSec,
      notes: ['当天原始事件过少或有效活动不足 1 分钟，指标仅供参考']
    };
  }

  return {
    status: 'ok',
    rawEventCount,
    normalizedSegmentCount,
    activeTimeSec,
    notes: []
  };
}

function aggregateTasks(segments: TaskSegment[], resolvedTaskKeys: string[]): TaskDuration[] {
  const byTask = new Map<string, TaskDuration>();
  const appsByTask = new Map<string, Set<string>>();
  /** 收集每个 taskKey 下各原始 app:title 的累计时长 */
  const itemsByTask = new Map<string, Map<string, MergedItem>>();
  const ordered = orderedSegments(segments);
  for (const [index, segment] of ordered.entries()) {
    const taskKey = resolvedTaskKeys[index] ?? segment.taskKey;
    const isRuleGroup = taskKey.startsWith('主任务:');
    const existing = byTask.get(taskKey);
    if (existing) {
      existing.durationSec += safeDuration(segment.durationSec);
      existing.segmentCount += 1;
      existing.lastSeen = segment.end;
      const apps = appsByTask.get(taskKey);
      apps?.add(segment.app);
      if (apps && apps.size > 1) {
        existing.app = `${apps.size} 个工具/网页`;
      }
    } else {
      appsByTask.set(taskKey, new Set([segment.app]));
      byTask.set(taskKey, {
        taskKey,
        app: segment.app,
        title: isRuleGroup ? taskKey.replace(/^主任务:/, '') : segment.title,
        source: segment.source,
        domain: segment.domain,
        url: segment.url,
        durationSec: safeDuration(segment.durationSec),
        segmentCount: 1,
        firstSeen: segment.start,
        lastSeen: segment.end
      });
    }

    // 收集原始活动明细
    let itemMap = itemsByTask.get(taskKey);
    if (!itemMap) {
      itemMap = new Map();
      itemsByTask.set(taskKey, itemMap);
    }
    const itemKey = `${segment.app}:${segment.title}`;
    const prev = itemMap.get(itemKey);
    if (prev) {
      prev.durationSec += safeDuration(segment.durationSec);
    } else {
      itemMap.set(itemKey, {
        app: segment.app,
        title: segment.title,
        durationSec: safeDuration(segment.durationSec)
      });
    }
  }

  // 将明细挂到对应的 TaskDuration 上（仅当有 ≥2 条不同活动时才有意义）
  for (const [taskKey, task] of byTask) {
    const itemMap = itemsByTask.get(taskKey);
    if (itemMap && itemMap.size >= 2) {
      task.mergedItems = [...itemMap.values()].sort((a, b) => b.durationSec - a.durationSec);
    }
  }

  return [...byTask.values()].sort(
    (left, right) => right.durationSec - left.durationSec || left.firstSeen.localeCompare(right.firstSeen)
  );
}

function aggregateRawTasks(segments: TaskSegment[]): TaskDuration[] {
  const byTask = new Map<string, TaskDuration>();
  for (const segment of orderedSegments(segments)) {
    const existing = byTask.get(segment.taskKey);
    if (existing) {
      existing.durationSec += safeDuration(segment.durationSec);
      existing.segmentCount += 1;
      existing.lastSeen = segment.end;
      continue;
    }

    byTask.set(segment.taskKey, {
      taskKey: segment.taskKey,
      app: segment.app,
      title: segment.title,
      source: segment.source,
      domain: segment.domain,
      url: segment.url,
      durationSec: safeDuration(segment.durationSec),
      segmentCount: 1,
      firstSeen: segment.start,
      lastSeen: segment.end
    });
  }

  return [...byTask.values()].sort(
    (left, right) => right.durationSec - left.durationSec || left.firstSeen.localeCompare(right.firstSeen)
  );
}

function buildSwitchTimeline(segments: TaskSegment[], resolvedTaskKeys: string[]): SwitchTimelineEntry[] {
  const ordered = orderedSegments(segments);
  return ordered.map((segment, index) => {
    const previous = ordered[index - 1];
    const gapSec = previous ? Math.max(0, (Date.parse(segment.start) - Date.parse(previous.end)) / 1000) : 0;
    const currentGroupKey = resolvedTaskKeys[index] ?? segment.taskKey;
    const previousGroupKey = previous ? resolvedTaskKeys[index - 1] ?? previous.taskKey : undefined;
    const isMeaningfulSwitch = Boolean(
      previous &&
        previousGroupKey !== currentGroupKey &&
        gapSec <= SWITCH_GAP_MAX_SEC &&
        safeDuration(previous.durationSec) >= MEANINGFUL_SWITCH_MIN_SEGMENT_SEC &&
        safeDuration(segment.durationSec) >= MEANINGFUL_SWITCH_MIN_SEGMENT_SEC
    );
    return {
      at: segment.start,
      start: segment.start,
      end: segment.end,
      durationSec: safeDuration(segment.durationSec),
      taskKey: segment.taskKey,
      app: segment.app,
      title: segment.title,
      source: segment.source,
      domain: segment.domain,
      url: segment.url,
      fromTaskKey: previous?.taskKey,
      taskGroupKey: currentGroupKey,
      fromTaskGroupKey: previousGroupKey,
      gapSec,
      isSwitch: isMeaningfulSwitch
    };
  });
}

function orderedSegments(segments: TaskSegment[]): TaskSegment[] {
  return [...segments].sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sanitizeFinite<T>(value: T): T {
  if (typeof value === 'number') {
    return (Number.isFinite(value) ? value : 0) as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeFinite(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeFinite(entry)])
    ) as T;
  }
  return value;
}

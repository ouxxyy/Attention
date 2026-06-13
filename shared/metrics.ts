import { defaultConfig } from './defaults.js';
import type { Config, KeywordRule, TaskSegment } from './types.js';

/**
 * 历史兼容保留。
 * 早期版本会把“共享任一关键词”的规则合并为亲和组，但这在用户给多条规则复用通用关键词时，
 * 会把本应不同的事情（如“自媒体/编程/工作”）错误地揉成同一组。
 * 现在 flow/switch 直接按最终命中的规则标签分组，不再使用这个映射做跨规则合并。
 */
export function buildKeywordAffinity(config: Config): Map<string, string> {
  return new Map(config.mainTaskKeywords.map(rule => [rule.label, rule.label]));
}

/**
 * 返回段落在"亲和组"视角下的任务 key。
 * 如果段未命中任何规则，返回原始 taskKey（不与任何亲和组合并）。
 */
export function flowGroupKey(
  segment: Pick<TaskSegment, 'taskKey' | 'app' | 'title' | 'domain' | 'url'>,
  config: Config,
  affinity: Map<string, string>
): string {
  const rule = findHighestPriorityRule(segment, config.mainTaskKeywords, config.sharedKeywords);
  if (!rule) return segment.taskKey;
  return `主任务:${rule.label}`;
}

const SWITCH_GAP_MAX_SEC = 300;
const FLOW_INTERNAL_GAP_MAX_SEC = 60;
const MEANINGFUL_SWITCH_MIN_SEGMENT_SEC = 15;
const LOW_URL_CONFIDENCE_WARNING = 'URL 数据不足，已使用窗口标题兜底';
const MAIN_TASK_UNMATCHED_NOTE = '还没认出今天主要在忙什么，所以“不在主要事情里的时间”先不扣分。请在底部添加你的主要事情。';

export interface ComponentScores {
  frequentSwitchScore: number;
  shortStayScore: number;
  deviationScore: number;
  recoveryScore: number;
}

export interface MetricsSummary {
  activeTimeSec: number;
  switchCount: number;
  rawSwitchCount: number;
  meaningfulSwitchCount: number;
  shortStayCount: number;
  shortStayTimeSec: number;
  frequentWindows: number;
  mainTaskTimeSec: number;
  primaryMainTaskLabel?: string;
  deviationRatio: number;
  recoveryCostMin: number;
  componentScores: ComponentScores;
  energyWasteScore: number;
  scoringVersion: 'v2';
  scoringNotes: string[];
}

export interface FlowBlock {
  taskKey: string;
  start: string;
  end: string;
  activeDurationSec: number;
  toleratedInterruptions: number;
  segmentCount: number;
}

export interface MetricsResult {
  metrics: MetricsSummary;
  flowBlocks: FlowBlock[];
  confidence: TaskSegment['confidence'];
  warnings: string[];
}

interface TimedSegment extends TaskSegment {
  startMs: number;
  endMs: number;
  durationSec: number;
}

export function computeMetrics(segments: TaskSegment[], config: Config = defaultConfig): MetricsResult {
  const orderedSegments = normalizeMetricSegments(segments);
  const resolvedTaskKeys = resolveMainTaskKeys(orderedSegments, config);
  const activeTimeSec = orderedSegments.reduce((sum, segment) => sum + segment.durationSec, 0);
  const rawSwitches = collectSwitches(orderedSegments, segment => segment.taskKey);
  const taskSwitches = collectSwitchesByKeys(orderedSegments, resolvedTaskKeys);
  const rawSwitchCount = rawSwitches.length;
  const meaningfulSwitches = taskSwitches.filter(isMeaningfulSwitch);
  const meaningfulSwitchCount = meaningfulSwitches.length;
  const shortStayCount = orderedSegments.filter(segment => segment.durationSec <= config.thresholds.shortSwitchMaxMinutes * 60).length;
  const shortStayTimeSec = orderedSegments
    .filter(segment => segment.durationSec <= config.thresholds.shortSwitchMaxMinutes * 60)
    .reduce((sum, segment) => sum + segment.durationSec, 0);
  const frequentWindows = countFrequentWindows(meaningfulSwitches.map(switchEvent => switchEvent.atMs), config);
  const mainTaskStats = calculateMainTaskStats(orderedSegments, resolvedTaskKeys, config);
  const mainTaskTimeSec = mainTaskStats.mainTaskTimeSec;
  const deviationRatio = activeTimeSec === 0 ? 0 : safeFinite(1 - mainTaskTimeSec / activeTimeSec);
  const hasMainTaskSignal = mainTaskTimeSec > 0;
  const scoringNotes = hasMainTaskSignal || activeTimeSec === 0 ? [] : [MAIN_TASK_UNMATCHED_NOTE];
  const recoveryCostMin = meaningfulSwitchCount * 1.5;
  const componentScores = calculateComponentScores({
    activeTimeSec,
    meaningfulSwitchCount,
    shortStayTimeSec,
    frequentWindows,
    deviationRatio,
    recoveryCostMin,
    hasMainTaskSignal
  });
  const energyWasteScore = Math.round(
    0.35 * componentScores.frequentSwitchScore +
      0.25 * componentScores.shortStayScore +
      0.25 * componentScores.deviationScore +
      0.15 * componentScores.recoveryScore
  );
  const confidence = calculateConfidence(orderedSegments, activeTimeSec);

  return {
    metrics: {
      activeTimeSec,
      switchCount: rawSwitchCount,
      rawSwitchCount,
      meaningfulSwitchCount,
      shortStayCount,
      shortStayTimeSec,
      frequentWindows,
      mainTaskTimeSec,
      primaryMainTaskLabel: mainTaskStats.primaryMainTaskLabel,
      deviationRatio,
      recoveryCostMin,
      componentScores,
      energyWasteScore,
      scoringVersion: 'v2',
      scoringNotes
    },
    flowBlocks: detectFlowBlocks(orderedSegments, resolvedTaskKeys, config),
    confidence,
    warnings: confidence === 'low' && activeTimeSec > 0 ? [LOW_URL_CONFIDENCE_WARNING] : []
  };
}

function normalizeMetricSegments(segments: TaskSegment[]): TimedSegment[] {
  return segments
    .map(segment => {
      const startMs = Date.parse(segment.start);
      const endMs = Date.parse(segment.end);
      const durationSec = safeDuration(segment.durationSec);
      return { ...segment, startMs, endMs, durationSec };
    })
    .filter(segment => Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.endMs >= segment.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

interface SwitchEvent {
  atMs: number;
  previous: TimedSegment;
  current: TimedSegment;
}

function collectSwitchesByKeys(segments: TimedSegment[], keys: string[]): SwitchEvent[] {
  const switches: SwitchEvent[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const gapSec = (current.startMs - previous.endMs) / 1000;
    if (keys[index] !== keys[index - 1] && gapSec <= SWITCH_GAP_MAX_SEC) {
      switches.push({ atMs: current.startMs, previous, current });
    }
  }

  return switches;
}

function collectSwitches(segments: TimedSegment[], keyForSegment: (segment: TimedSegment) => string): SwitchEvent[] {
  const switches: SwitchEvent[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const gapSec = (current.startMs - previous.endMs) / 1000;
    if (keyForSegment(current) !== keyForSegment(previous) && gapSec <= SWITCH_GAP_MAX_SEC) {
      switches.push({ atMs: current.startMs, previous, current });
    }
  }

  return switches;
}

function isMeaningfulSwitch(switchEvent: SwitchEvent): boolean {
  return (
    switchEvent.previous.durationSec >= MEANINGFUL_SWITCH_MIN_SEGMENT_SEC &&
    switchEvent.current.durationSec >= MEANINGFUL_SWITCH_MIN_SEGMENT_SEC
  );
}

function countFrequentWindows(switchTimes: number[], config: Config): number {
  const windowMs = config.thresholds.frequentSwitchWindowMinutes * 60 * 1000;
  const threshold = config.thresholds.frequentSwitchCount;
  let frequentWindows = 0;
  let cursor = 0;

  while (cursor < switchTimes.length) {
    const windowStart = switchTimes[cursor];
    const windowEnd = windowStart + windowMs;
    let nextOutsideWindow = cursor;

    while (nextOutsideWindow < switchTimes.length && switchTimes[nextOutsideWindow] < windowEnd) {
      nextOutsideWindow += 1;
    }

    if (nextOutsideWindow - cursor >= threshold) {
      frequentWindows += 1;
      cursor = nextOutsideWindow;
    } else {
      cursor += 1;
    }
  }

  return frequentWindows;
}

function calculateMainTaskStats(
  segments: TimedSegment[],
  resolvedTaskKeys: string[],
  config: Config
): { mainTaskTimeSec: number; primaryMainTaskLabel?: string } {
  let mainTaskTimeSec = 0;
  let primaryRule: KeywordRule | undefined;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const resolvedTaskKey = resolvedTaskKeys[index];
    if (!resolvedTaskKey.startsWith('主任务:')) {
      continue;
    }

    const label = resolvedTaskKey.replace(/^主任务:/, '');
    const rule = config.mainTaskKeywords.find(item => item.label === label);
    if (!rule) {
      continue;
    }

    mainTaskTimeSec += segment.durationSec;
    if (!primaryRule || rule.priority > primaryRule.priority) {
      primaryRule = rule;
    }
  }

  return { mainTaskTimeSec, primaryMainTaskLabel: primaryRule?.label };
}

type KeywordMatchTarget = string | Pick<TaskSegment, 'taskKey' | 'app' | 'title' | 'domain' | 'url'>;

function keywordMatchText(target: KeywordMatchTarget): string {
  if (typeof target === 'string') {
    return target.toLowerCase();
  }

  return [target.taskKey, target.title, target.app, target.domain, target.url]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();
}

function buildSharedKeywordSet(sharedKeywords: string[]): Set<string> {
  return new Set(sharedKeywords.map(keyword => keyword.toLowerCase()));
}

function matchesSharedKeyword(target: KeywordMatchTarget, sharedKeywords: string[]): boolean {
  if (sharedKeywords.length === 0) return false;
  const haystack = keywordMatchText(target);
  return sharedKeywords.some(keyword => haystack.includes(keyword.toLowerCase()));
}

export function findHighestPriorityRule(
  target: KeywordMatchTarget,
  rules: KeywordRule[],
  sharedKeywords: string[] = []
): KeywordRule | undefined {
  const haystack = keywordMatchText(target);
  const sharedKeywordSet = buildSharedKeywordSet(sharedKeywords);
  let bestRule: KeywordRule | undefined;

  for (const rule of rules) {
    const matches = rule.patterns.some(pattern => {
      const lower = pattern.toLowerCase();
      return !sharedKeywordSet.has(lower) && haystack.includes(lower);
    });
    if (matches && (!bestRule || rule.priority > bestRule.priority)) {
      bestRule = rule;
    }
  }

  return bestRule;
}

export function matchesKeywordRules(
  target: KeywordMatchTarget,
  rules: KeywordRule[],
  sharedKeywords: string[] = []
): boolean {
  return Boolean(findHighestPriorityRule(target, rules, sharedKeywords)) || matchesSharedKeyword(target, sharedKeywords);
}

export function analysisTaskKey(segment: Pick<TaskSegment, 'taskKey' | 'app' | 'title' | 'domain' | 'url'>, config: Config): string {
  const rule = findHighestPriorityRule(segment, config.mainTaskKeywords, config.sharedKeywords);
  return rule ? `主任务:${rule.label}` : segment.taskKey;
}

export function resolveMainTaskLabels<T extends Pick<TaskSegment, 'taskKey' | 'app' | 'title' | 'domain' | 'url'>>(
  segments: T[],
  config: Config
): Array<string | undefined> {
  const directMatches = segments.map(segment => findHighestPriorityRule(segment, config.mainTaskKeywords, config.sharedKeywords)?.label);
  const sharedOnlyMatches = segments.map(
    (segment, index) => !directMatches[index] && matchesSharedKeyword(segment, config.sharedKeywords)
  );
  const resolved: Array<string | undefined> = [];

  for (let index = 0; index < directMatches.length; index += 1) {
    const directMatch = directMatches[index];
    if (directMatch) {
      resolved[index] = directMatch;
      continue;
    }

    if (sharedOnlyMatches[index]) {
      resolved[index] = resolved[index - 1] ?? nextDirectRuleLabel(directMatches, index + 1);
      continue;
    }

    resolved[index] = undefined;
  }

  return resolved;
}

export function resolveMainTaskKeys<T extends Pick<TaskSegment, 'taskKey' | 'app' | 'title' | 'domain' | 'url'>>(
  segments: T[],
  config: Config
): string[] {
  const labels = resolveMainTaskLabels(segments, config);
  return labels.map((label, index) => (label ? `主任务:${label}` : segments[index].taskKey));
}

function nextDirectRuleLabel(directMatches: Array<string | undefined>, startIndex: number): string | undefined {
  for (let index = startIndex; index < directMatches.length; index += 1) {
    if (directMatches[index]) {
      return directMatches[index];
    }
  }
  return undefined;
}

function calculateComponentScores(input: {
  activeTimeSec: number;
  meaningfulSwitchCount: number;
  shortStayTimeSec: number;
  frequentWindows: number;
  deviationRatio: number;
  recoveryCostMin: number;
  hasMainTaskSignal: boolean;
}): ComponentScores {
  return {
    frequentSwitchScore: Math.min(100, input.frequentWindows * 25 + input.meaningfulSwitchCount * 2),
    shortStayScore:
      input.activeTimeSec === 0 ? 0 : Math.min(100, (input.shortStayTimeSec * 100) / input.activeTimeSec),
    deviationScore: input.hasMainTaskSignal ? Math.round(input.deviationRatio * 100) : 0,
    recoveryScore: Math.min(100, (input.recoveryCostMin * 100) / 60)
  };
}

function detectFlowBlocks(segments: TimedSegment[], resolvedTaskKeys: string[], config: Config): FlowBlock[] {
  const flowMinSec = config.thresholds.flowMinMinutes * 60;
  const shortInterruptionMaxSec = config.thresholds.shortSwitchMaxMinutes * 60;
  const afkGraceSec = config.thresholds.afkGraceMinutes * 60;
  const flowBlocks: FlowBlock[] = [];
  let cursor = 0;

  while (cursor < segments.length) {
    const baseSegment = segments[cursor];
    const baseTaskKey = resolvedTaskKeys[cursor];
    let activeDurationSec = baseSegment.durationSec;
    let toleratedInterruptions = 0;
    let sameTaskSegmentCount = 1;
    let lastEndMs = baseSegment.endMs;
    let endIndex = cursor;
    let scan = cursor + 1;

    while (scan < segments.length) {
      const nextSegment = segments[scan];
      const gapSec = (nextSegment.startMs - lastEndMs) / 1000;
      if (gapSec > afkGraceSec) {
        break;
      }

      if (resolvedTaskKeys[scan] === baseTaskKey) {
        if (gapSec > FLOW_INTERNAL_GAP_MAX_SEC) {
          toleratedInterruptions += 1;
        }
        activeDurationSec += nextSegment.durationSec;
        sameTaskSegmentCount += 1;
        lastEndMs = nextSegment.endMs;
        endIndex = scan;
        scan += 1;
        continue;
      }

      if (!isTolerableInterruption(segments, resolvedTaskKeys, scan, baseTaskKey, shortInterruptionMaxSec)) {
        break;
      }

      toleratedInterruptions += 1;
      lastEndMs = nextSegment.endMs;
      endIndex = scan;
      scan += 1;
    }

    const allowedInterruptions = Math.floor(activeDurationSec / flowMinSec);
    if (activeDurationSec >= flowMinSec && toleratedInterruptions <= allowedInterruptions) {
      flowBlocks.push({
        taskKey: baseTaskKey,
        start: baseSegment.start,
        end: segments[endIndex].end,
        activeDurationSec,
        toleratedInterruptions,
        segmentCount: sameTaskSegmentCount
      });
      cursor = endIndex + 1;
    } else {
      cursor += 1;
    }
  }

  return flowBlocks;
}

function isTolerableInterruption(
  segments: TimedSegment[],
  resolvedTaskKeys: string[],
  interruptionIndex: number,
  taskKey: string,
  shortInterruptionMaxSec: number
): boolean {
  const interruption = segments[interruptionIndex];
  const nextSameTask = segments[interruptionIndex + 1];
  if (
    !nextSameTask ||
    interruption.durationSec > shortInterruptionMaxSec ||
    resolvedTaskKeys[interruptionIndex + 1] !== taskKey
  ) {
    return false;
  }

  return (nextSameTask.startMs - interruption.endMs) / 1000 <= FLOW_INTERNAL_GAP_MAX_SEC;
}

function calculateConfidence(segments: TimedSegment[], activeTimeSec: number): TaskSegment['confidence'] {
  if (activeTimeSec <= 0) {
    return 'low';
  }

  const webKnownSec = segments
    .filter(segment => segment.source === 'web' && (Boolean(segment.url) || Boolean(segment.domain)))
    .reduce((sum, segment) => sum + segment.durationSec, 0);
  const ratio = webKnownSec / activeTimeSec;

  if (ratio >= 0.7) {
    return 'high';
  }

  if (ratio >= 0.3) {
    return 'medium';
  }

  return 'low';
}

function safeDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return 0;
  }

  return durationSec;
}

function safeFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

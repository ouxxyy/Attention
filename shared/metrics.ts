import { defaultConfig } from './defaults.js';
import type { Config, KeywordRule, TaskSegment } from './types.js';

/**
 * 构建关键词亲和组：若两个规则共享至少一个关键词 pattern，则视为同一"亲和组"。
 * 返回 Map<ruleLabel, canonicalGroupKey>，其中 canonicalGroupKey 是组内字典序最小的 label。
 * 用于流检测和切换计数——同一亲和组内的切换不算「换到别的事」。
 */
export function buildKeywordAffinity(config: Config): Map<string, string> {
  const rules = config.mainTaskKeywords;
  // pattern → 包含该 pattern 的 rule labels
  const patternToLabels = new Map<string, Set<string>>();
  for (const rule of rules) {
    const lowerLabel = rule.label;
    for (const pattern of rule.patterns) {
      const lower = pattern.toLowerCase();
      let labels = patternToLabels.get(lower);
      if (!labels) {
        labels = new Set();
        patternToLabels.set(lower, labels);
      }
      labels.add(lowerLabel);
    }
  }

  // Union-Find 合并共享 pattern 的 rule labels
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const rule of rules) {
    const label = rule.label;
    if (!parent.has(label)) parent.set(label, label);
  }

  for (const labels of patternToLabels.values()) {
    const arr = [...labels];
    for (let i = 1; i < arr.length; i++) {
      union(arr[0], arr[i]);
    }
  }

  // 每组取字典序最小的 label 作为 canonical key
  const groupRoots = new Map<string, string>();
  const affinity = new Map<string, string>();
  for (const rule of rules) {
    const label = rule.label;
    const root = find(label);
    let canonical = groupRoots.get(root);
    if (!canonical || label < canonical) {
      canonical = label;
      groupRoots.set(root, canonical);
    }
  }
  for (const rule of rules) {
    const label = rule.label;
    affinity.set(label, groupRoots.get(find(label)) ?? label);
  }

  return affinity;
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
  const rule = findHighestPriorityRule(segment, config.mainTaskKeywords);
  if (!rule) return segment.taskKey;
  return `主任务:${affinity.get(rule.label) ?? rule.label}`;
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
  const affinity = buildKeywordAffinity(config);
  const activeTimeSec = orderedSegments.reduce((sum, segment) => sum + segment.durationSec, 0);
  const rawSwitches = collectSwitches(orderedSegments, segment => segment.taskKey);
  const taskSwitches = collectSwitches(orderedSegments, segment => flowGroupKey(segment, config, affinity));
  const rawSwitchCount = rawSwitches.length;
  const meaningfulSwitches = taskSwitches.filter(isMeaningfulSwitch);
  const meaningfulSwitchCount = meaningfulSwitches.length;
  const shortStayCount = orderedSegments.filter(segment => segment.durationSec <= config.thresholds.shortSwitchMaxMinutes * 60).length;
  const shortStayTimeSec = orderedSegments
    .filter(segment => segment.durationSec <= config.thresholds.shortSwitchMaxMinutes * 60)
    .reduce((sum, segment) => sum + segment.durationSec, 0);
  const frequentWindows = countFrequentWindows(meaningfulSwitches.map(switchEvent => switchEvent.atMs), config);
  const mainTaskStats = calculateMainTaskStats(orderedSegments, config);
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
    flowBlocks: detectFlowBlocks(orderedSegments, config, affinity),
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
  config: Config
): { mainTaskTimeSec: number; primaryMainTaskLabel?: string } {
  let mainTaskTimeSec = 0;
  let primaryRule: KeywordRule | undefined;

  for (const segment of segments) {
    const rule = findHighestPriorityRule(segment, config.mainTaskKeywords);
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

export function findHighestPriorityRule(target: KeywordMatchTarget, rules: KeywordRule[]): KeywordRule | undefined {
  const haystack = keywordMatchText(target);
  let bestRule: KeywordRule | undefined;

  for (const rule of rules) {
    const matches = rule.patterns.some(pattern => haystack.includes(pattern.toLowerCase()));
    if (matches && (!bestRule || rule.priority > bestRule.priority)) {
      bestRule = rule;
    }
  }

  return bestRule;
}

export function matchesKeywordRules(target: KeywordMatchTarget, rules: KeywordRule[]): boolean {
  return Boolean(findHighestPriorityRule(target, rules));
}

export function analysisTaskKey(segment: Pick<TaskSegment, 'taskKey' | 'app' | 'title' | 'domain' | 'url'>, config: Config): string {
  const rule = findHighestPriorityRule(segment, config.mainTaskKeywords);
  return rule ? `主任务:${rule.label}` : segment.taskKey;
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

function detectFlowBlocks(segments: TimedSegment[], config: Config, affinity: Map<string, string>): FlowBlock[] {
  const flowMinSec = config.thresholds.flowMinMinutes * 60;
  const shortInterruptionMaxSec = config.thresholds.shortSwitchMaxMinutes * 60;
  const afkGraceSec = config.thresholds.afkGraceMinutes * 60;
  const flowBlocks: FlowBlock[] = [];
  let cursor = 0;

  while (cursor < segments.length) {
    const baseSegment = segments[cursor];
    const baseTaskKey = flowGroupKey(baseSegment, config, affinity);
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

      if (flowGroupKey(nextSegment, config, affinity) === baseTaskKey) {
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

      if (!isTolerableInterruption(segments, scan, baseTaskKey, shortInterruptionMaxSec, config, affinity)) {
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
  interruptionIndex: number,
  taskKey: string,
  shortInterruptionMaxSec: number,
  config: Config,
  affinity: Map<string, string>
): boolean {
  const interruption = segments[interruptionIndex];
  const nextSameTask = segments[interruptionIndex + 1];
  if (
    !nextSameTask ||
    interruption.durationSec > shortInterruptionMaxSec ||
    flowGroupKey(nextSameTask, config, affinity) !== taskKey
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

import { defaultConfig } from './defaults.js';
import type { Config, TaskSegment } from './types.js';

const MAX_INFERRED_HEARTBEAT_MS = 120_000;
const WEB_OVER_WINDOW_THRESHOLD = 0.5;
const CROSS_WEB_DEDUP_THRESHOLD = 0.8;
const ADJACENT_MERGE_GAP_MS = 60_000;

export interface NormalizationEvent {
  bucketId: string;
  bucketType: string;
  timestamp: string;
  duration: number;
  data: Record<string, unknown>;
  id?: number;
  day?: string;
}

export interface NormalizationInput {
  windowEvents?: NormalizationEvent[];
  webEvents?: NormalizationEvent[];
  afkEvents?: NormalizationEvent[];
  events?: NormalizationEvent[];
}

interface IntervalEvent extends NormalizationEvent {
  startMs: number;
  endMs: number;
}

interface DraftSegment {
  startMs: number;
  endMs: number;
  app: string;
  title: string;
  domain?: string;
  url?: string;
  taskKey: string;
  source: 'web' | 'window';
  bucketId: string;
  normalizedDomain?: string;
  normalizedTitle: string;
  internalBrowser?: string;
}

interface ActiveInterval {
  startMs: number;
  endMs: number;
}

export function normalizeEvents(input: NormalizationInput | NormalizationEvent[], config: Config = defaultConfig): TaskSegment[] {
  const events = splitInput(input);
  const windowIntervals = expandHeartbeats(events.windowEvents);
  const webIntervals = deduplicateWebSegments(expandHeartbeats(events.webEvents).map(event => toWebSegment(event, config)), config);
  const activeIntervals = buildActiveIntervals(events.afkEvents);

  const activeWindows = windowIntervals.flatMap(event =>
    intersectDraftWithActiveIntervals(toWindowSegment(event), activeIntervals)
  );
  const activeWebs = webIntervals.flatMap(segment => intersectDraftWithActiveIntervals(segment, activeIntervals));

  const overlaid = overlayWebOnWindows(activeWindows, activeWebs);
  const nonOverlapping = makeNonOverlapping(overlaid);
  const merged = mergeAdjacentSameTask(nonOverlapping);
  const confidence = calculateConfidence(merged);

  return merged.map(segment => toTaskSegment(segment, confidence));
}

function splitInput(input: NormalizationInput | NormalizationEvent[]): Required<Pick<NormalizationInput, 'windowEvents' | 'webEvents' | 'afkEvents'>> {
  if (Array.isArray(input)) {
    return {
      windowEvents: input.filter(event => event.bucketType === 'currentwindow'),
      webEvents: input.filter(event => event.bucketType === 'web.tab.current'),
      afkEvents: input.filter(event => event.bucketType === 'afkstatus')
    };
  }

  const allEvents = input.events ?? [];
  return {
    windowEvents: input.windowEvents ?? allEvents.filter(event => event.bucketType === 'currentwindow'),
    webEvents: input.webEvents ?? allEvents.filter(event => event.bucketType === 'web.tab.current'),
    afkEvents: input.afkEvents ?? allEvents.filter(event => event.bucketType === 'afkstatus')
  };
}

function expandHeartbeats(events: NormalizationEvent[]): IntervalEvent[] {
  const byBucket = new Map<string, NormalizationEvent[]>();
  for (const event of events) {
    const bucketEvents = byBucket.get(event.bucketId) ?? [];
    bucketEvents.push(event);
    byBucket.set(event.bucketId, bucketEvents);
  }

  const expanded: IntervalEvent[] = [];
  for (const bucketEvents of byBucket.values()) {
    const sorted = [...bucketEvents].sort((left, right) => parseTimestamp(left.timestamp) - parseTimestamp(right.timestamp));
    for (let index = 0; index < sorted.length; index += 1) {
      const event = sorted[index];
      const startMs = parseTimestamp(event.timestamp);
      const endMs = inferEndMs(event, sorted[index + 1]);
      if (endMs > startMs) {
        expanded.push({ ...event, startMs, endMs });
      }
    }
  }

  return expanded.sort(compareIntervals);
}

function inferEndMs(event: NormalizationEvent, nextEvent: NormalizationEvent | undefined): number {
  const startMs = parseTimestamp(event.timestamp);
  if (event.duration > 0) {
    return startMs + event.duration * 1000;
  }

  if (!nextEvent) {
    return startMs;
  }

  const nextMs = parseTimestamp(nextEvent.timestamp);
  return Math.min(nextMs, startMs + MAX_INFERRED_HEARTBEAT_MS);
}

function buildActiveIntervals(afkEvents: NormalizationEvent[]): ActiveInterval[] | undefined {
  if (afkEvents.length === 0) {
    return undefined;
  }

  const active = expandHeartbeats(afkEvents)
    .filter(event => getString(event.data.status) === 'not-afk')
    .map(event => ({ startMs: event.startMs, endMs: event.endMs }));

  return mergeIntervals(active);
}

function toWindowSegment(event: IntervalEvent): DraftSegment {
  const app = getString(event.data.app) || '未知应用';
  const title = getString(event.data.title) || app;
  return {
    startMs: event.startMs,
    endMs: event.endMs,
    app,
    title,
    taskKey: `${app}:${title}`,
    source: 'window',
    bucketId: event.bucketId,
    normalizedTitle: normalizeTitle(title)
  };
}

function toWebSegment(event: IntervalEvent, config: Config): DraftSegment {
  const rawUrl = getString(event.data.url);
  const title = getString(event.data.title) || '未命名网页';
  const browser = browserFromEvent(event);
  const internalBrowser = internalBrowserForUrl(rawUrl, browser, config);

  if (internalBrowser) {
    return {
      startMs: event.startMs,
      endMs: event.endMs,
      app: internalBrowser,
      title,
      taskKey: `浏览器内部操作:${internalBrowser}`,
      source: 'web',
      bucketId: event.bucketId,
      normalizedTitle: normalizeTitle(title),
      internalBrowser
    };
  }

  const domain = normalizeDomain(getString(event.data.domain) || domainFromUrl(rawUrl));
  const taskKey = domain ? `${domain}:${title}` : `${browser}:${title}`;
  return {
    startMs: event.startMs,
    endMs: event.endMs,
    app: browser,
    title,
    domain: domain || undefined,
    url: rawUrl || undefined,
    taskKey,
    source: 'web',
    bucketId: event.bucketId,
    normalizedDomain: domain || undefined,
    normalizedTitle: normalizeTitle(title)
  };
}

function internalBrowserForUrl(url: string, browser: string, config: Config): string | undefined {
  const lowerUrl = url.toLowerCase();
  const matchedProtocol = config.internalUrlProtocols.find(protocol => lowerUrl.startsWith(protocol.toLowerCase()));
  if (!matchedProtocol) {
    return undefined;
  }

  const protocolBrowser = matchedProtocol.replace(/:$/, '').trim();
  return protocolBrowser || browser;
}

function browserFromEvent(event: NormalizationEvent): string {
  const webPrefix = 'aw-watcher-web-';
  if (event.bucketId.startsWith(webPrefix)) {
    const afterPrefix = event.bucketId.slice(webPrefix.length);
    const [browser] = afterPrefix.split('_');
    if (browser) {
      return browser;
    }
  }

  return 'browser';
}

function deduplicateWebSegments(segments: DraftSegment[], config: Config): DraftSegment[] {
  const kept: DraftSegment[] = [];

  for (const segment of [...segments].sort(compareDraftSegments)) {
    const duplicateIndex = kept.findIndex(candidate => isDuplicateWebSegment(candidate, segment));
    if (duplicateIndex === -1) {
      kept.push(segment);
      continue;
    }

    const candidate = kept[duplicateIndex];
    if (shouldReplaceWebDuplicate(candidate, segment, config)) {
      kept[duplicateIndex] = segment;
    }
  }

  return kept.sort(compareDraftSegments);
}

function isDuplicateWebSegment(left: DraftSegment, right: DraftSegment): boolean {
  if (!left.normalizedDomain || !right.normalizedDomain) {
    return false;
  }

  if (left.normalizedDomain !== right.normalizedDomain || left.normalizedTitle !== right.normalizedTitle) {
    return false;
  }

  const overlap = overlapMs(left, right);
  const shorter = Math.min(durationMs(left), durationMs(right));
  return shorter > 0 && overlap / shorter >= CROSS_WEB_DEDUP_THRESHOLD;
}

function shouldReplaceWebDuplicate(current: DraftSegment, next: DraftSegment, config: Config): boolean {
  const currentDuration = durationMs(current);
  const nextDuration = durationMs(next);
  if (nextDuration !== currentDuration) {
    return nextDuration > currentDuration;
  }

  return bucketMatchesHost(next.bucketId, config.host) && !bucketMatchesHost(current.bucketId, config.host);
}

function bucketMatchesHost(bucketId: string, host: string): boolean {
  return bucketId.endsWith(`_${host}`) || bucketId.endsWith(host);
}

function intersectDraftWithActiveIntervals(segment: DraftSegment, activeIntervals: ActiveInterval[] | undefined): DraftSegment[] {
  if (!activeIntervals) {
    return [segment];
  }

  return activeIntervals.flatMap(interval => {
    const startMs = Math.max(segment.startMs, interval.startMs);
    const endMs = Math.min(segment.endMs, interval.endMs);
    if (endMs <= startMs) {
      return [];
    }

    return [{ ...segment, startMs, endMs }];
  });
}

function overlayWebOnWindows(windows: DraftSegment[], webs: DraftSegment[]): DraftSegment[] {
  const chosen: DraftSegment[] = [];
  const usedWebs = new Set<number>();

  for (const windowSegment of windows.sort(compareDraftSegments)) {
    const winningWebs = webs
      .map((web, index) => ({ web, index, overlap: overlapMs(windowSegment, web) }))
      .filter(item => durationMs(windowSegment) > 0 && item.overlap / durationMs(windowSegment) >= WEB_OVER_WINDOW_THRESHOLD)
      .sort((left, right) => compareDraftSegments(left.web, right.web));

    if (winningWebs.length === 0) {
      chosen.push(windowSegment);
      continue;
    }

    for (const item of winningWebs) {
      usedWebs.add(item.index);
      chosen.push(applyWindowContextToWeb(item.web, windowSegment));
    }
  }

  webs.forEach((web, index) => {
    const overlapsAnyWindow = windows.some(windowSegment => overlapMs(windowSegment, web) > 0);
    if (!usedWebs.has(index) && !overlapsAnyWindow) {
      chosen.push(web);
    }
  });

  return chosen.sort(compareDraftSegments);
}

function applyWindowContextToWeb(web: DraftSegment, windowSegment: DraftSegment): DraftSegment {
  if (web.internalBrowser) {
    return web;
  }

  return { ...web, app: windowSegment.app };
}

function makeNonOverlapping(segments: DraftSegment[]): DraftSegment[] {
  const result: DraftSegment[] = [];
  for (const segment of [...segments].sort(compareDraftSegments)) {
    const previous = result[result.length - 1];
    if (!previous || segment.startMs >= previous.endMs) {
      result.push(segment);
      continue;
    }

    if (segment.endMs <= previous.endMs) {
      continue;
    }

    result.push({ ...segment, startMs: previous.endMs });
  }

  return result.filter(segment => segment.endMs > segment.startMs);
}

function mergeAdjacentSameTask(segments: DraftSegment[]): DraftSegment[] {
  const merged: DraftSegment[] = [];

  for (const segment of [...segments].sort(compareDraftSegments)) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.taskKey === segment.taskKey &&
      segment.startMs >= previous.endMs &&
      segment.startMs - previous.endMs <= ADJACENT_MERGE_GAP_MS
    ) {
      merged[merged.length - 1] = { ...previous, endMs: Math.max(previous.endMs, segment.endMs) };
    } else {
      merged.push(segment);
    }
  }

  return merged;
}

function calculateConfidence(segments: DraftSegment[]): TaskSegment['confidence'] {
  const totalActiveMs = segments.reduce((sum, segment) => sum + durationMs(segment), 0);
  if (totalActiveMs <= 0) {
    return 'low';
  }

  const webKnownMs = segments
    .filter(segment => segment.source === 'web' && (Boolean(segment.url) || Boolean(segment.domain)))
    .reduce((sum, segment) => sum + durationMs(segment), 0);
  const ratio = webKnownMs / totalActiveMs;

  if (ratio >= 0.7) {
    return 'high';
  }

  if (ratio >= 0.3) {
    return 'medium';
  }

  return 'low';
}

function toTaskSegment(segment: DraftSegment, confidence: TaskSegment['confidence']): TaskSegment {
  const durationSec = (segment.endMs - segment.startMs) / 1000;
  return {
    start: new Date(segment.startMs).toISOString(),
    end: new Date(segment.endMs).toISOString(),
    durationSec,
    app: segment.app,
    title: segment.title,
    domain: segment.domain,
    url: segment.url,
    taskKey: segment.taskKey,
    source: segment.source,
    confidence
  };
}

function mergeIntervals(intervals: ActiveInterval[]): ActiveInterval[] {
  const merged: ActiveInterval[] = [];
  for (const interval of [...intervals].sort(compareIntervals)) {
    const previous = merged[merged.length - 1];
    if (previous && interval.startMs <= previous.endMs) {
      merged[merged.length - 1] = { ...previous, endMs: Math.max(previous.endMs, interval.endMs) };
    } else {
      merged.push(interval);
    }
  }

  return merged;
}

function parseTimestamp(timestamp: string): number {
  return Date.parse(timestamp);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function domainFromUrl(url: string): string {
  if (!url) {
    return '';
  }

  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

function durationMs(interval: ActiveInterval): number {
  return interval.endMs - interval.startMs;
}

function overlapMs(left: ActiveInterval, right: ActiveInterval): number {
  return Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
}

function compareIntervals(left: ActiveInterval, right: ActiveInterval): number {
  return left.startMs - right.startMs || left.endMs - right.endMs;
}

function compareDraftSegments(left: DraftSegment, right: DraftSegment): number {
  return compareIntervals(left, right) || (right.source === 'web' ? 1 : 0) - (left.source === 'web' ? 1 : 0);
}

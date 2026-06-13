import type { AWBucket, AWEvent, Config } from '../shared/types.js';

export type ActivityWatchBucketGroup = 'currentwindow' | 'web.tab.current' | 'afkstatus';

export interface BucketMetadata {
  id: string;
  type: string;
  client: string;
  hostname: string;
  created: string;
}

export type BucketGroups = Record<ActivityWatchBucketGroup, BucketMetadata[]> & {
  other: BucketMetadata[];
};

export interface BucketEvents {
  bucket: BucketMetadata;
  events: AWEvent[];
}

export interface DayEventsResponse {
  date: string;
  range: {
    start: string;
    end: string;
  };
  events: Record<ActivityWatchBucketGroup, BucketEvents[]>;
  warnings: string[];
}

export class ActivityWatchError extends Error {
  constructor(message: string, public readonly status = 503) {
    super(message);
    this.name = 'ActivityWatchError';
  }
}

const relevantTypes: ActivityWatchBucketGroup[] = ['currentwindow', 'web.tab.current', 'afkstatus'];

function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ActivityWatchError('ActivityWatch 地址格式无效，请检查配置');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ActivityWatchError('ActivityWatch 地址只支持 http 或 https');
  }
  if (parsed.username || parsed.password) {
    throw new ActivityWatchError('ActivityWatch 地址不能包含用户名或密码');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function buildAwUrl(baseUrl: string, path: string, params?: Record<string, string>): string {
  const safeBase = normalizeBaseUrl(baseUrl);
  const url = new URL(`${safeBase}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchJson<T>(baseUrl: string, path: string, params?: Record<string, string>): Promise<T> {
  const url = buildAwUrl(baseUrl, path, params);
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ActivityWatchError('无法连接 ActivityWatch，请确认服务已启动');
  }

  if (!response.ok) {
    throw new ActivityWatchError(`ActivityWatch 返回异常状态：${response.status}`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ActivityWatchError('ActivityWatch 返回的 JSON 无法解析');
  }
}

function toMetadata(id: string, bucket: Partial<AWBucket>): BucketMetadata {
  return {
    id,
    type: typeof bucket.type === 'string' ? bucket.type : 'unknown',
    client: typeof bucket.client === 'string' ? bucket.client : 'unknown',
    hostname: typeof bucket.hostname === 'string' ? bucket.hostname : 'unknown',
    created: typeof bucket.created === 'string' ? bucket.created : ''
  };
}

export function groupBuckets(buckets: BucketMetadata[]): BucketGroups {
  const groups: BucketGroups = {
    currentwindow: [],
    'web.tab.current': [],
    afkstatus: [],
    other: []
  };

  for (const bucket of buckets) {
    if (relevantTypes.includes(bucket.type as ActivityWatchBucketGroup)) {
      groups[bucket.type as ActivityWatchBucketGroup].push(bucket);
    } else {
      groups.other.push(bucket);
    }
  }

  return groups;
}

export async function checkActivityWatch(config: Config): Promise<{ url: string; status: 'ok' }> {
  await fetchJson<unknown>(config.activityWatchBaseUrl, 'info');
  return { url: normalizeBaseUrl(config.activityWatchBaseUrl), status: 'ok' };
}

export async function discoverBuckets(config: Config): Promise<BucketMetadata[]> {
  const rawBuckets = await fetchJson<Record<string, Partial<AWBucket>>>(config.activityWatchBaseUrl, 'buckets');
  return Object.entries(rawBuckets).map(([id, bucket]) => toMetadata(id, bucket));
}

export function localDayRange(date: string): { start: string; end: string } {
  const [year, month, day] = date.split('-').map(Number);
  const startDate = new Date(year, month - 1, day, 0, 0, 0, 0);
  const endDate = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString()
  };
}

export async function fetchEventsForDate(config: Config, date: string): Promise<DayEventsResponse> {
  const buckets = await discoverBuckets(config);
  const groups = groupBuckets(buckets);
  const range = localDayRange(date);
  const warnings: string[] = [];
  const events: Record<ActivityWatchBucketGroup, BucketEvents[]> = {
    currentwindow: [],
    'web.tab.current': [],
    afkstatus: []
  };

  for (const type of relevantTypes) {
    if (groups[type].length === 0) {
      warnings.push(`未发现 ${type} 类型的 ActivityWatch bucket`);
      continue;
    }

    for (const bucket of groups[type]) {
      const bucketEvents = await fetchJson<AWEvent[]>(
        config.activityWatchBaseUrl,
        `buckets/${encodeURIComponent(bucket.id)}/events`,
        range
      );
      events[type].push({ bucket, events: bucketEvents });
    }
  }

  return { date, range, events, warnings };
}

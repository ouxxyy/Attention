/**
 * 前端 API 调用模块 — 专注力仪表盘
 * 调用后端 /api/health, /api/summary, /api/trends, /api/config, /api/ratings 接口
 */

// ===== 前端局部类型（镜像后端响应结构） =====

export interface HealthResponse {
  ok: boolean;
  activityWatch: {
    status: string;
    url: string;
  };
  buckets: string[];
  warnings: string[];
}

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

export interface DataSufficiency {
  status: 'ok' | 'sparse' | 'missing';
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
  source: 'web' | 'window';
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
  source: 'web' | 'window';
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
  dataStatus: 'ok' | 'sparse' | 'missing';
  dataSufficiency: DataSufficiency;
  metrics: MetricsSummary;
  flowBlocks: FlowBlock[];
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  topTasks: TaskDuration[];
  switchTimeline: SwitchTimelineEntry[];
  unclassifiedActivityCandidates: TaskDuration[];
}

export interface TrendDayEntry {
  date: string;
  dataStatus: 'ok' | 'sparse' | 'missing';
  dataSufficiency: DataSufficiency;
  metrics: MetricsSummary;
  confidence: 'high' | 'medium' | 'low';
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

// ===== Config types =====

export interface KeywordRule {
  label: string;
  patterns: string[];
  match: 'substring';
  priority: number;
}

export interface NotificationConfig {
  enabled: boolean;
  cooldownMinutes: number;
}

export interface ConfigResponse {
  host: string;
  activityWatchBaseUrl: string;
  thresholds: {
    flowMinMinutes: number;
    shortSwitchMaxMinutes: number;
    frequentSwitchWindowMinutes: number;
    frequentSwitchCount: number;
    afkGraceMinutes: number;
  };
  mainTaskKeywords: KeywordRule[];
  sharedKeywords: string[];
  notifications: NotificationConfig;
  internalUrlProtocols: string[];
}

// ===== Rating types =====

export interface DailyRating {
  score: number;
  note?: string;
  updatedAt: string;
}

export interface RatingsResponse {
  ratings: Record<string, DailyRating>;
}

// ===== API 调用函数 =====

const API_BASE = '/api';

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function putJSON<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return fetchJSON<HealthResponse>(`${API_BASE}/health`);
}

export async function fetchSummary(date: string): Promise<DailySummaryResponse> {
  return fetchJSON<DailySummaryResponse>(`${API_BASE}/summary?date=${encodeURIComponent(date)}`);
}

export async function fetchTrends(days: number, end: string): Promise<TrendsResponse> {
  return fetchJSON<TrendsResponse>(`${API_BASE}/trends?days=${days}&end=${encodeURIComponent(end)}`);
}

export async function fetchConfig(): Promise<ConfigResponse> {
  return fetchJSON<ConfigResponse>(`${API_BASE}/config`);
}

export async function putConfig(config: ConfigResponse): Promise<ConfigResponse> {
  return putJSON<ConfigResponse>(`${API_BASE}/config`, config);
}

export async function fetchRatings(): Promise<RatingsResponse> {
  return fetchJSON<RatingsResponse>(`${API_BASE}/ratings`);
}

export async function putRating(date: string, rating: { score: number; note?: string }): Promise<{ date: string; rating: DailyRating }> {
  return putJSON<{ date: string; rating: DailyRating }>(`${API_BASE}/ratings/${encodeURIComponent(date)}`, rating);
}

// ===== 工具函数 =====

export function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '0 分钟';
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) {
    return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  }
  return `${minutes} 分钟`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '--:--';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function toLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function confidenceLabel(c: 'high' | 'medium' | 'low'): string {
  switch (c) {
    case 'high': return '高';
    case 'medium': return '中';
    case 'low': return '低';
  }
}

export function dataStatusLabel(s: 'ok' | 'sparse' | 'missing'): string {
  switch (s) {
    case 'ok': return '正常';
    case 'sparse': return '数据稀疏';
    case 'missing': return '无数据';
  }
}

export function wasteLevel(score: number): { label: string; color: string } {
  if (score <= 20) return { label: '优秀', color: '#34c759' };
  if (score <= 45) return { label: '良好', color: '#30d158' };
  if (score <= 65) return { label: '一般', color: '#ff9f0a' };
  if (score <= 80) return { label: '较差', color: '#ff6723' };
  return { label: '严重', color: '#ff3b30' };
}

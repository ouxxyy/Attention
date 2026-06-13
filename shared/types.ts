// ===== ActivityWatch types =====

export interface AWBucket {
  id: string;
  type: string;
  client: string;
  hostname: string;
  created: string;
  data?: Record<string, unknown>;
}

export interface AWEvent {
  timestamp: string;
  duration: number;
  data: Record<string, unknown>;
  id?: number;
}

// ===== Normalized segment =====

export interface TaskSegment {
  start: string;
  end: string;
  durationSec: number;
  app: string;
  title: string;
  domain?: string;
  url?: string;
  taskKey: string;
  source: 'web' | 'window';
  confidence: 'high' | 'medium' | 'low';
}

// ===== Config types =====

export interface KeywordRule {
  label: string;
  patterns: string[];
  match: 'substring';
  priority: number;
}

export interface Thresholds {
  flowMinMinutes: number;
  shortSwitchMaxMinutes: number;
  frequentSwitchWindowMinutes: number;
  frequentSwitchCount: number;
  afkGraceMinutes: number;
}

export interface NotificationConfig {
  enabled: boolean;
  cooldownMinutes: number;
}

export interface Config {
  host: string;
  activityWatchBaseUrl: string;
  thresholds: Thresholds;
  mainTaskKeywords: KeywordRule[];
  notifications: NotificationConfig;
  internalUrlProtocols: string[];
}

// ===== Rating types =====

export interface DailyRating {
  score: number;
  note?: string;
  updatedAt: string;
}

export interface RatingsFile {
  ratings: Record<string, DailyRating>;
}

// ===== API response types =====

export interface HealthResponse {
  ok: boolean;
  activityWatch: {
    status: string;
    url: string;
  };
  buckets: string[];
  warnings: string[];
}

// ===== Validation result =====

export interface ValidationResult<T = unknown> {
  valid: boolean;
  data?: T;
  errors: string[];
}

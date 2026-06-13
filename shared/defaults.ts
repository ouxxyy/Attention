import type { Config, RatingsFile } from './types.js';

export const defaultConfig: Config = {
  host: 'localhost',
  activityWatchBaseUrl: 'http://localhost:5600/api/0',
  thresholds: {
    flowMinMinutes: 25,
    shortSwitchMaxMinutes: 2,
    frequentSwitchWindowMinutes: 15,
    frequentSwitchCount: 6,
    afkGraceMinutes: 3
  },
  mainTaskKeywords: [
    { label: '写作', patterns: ['写作', '文档', '公众号'], match: 'substring', priority: 100 },
    { label: '编码', patterns: ['代码', 'IDE', 'VS Code', 'cursor', 'Codex', 'opencode', 'GitHub'], match: 'substring', priority: 90 },
    { label: '阅读', patterns: ['阅读', '看书', '文章'], match: 'substring', priority: 80 }
  ],
  sharedKeywords: [],
  notifications: {
    enabled: false,
    cooldownMinutes: 15
  },
  internalUrlProtocols: ['chrome:', 'about:', 'edge:', 'brave:', 'devtools:']
};

export const emptyRatings: RatingsFile = {
  ratings: {}
};

export const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

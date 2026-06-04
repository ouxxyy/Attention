import type { UserSettings } from "../types";

// 默认设置
export const DEFAULT_SETTINGS: UserSettings = {
  dailyBudget: 480, // 8小时
  switchCost: 23, // 每次23分钟
  distractionWebsites: [
    "twitter.com",
    "x.com",
    "reddit.com",
    "youtube.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "weibo.com",
    "douyin.com",
    "bilibili.com",
  ],
  interventionEnabled: true,
  interventionMode: "all",
  focusTimeStart: "09:00",
  focusTimeEnd: "12:00",
  warningThreshold: 20,
  workDays: [1, 2, 3, 4, 5], // 周一到周五
};

// 预算重置时间（凌晨 4:00）
export const BUDGET_RESET_HOUR = 4;

// 专注会话最小时长（分钟）
export const MIN_FOCUS_SESSION_DURATION = 25;

// 存储键
export const STORAGE_KEYS = {
  SETTINGS: "attention_settings",
  CURRENT_SESSION: "attention_current_session",
  DAILY_STATS: "attention_daily_stats",
  TAB_SWITCHES: "attention_tab_switches",
} as const;

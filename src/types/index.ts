// 用户设置
export interface UserSettings {
  dailyBudget: number; // 每日注意力预算（分钟），默认 480
  switchCost: number; // 每次切换成本（分钟），默认 23
  distractionWebsites: string[]; // 分心网站列表
  interventionEnabled: boolean; // 是否启用干预弹窗
  interventionMode: "all" | "focus-time-only"; // 干预模式
  focusTimeStart?: string; // 专注时段开始，如 "09:00"
  focusTimeEnd?: string; // 专注时段结束，如 "12:00"
  warningThreshold: number; // 预算警告阈值（百分比），默认 20
  workDays: number[]; // 工作日，0-6，0 是周日
}

// 注意力记录
export interface AttentionRecord {
  id: string;
  timestamp: number;
  tabId: number;
  url: string;
  domain: string;
  title: string;
  duration: number; // 停留时长（秒）
  isDistraction: boolean; // 是否为分心网站
}

// 标签页切换记录
export interface TabSwitchRecord {
  id: string;
  timestamp: number;
  fromTabId: number;
  toTabId: number;
  fromUrl: string;
  toUrl: string;
  fromDomain: string;
  toDomain: string;
  cost: number; // 注意力成本（分钟）
}

// 每日统计
export interface DailyStats {
  date: string; // YYYY-MM-DD
  totalBudget: number;
  usedBudget: number;
  remainingBudget: number;
  switchCount: number;
  focusSessions: number; // 专注会话数（连续 >= 25 分钟）
  topWebsites: { domain: string; duration: number; count: number }[];
  hourlyData: { hour: number; switches: number; focusTime: number }[];
}

// 注意力分数
export interface AttentionScore {
  score: number; // 0-100
  level: "excellent" | "good" | "fair" | "poor" | "critical";
  trend: "improving" | "stable" | "declining";
}

// 干预状态
export interface InterventionState {
  isActive: boolean;
  targetUrl: string;
  targetDomain: string;
  showPopup: boolean;
  rememberChoice: boolean;
  rememberUntil: number; // 时间戳
}

// 消息类型
export type MessageType =
  | "GET_CURRENT_STATE"
  | "GET_DAILY_STATS"
  | "UPDATE_SETTINGS"
  | "TAB_SWITCHED"
  | "SHOW_INTERVENTION"
  | "DISMISS_INTERVENTION"
  | "GET_ATTENTION_SCORE";

export interface Message<T = unknown> {
  type: MessageType;
  payload?: T;
}

export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

import type {
  UserSettings,
  DailyStats,
  AttentionScore,
} from "../types";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  BUDGET_RESET_HOUR,
  MIN_FOCUS_SESSION_DURATION,
} from "../lib/constants";
import {
  extractDomain,
  isInternalPage,
  isNewTabPage,
  getDateString,
  isInFocusTime,
} from "../lib/utils";

// 状态管理
let settings: UserSettings = { ...DEFAULT_SETTINGS };
let currentSession: {
  tabId: number;
  url: string;
  domain: string;
  startTime: number;
} | null = null;
let dailyStats: DailyStats | null = null;

/**
 * 初始化扩展
 */
async function init(): Promise<void> {
  // 加载设置
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (stored[STORAGE_KEYS.SETTINGS]) {
    settings = { ...DEFAULT_SETTINGS, ...stored[STORAGE_KEYS.SETTINGS] };
  } else {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: settings,
    });
  }

  // 加载或创建每日统计
  await loadDailyStats();

  // 设置每日重置闹钟
  setupDailyResetAlarm();

  console.log("[AttentionBudget] 初始化完成", { settings, dailyStats });
}

/**
 * 加载每日统计
 */
async function loadDailyStats(): Promise<void> {
  const today = getDateString();
  const stored = await chrome.storage.local.get(STORAGE_KEYS.DAILY_STATS);

  if (stored[STORAGE_KEYS.DAILY_STATS]) {
    const stats = stored[STORAGE_KEYS.DAILY_STATS] as DailyStats;
    if (stats.date === today) {
      dailyStats = stats;
      return;
    }
  }

  // 创建新的每日统计
  dailyStats = {
    date: today,
    totalBudget: settings.dailyBudget,
    usedBudget: 0,
    remainingBudget: settings.dailyBudget,
    switchCount: 0,
    focusSessions: 0,
    topWebsites: [],
    hourlyData: Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      switches: 0,
      focusTime: 0,
    })),
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.DAILY_STATS]: dailyStats,
  });
}

/**
 * 设置每日重置闹钟
 */
function setupDailyResetAlarm(): void {
  const now = new Date();
  const resetTime = new Date();
  resetTime.setHours(BUDGET_RESET_HOUR, 0, 0, 0);

  if (resetTime <= now) {
    resetTime.setDate(resetTime.getDate() + 1);
  }

  chrome.alarms.create("dailyReset", {
    when: resetTime.getTime(),
    periodInMinutes: 24 * 60,
  });
}

/**
 * 处理每日重置
 */
async function handleDailyReset(): Promise<void> {
  const today = getDateString();

  dailyStats = {
    date: today,
    totalBudget: settings.dailyBudget,
    usedBudget: 0,
    remainingBudget: settings.dailyBudget,
    switchCount: 0,
    focusSessions: 0,
    topWebsites: [],
    hourlyData: Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      switches: 0,
      focusTime: 0,
    })),
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.DAILY_STATS]: dailyStats,
  });

  // 更新图标
  updateBadge();

  console.log("[AttentionBudget] 每日预算已重置");
}

/**
 * 检查是否为分心网站
 */
function isDistractionWebsite(domain: string): boolean {
  return settings.distractionWebsites.some(
    (site) => domain === site || domain.endsWith(`.${site}`),
  );
}

/**
 * 处理标签页切换
 */
async function handleTabSwitch(tabId: number, url: string): Promise<void> {
  const domain = extractDomain(url);

  // 忽略内部页面
  if (isInternalPage(url) || isNewTabPage(url)) {
    return;
  }

  const now = Date.now();

  // 如果有正在进行的会话，计算持续时间并记录
  if (currentSession && currentSession.tabId !== tabId) {
    const duration = Math.floor((now - currentSession.startTime) / 1000);

    // 检查是否为专注会话（>= 25分钟）
    if (duration >= MIN_FOCUS_SESSION_DURATION * 60) {
      dailyStats!.focusSessions++;
    }

    // 更新网站统计
    updateWebsiteStats(currentSession.domain, duration);

    // 计算切换成本
    const isCrossDomain = currentSession.domain !== domain;
    if (isCrossDomain) {
      const cost = settings.switchCost;
      dailyStats!.usedBudget += cost;
      dailyStats!.remainingBudget = Math.max(
        0,
        dailyStats!.totalBudget - dailyStats!.usedBudget,
      );
      dailyStats!.switchCount++;

      // 更新小时数据
      const hour = new Date().getHours();
      dailyStats!.hourlyData[hour].switches++;

      // 检查是否需要显示干预
      if (settings.interventionEnabled && isDistractionWebsite(domain)) {
        const shouldIntervene =
          settings.interventionMode === "all" ||
          (settings.interventionMode === "focus-time-only" &&
            isInFocusTime(settings.focusTimeStart, settings.focusTimeEnd));

        if (shouldIntervene) {
          // 发送消息给 content script 显示干预弹窗
          await showInterventionPopup(domain, cost);
        }
      }
    }

    // 保存统计数据
    await chrome.storage.local.set({
      [STORAGE_KEYS.DAILY_STATS]: dailyStats,
    });
  }

  // 开始新会话
  currentSession = {
    tabId,
    url,
    domain,
    startTime: now,
  };

  // 更新图标
  updateBadge();
}

/**
 * 更新网站统计
 */
function updateWebsiteStats(domain: string, duration: number): void {
  if (!domain || !dailyStats) return;

  const existing = dailyStats.topWebsites.find((w) => w.domain === domain);
  if (existing) {
    existing.duration += duration;
    existing.count++;
  } else {
    dailyStats.topWebsites.push({
      domain,
      duration,
      count: 1,
    });
  }

  // 按 duration 排序，保留前 10
  dailyStats.topWebsites.sort((a, b) => b.duration - a.duration);
  dailyStats.topWebsites = dailyStats.topWebsites.slice(0, 10);
}

/**
 * 显示干预弹窗
 */
async function showInterventionPopup(
  domain: string,
  cost: number,
): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_INTERVENTION",
        payload: {
          domain,
          cost,
          remainingBudget: dailyStats?.remainingBudget,
        },
      });
    }
  } catch (error) {
    console.error("[AttentionBudget] 显示干预弹窗失败:", error);
  }
}

/**
 * 更新扩展图标徽章
 */
function updateBadge(): void {
  if (!dailyStats) return;

  const remaining = dailyStats.remainingBudget;
  const percentage = (remaining / dailyStats.totalBudget) * 100;

  // 设置徽章文字
  const text = Math.round(remaining) > 0 ? `${Math.round(remaining)}` : "0";
  chrome.action.setBadgeText({ text });

  // 根据剩余百分比设置颜色
  let color: string;
  if (percentage > 50) {
    color = "#4CAF50"; // 绿色
  } else if (percentage > 20) {
    color = "#FFC107"; // 黄色
  } else {
    color = "#F44336"; // 红色
  }

  chrome.action.setBadgeBackgroundColor({ color });
}

/**
 * 计算注意力分数
 */
function calculateAttentionScore(): AttentionScore {
  if (!dailyStats) {
    return {
      score: 100,
      level: "excellent",
      trend: "stable",
    };
  }

  // 基于多个因素计算分数
  const budgetUsage = dailyStats.usedBudget / dailyStats.totalBudget;
  const switchPenalty = Math.min(dailyStats.switchCount / 50, 1); // 50次切换视为最大惩罚
  const focusBonus = dailyStats.focusSessions * 5; // 每个专注会话加5分

  let score = 100;
  score -= budgetUsage * 50; // 预算使用最多扣50分
  score -= switchPenalty * 30; // 切换惩罚最多扣30分
  score += focusBonus; // 专注奖励
  score = Math.max(0, Math.min(100, score));

  // 确定等级
  let level: AttentionScore["level"];
  if (score >= 80) level = "excellent";
  else if (score >= 60) level = "good";
  else if (score >= 40) level = "fair";
  else if (score >= 20) level = "poor";
  else level = "critical";

  // 趋势判断（简化版，基于最近一小时）
  const currentHour = new Date().getHours();
  const lastHourData = dailyStats.hourlyData[currentHour - 1] || {
    switches: 0,
  };
  const currentHourData = dailyStats.hourlyData[currentHour];

  const trend: AttentionScore["trend"] =
    currentHourData.switches < lastHourData.switches
      ? "improving"
      : currentHourData.switches > lastHourData.switches
        ? "declining"
        : "stable";

  return { score: Math.round(score), level, trend };
}

/**
 * 消息处理器
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_CURRENT_STATE": {
        sendResponse({
          success: true,
          data: {
            settings,
            dailyStats,
            currentSession,
            attentionScore: calculateAttentionScore(),
          },
        });
        break;
      }

      case "GET_DAILY_STATS": {
        sendResponse({
          success: true,
          data: dailyStats,
        });
        break;
      }

      case "UPDATE_SETTINGS": {
        settings = { ...settings, ...message.payload };
        await chrome.storage.local.set({
          [STORAGE_KEYS.SETTINGS]: settings,
        });
        sendResponse({ success: true });
        break;
      }

      case "DISMISS_INTERVENTION": {
        // 用户选择继续切换或取消
        sendResponse({ success: true });
        break;
      }

      case "GET_ATTENTION_SCORE": {
        sendResponse({
          success: true,
          data: calculateAttentionScore(),
        });
        break;
      }

      default:
        sendResponse({ success: false, error: "Unknown message type" });
    }
  })();

  return true; // 保持消息通道开启
});

/**
 * 标签页激活事件
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      await handleTabSwitch(activeInfo.tabId, tab.url);
    }
  } catch (error) {
    console.error("[AttentionBudget] 标签页激活处理失败:", error);
  }
});

/**
 * 标签页更新事件
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) {
    await handleTabSwitch(tabId, changeInfo.url);
  }
});

/**
 * 闹钟事件
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "dailyReset") {
    await handleDailyReset();
  }
});

/**
 * 扩展安装/更新事件
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[AttentionBudget] 扩展已安装/更新:", details.reason);
  await init();
});

/**
 * 扩展启动
 */
chrome.runtime.onStartup.addListener(async () => {
  console.log("[AttentionBudget] 浏览器启动");
  await init();
});

// 立即初始化
init();

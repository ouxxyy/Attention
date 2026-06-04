import type { AttentionScore, DailyStats } from "../types";

interface CurrentState {
  settings: unknown;
  dailyStats: DailyStats | null;
  currentSession: unknown;
  attentionScore: AttentionScore;
}

// DOM 元素
const scoreProgress =
  document.querySelector<SVGCircleElement>("#scoreProgress");
const scoreNumber = document.getElementById("scoreNumber") as HTMLElement;
const trendBadge = document.getElementById("trendBadge") as HTMLElement;
const remainingBudget = document.getElementById(
  "remainingBudget",
) as HTMLElement;
const budgetBarFill = document.getElementById("budgetBarFill") as HTMLElement;
const switchCount = document.getElementById("switchCount") as HTMLElement;
const focusSessions = document.getElementById("focusSessions") as HTMLElement;
const dashboardBtn = document.getElementById(
  "dashboardBtn",
) as HTMLButtonElement;
const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;

// 圆环参数
const RADIUS = 60;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * 更新分数圆环
 */
function updateScoreRing(score: number, level: AttentionScore["level"]): void {
  if (!scoreProgress) return;
  const offset = CIRCUMFERENCE - (score / 100) * CIRCUMFERENCE;
  scoreProgress.style.strokeDasharray = `${CIRCUMFERENCE}`;
  scoreProgress.style.strokeDashoffset = `${offset}`;
  scoreProgress.className.baseVal = `progress ${level}`;
  scoreNumber.textContent = `${score}`;
}

/**
 * 更新趋势徽章
 */
function updateTrendBadge(trend: AttentionScore["trend"]): void {
  const labels = {
    improving: "↑ 改善中",
    stable: "→ 稳定",
    declining: "↓ 下降",
  };
  trendBadge.textContent = labels[trend];
  trendBadge.className = `trend-badge ${trend}`;
}

/**
 * 更新预算显示
 */
function updateBudget(stats: DailyStats): void {
  const remaining = Math.round(stats.remainingBudget);
  const percentage = (stats.remainingBudget / stats.totalBudget) * 100;

  remainingBudget.textContent = `${remaining} 分钟`;
  remainingBudget.className =
    remaining < stats.totalBudget * 0.2
      ? "budget-value warning"
      : "budget-value";

  budgetBarFill.style.width = `${percentage}%`;
  budgetBarFill.className =
    percentage < 20 ? "budget-bar-fill warning" : "budget-bar-fill";
}

/**
 * 更新统计数据
 */
function updateStats(stats: DailyStats): void {
  switchCount.textContent = `${stats.switchCount}`;
  focusSessions.textContent = `${stats.focusSessions}`;
}

/**
 * 加载数据
 */
async function loadData(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_CURRENT_STATE",
    });

    if (response.success) {
      const { dailyStats, attentionScore } = response.data as CurrentState;

      if (attentionScore) {
        updateScoreRing(attentionScore.score, attentionScore.level);
        updateTrendBadge(attentionScore.trend);
      }

      if (dailyStats) {
        updateBudget(dailyStats);
        updateStats(dailyStats);
      }
    }
  } catch (error) {
    console.error("加载数据失败:", error);
  }
}

/**
 * 打开仪表盘
 */
function openDashboard(): void {
  chrome.tabs.create({
    url: chrome.runtime.getURL("dashboard/dashboard.html"),
  });
}

/**
 * 打开设置
 */
function openSettings(): void {
  chrome.runtime.openOptionsPage();
}

// 初始化
document.addEventListener("DOMContentLoaded", () => {
  loadData();

  // 设置事件监听
  dashboardBtn.addEventListener("click", openDashboard);
  settingsBtn.addEventListener("click", openSettings);

  // 每秒更新一次
  setInterval(loadData, 1000);
});

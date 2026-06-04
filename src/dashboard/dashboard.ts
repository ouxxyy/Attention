import type { DailyStats, AttentionScore } from "../types";

interface CurrentState {
  settings: unknown;
  dailyStats: DailyStats | null;
  currentSession: unknown;
  attentionScore: AttentionScore;
}

// DOM 元素
const scoreValue = document.getElementById("scoreValue") as HTMLElement;
const scoreChange = document.getElementById("scoreChange") as HTMLElement;
const budgetValue = document.getElementById("budgetValue") as HTMLElement;
const budgetPercent = document.getElementById("budgetPercent") as HTMLElement;
const switchValue = document.getElementById("switchValue") as HTMLElement;
const switchChange = document.getElementById("switchChange") as HTMLElement;
const focusValue = document.getElementById("focusValue") as HTMLElement;
const focusChange = document.getElementById("focusChange") as HTMLElement;
const hourlyChart = document.getElementById("hourlyChart") as HTMLElement;
const websiteList = document.getElementById("websiteList") as HTMLElement;
const focusSessionsEl = document.getElementById("focusSessions") as HTMLElement;
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;

/**
 * 格式化时间
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours}小时${remainingMinutes}分钟`
    : `${hours}小时`;
}

/**
 * 渲染小时图表
 */
function renderHourlyChart(stats: DailyStats): void {
  const currentHour = new Date().getHours();
  const maxSwitches = Math.max(...stats.hourlyData.map((h) => h.switches), 1);

  hourlyChart.innerHTML = stats.hourlyData
    .filter((h) => h.hour <= currentHour)
    .map((h) => {
      const height = (h.switches / maxSwitches) * 200;
      return `
        <div class="chart-bar" style="height: ${Math.max(height, 4)}px">
          <span class="chart-bar-label">${h.hour}:00</span>
        </div>
      `;
    })
    .join("");
}

/**
 * 渲染网站列表
 */
function renderWebsiteList(stats: DailyStats): void {
  if (stats.topWebsites.length === 0) {
    websiteList.innerHTML = '<div class="empty-state">暂无数据</div>';
    return;
  }

  const maxDuration = stats.topWebsites[0]?.duration || 1;

  websiteList.innerHTML = stats.topWebsites
    .slice(0, 5)
    .map((site, index) => {
      const percentage = (site.duration / maxDuration) * 100;
      return `
        <div class="website-item">
          <div class="rank">${index + 1}</div>
          <div class="domain">${site.domain}</div>
          <div class="duration">${formatDuration(site.duration)}</div>
          <div class="bar">
            <div class="bar-fill" style="width: ${percentage}%"></div>
          </div>
        </div>
      `;
    })
    .join("");
}

/**
 * 渲染专注会话
 */
function renderFocusSessions(stats: DailyStats): void {
  if (stats.focusSessions === 0) {
    focusSessionsEl.innerHTML =
      '<div class="empty-state">暂无专注会话记录</div>';
    return;
  }

  // 模拟专注会话数据（实际应从存储中获取）
  const sessions = [];
  for (let i = 0; i < stats.focusSessions; i++) {
    sessions.push({
      time: `${9 + i * 2}:00`,
      duration: 25 + Math.floor(Math.random() * 35),
    });
  }

  focusSessionsEl.innerHTML = sessions
    .map(
      (session) => `
      <div class="session-item">
        <div class="session-time">${session.time}</div>
        <div class="session-duration">${session.duration} 分钟</div>
        <span class="session-badge">专注完成</span>
      </div>
    `,
    )
    .join("");
}

/**
 * 更新显示
 */
function updateDisplay(data: CurrentState): void {
  const { dailyStats, attentionScore } = data;

  if (attentionScore) {
    scoreValue.textContent = `${attentionScore.score}`;
    scoreChange.textContent =
      attentionScore.trend === "improving"
        ? "↑ 改善中"
        : attentionScore.trend === "declining"
          ? "↓ 下降中"
          : "→ 稳定";
    scoreChange.className = `change ${attentionScore.trend === "improving" ? "positive" : attentionScore.trend === "declining" ? "negative" : ""}`;
  }

  if (dailyStats) {
    budgetValue.textContent = `${Math.round(dailyStats.remainingBudget)} 分钟`;
    const percent = Math.round(
      (dailyStats.remainingBudget / dailyStats.totalBudget) * 100,
    );
    budgetPercent.textContent = `剩余 ${percent}%`;
    budgetPercent.className = `change ${percent > 50 ? "positive" : percent < 20 ? "negative" : ""}`;

    switchValue.textContent = `${dailyStats.switchCount}`;
    switchChange.textContent = "次切换";

    focusValue.textContent = `${dailyStats.focusSessions}`;
    focusChange.textContent = "次专注";

    renderHourlyChart(dailyStats);
    renderWebsiteList(dailyStats);
    renderFocusSessions(dailyStats);
  }
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
      updateDisplay(response.data as CurrentState);
    }
  } catch (error) {
    console.error("加载数据失败:", error);
  }
}

/**
 * 导出数据
 */
function exportData(): void {
  // TODO: 实现数据导出
  alert("数据导出功能即将上线");
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

  exportBtn.addEventListener("click", exportData);
  settingsBtn.addEventListener("click", openSettings);

  // 每分钟更新
  setInterval(loadData, 60000);
});

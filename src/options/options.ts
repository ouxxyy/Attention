import type { UserSettings } from "../types";
import { DEFAULT_SETTINGS } from "../lib/constants";

// DOM 元素
const dailyBudgetInput = document.getElementById(
  "dailyBudget",
) as HTMLInputElement;
const switchCostInput = document.getElementById(
  "switchCost",
) as HTMLInputElement;
const interventionEnabledInput = document.getElementById(
  "interventionEnabled",
) as HTMLInputElement;
const interventionModeSelect = document.getElementById(
  "interventionMode",
) as HTMLSelectElement;
const focusTimeStartInput = document.getElementById(
  "focusTimeStart",
) as HTMLInputElement;
const focusTimeEndInput = document.getElementById(
  "focusTimeEnd",
) as HTMLInputElement;
const websiteListEl = document.getElementById("websiteList") as HTMLElement;
const newWebsiteInput = document.getElementById(
  "newWebsite",
) as HTMLInputElement;
const addWebsiteBtn = document.getElementById(
  "addWebsiteBtn",
) as HTMLButtonElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;

let settings: UserSettings = { ...DEFAULT_SETTINGS };
let distractionWebsites: string[] = [];

/**
 * 加载设置
 */
async function loadSettings(): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: "GET_CURRENT_STATE",
  });

  if (response.success && response.data.settings) {
    settings = response.data.settings;
    distractionWebsites = [...settings.distractionWebsites];

    // 更新表单
    dailyBudgetInput.value = `${settings.dailyBudget}`;
    switchCostInput.value = `${settings.switchCost}`;
    interventionEnabledInput.checked = settings.interventionEnabled;
    interventionModeSelect.value = settings.interventionMode;
    focusTimeStartInput.value = settings.focusTimeStart || "09:00";
    focusTimeEndInput.value = settings.focusTimeEnd || "12:00";

    // 渲染网站列表
    renderWebsiteList();
  }
}

/**
 * 渲染分心网站列表
 */
function renderWebsiteList(): void {
  websiteListEl.innerHTML = distractionWebsites
    .map(
      (site) => `
      <span class="website-tag">
        ${site}
        <button data-site="${site}" title="移除">×</button>
      </span>
    `,
    )
    .join("");

  // 绑定删除事件
  websiteListEl.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const site = btn.getAttribute("data-site");
      if (site) {
        distractionWebsites = distractionWebsites.filter((s) => s !== site);
        renderWebsiteList();
      }
    });
  });
}

/**
 * 添加网站
 */
function addWebsite(): void {
  const site = newWebsiteInput.value.trim().toLowerCase();

  if (!site) return;

  // 简单验证域名格式
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) {
    alert("请输入有效的域名格式，如 twitter.com");
    return;
  }

  if (distractionWebsites.includes(site)) {
    alert("该网站已在列表中");
    return;
  }

  distractionWebsites.push(site);
  renderWebsiteList();
  newWebsiteInput.value = "";
}

/**
 * 保存设置
 */
async function saveSettings(): Promise<void> {
  settings = {
    ...settings,
    dailyBudget:
      parseInt(dailyBudgetInput.value, 10) || DEFAULT_SETTINGS.dailyBudget,
    switchCost:
      parseInt(switchCostInput.value, 10) || DEFAULT_SETTINGS.switchCost,
    interventionEnabled: interventionEnabledInput.checked,
    interventionMode:
      interventionModeSelect.value as UserSettings["interventionMode"],
    focusTimeStart: focusTimeStartInput.value,
    focusTimeEnd: focusTimeEndInput.value,
    distractionWebsites,
  };

  const response = await chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    payload: settings,
  });

  if (response.success) {
    saveBtn.textContent = "保存成功 ✓";
    saveBtn.classList.add("success");

    setTimeout(() => {
      saveBtn.textContent = "保存设置";
      saveBtn.classList.remove("success");
    }, 2000);
  }
}

// 初始化
document.addEventListener("DOMContentLoaded", () => {
  loadSettings();

  addWebsiteBtn.addEventListener("click", addWebsite);
  newWebsiteInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") addWebsite();
  });

  saveBtn.addEventListener("click", saveSettings);
});

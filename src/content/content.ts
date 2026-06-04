import type { Message } from "../types";

interface InterventionPayload {
  domain: string;
  cost: number;
  remainingBudget: number;
}

let interventionOverlay: HTMLElement | null = null;

/**
 * 创建干预弹窗
 */
function createInterventionPopup(payload: InterventionPayload): HTMLElement {
  const overlay = document.createElement("div");
  overlay.id = "attention-intervention-overlay";

  overlay.innerHTML = `
    <div id="attention-intervention-popup">
      <div class="intervention-header">
        <div class="intervention-icon">⚠️</div>
        <div class="intervention-title">注意力预警</div>
        <div class="intervention-subtitle">你即将访问分心网站</div>
      </div>

      <div class="intervention-content">
        <div class="intervention-stats">
          <div class="intervention-stat">
            <div class="value">${payload.cost}</div>
            <div class="label">消耗注意力 (分钟)</div>
          </div>
          <div class="intervention-stat">
            <div class="value">${Math.round(payload.remainingBudget)}</div>
            <div class="label">今日剩余 (分钟)</div>
          </div>
        </div>
      </div>

      <div class="intervention-message">
        <p>这次切换将消耗 ${payload.cost} 分钟注意力预算</p>
      </div>

      <div class="intervention-actions">
        <button class="intervention-btn intervention-btn-primary" id="stayFocusedBtn">
          坚持当前任务
        </button>
        <button class="intervention-btn intervention-btn-secondary" id="switchAnywayBtn">
          仍然切换
        </button>
      </div>

      <div class="intervention-remember">
        <input type="checkbox" id="rememberChoice" />
        <label for="rememberChoice">10分钟内不再提醒</label>
      </div>
    </div>
  `;

  // 事件绑定
  const stayFocusedBtn = overlay.querySelector("#stayFocusedBtn");
  const switchAnywayBtn = overlay.querySelector("#switchAnywayBtn");
  const rememberChoice = overlay.querySelector(
    "#rememberChoice",
  ) as HTMLInputElement;

  stayFocusedBtn?.addEventListener("click", () => {
    dismissIntervention(false, rememberChoice?.checked);
  });

  switchAnywayBtn?.addEventListener("click", () => {
    dismissIntervention(true, rememberChoice?.checked);
  });

  // 点击背景关闭
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      dismissIntervention(false, false);
    }
  });

  // ESC 键关闭
  document.addEventListener("keydown", handleEscapeKey);

  return overlay;
}

/**
 * 处理 ESC 键
 */
function handleEscapeKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && interventionOverlay) {
    dismissIntervention(false, false);
  }
}

/**
 * 显示干预弹窗
 */
function showIntervention(payload: InterventionPayload): void {
  if (interventionOverlay) {
    return; // 已有弹窗显示
  }

  interventionOverlay = createInterventionPopup(payload);
  document.body.appendChild(interventionOverlay);
}

/**
 * 关闭干预弹窗
 */
function dismissIntervention(
  allowSwitch: boolean,
  rememberChoice: boolean,
): void {
  if (interventionOverlay) {
    interventionOverlay.remove();
    interventionOverlay = null;
  }

  document.removeEventListener("keydown", handleEscapeKey);

  // 通知后台
  const message: Message = {
    type: "DISMISS_INTERVENTION",
    payload: { allowSwitch, rememberChoice },
  };
  chrome.runtime.sendMessage(message);
}

/**
 * 消息监听
 */
chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    if (message.type === "SHOW_INTERVENTION") {
      showIntervention(message.payload as InterventionPayload);
      sendResponse({ success: true });
    }
    return true;
  },
);

console.log("[AttentionBudget] Content script 已加载");

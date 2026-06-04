/**
 * 提取 URL 的域名
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace("www.", "");
  } catch {
    return "";
  }
}

/**
 * 检查是否为浏览器内部页面
 */
export function isInternalPage(url: string): boolean {
  const internalPrefixes = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "about:",
    "file://",
    "chrome-search://",
  ];
  return internalPrefixes.some((prefix) => url.startsWith(prefix));
}

/**
 * 检查是否为空白/新标签页
 */
export function isNewTabPage(url: string): boolean {
  return (
    url === "chrome://newtab/" ||
    url === "edge://newtab/" ||
    url.includes("chrome://newtab") ||
    url.includes("edge://newtab")
  );
}

/**
 * 生成唯一 ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 格式化分钟数为可读字符串
 */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${Math.round(minutes)}分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`;
}

/**
 * 获取当前日期字符串 (YYYY-MM-DD)
 */
export function getDateString(date: Date = new Date()): string {
  return date.toISOString().split("T")[0];
}

/**
 * 检查当前时间是否在专注时段内
 */
export function isInFocusTime(start?: string, end?: string): boolean {
  if (!start || !end) return false;

  const now = new Date();
  const [startHour, startMin] = start.split(":").map(Number);
  const [endHour, endMin] = end.split(":").map(Number);

  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}

/**
 * 检查今天是否为工作日
 */
export function isWorkday(workDays: number[]): boolean {
  const today = new Date().getDay();
  return workDays.includes(today);
}

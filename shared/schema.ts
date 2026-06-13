import type { Config, DailyRating, RatingsFile, ValidationResult } from './types.js';
import { dateRegex } from './defaults.js';

/**
 * Validate Config object.
 * Returns { valid: true, data } or { valid: false, errors[] }.
 */
export function validateConfig(input: unknown): ValidationResult<Config> {
  const errors: string[] = [];

  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['配置必须是 JSON 对象'] };
  }

  const obj = input as Record<string, unknown>;

  // host
  if (typeof obj.host !== 'string' || obj.host.length === 0) {
    errors.push('host 必须是非空字符串');
  }

  // activityWatchBaseUrl
  if (typeof obj.activityWatchBaseUrl !== 'string') {
    errors.push('activityWatchBaseUrl 必须是字符串');
  }

  // thresholds
  if (!obj.thresholds || typeof obj.thresholds !== 'object') {
    errors.push('thresholds 必须是对象');
  } else {
    const t = obj.thresholds as Record<string, unknown>;
    const thresholdFields: Record<string, string> = {
      flowMinMinutes: '正整数',
      shortSwitchMaxMinutes: '正数',
      frequentSwitchWindowMinutes: '正整数',
      frequentSwitchCount: '正整数',
      afkGraceMinutes: '正整数'
    };
    for (const [field, desc] of Object.entries(thresholdFields)) {
      if (typeof t[field] !== 'number' || t[field] <= 0) {
        errors.push(`thresholds.${field} 必须是${desc}`);
      }
    }
  }

  // mainTaskKeywords
  if (!Array.isArray(obj.mainTaskKeywords)) {
    errors.push('mainTaskKeywords 必须是数组');
  } else {
    for (let i = 0; i < obj.mainTaskKeywords.length; i++) {
      const kw = obj.mainTaskKeywords[i];
      if (!kw || typeof kw !== 'object') {
        errors.push(`mainTaskKeywords[${i}] 必须是对象`);
        continue;
      }
      const kwObj = kw as Record<string, unknown>;
      if (typeof kwObj.label !== 'string' || kwObj.label.length === 0) {
        errors.push(`mainTaskKeywords[${i}].label 必须是非空字符串`);
      }
      if (!Array.isArray(kwObj.patterns) || kwObj.patterns.length === 0) {
        errors.push(`mainTaskKeywords[${i}].patterns 必须是非空数组`);
      }
      if (kwObj.match !== 'substring') {
        errors.push(`mainTaskKeywords[${i}].match 必须是 "substring"`);
      }
      if (typeof kwObj.priority !== 'number') {
        errors.push(`mainTaskKeywords[${i}].priority 必须是数字`);
      }
    }
  }

  // notifications
  if (!obj.notifications || typeof obj.notifications !== 'object') {
    errors.push('notifications 必须是对象');
  } else {
    const n = obj.notifications as Record<string, unknown>;
    if (typeof n.enabled !== 'boolean') {
      errors.push('notifications.enabled 必须是布尔值');
    }
    if (typeof n.cooldownMinutes !== 'number' || n.cooldownMinutes < 0) {
      errors.push('notifications.cooldownMinutes 必须是非负整数');
    }
  }

  // internalUrlProtocols
  if (!Array.isArray(obj.internalUrlProtocols)) {
    errors.push('internalUrlProtocols 必须是数组');
  } else {
    for (let i = 0; i < obj.internalUrlProtocols.length; i++) {
      if (typeof obj.internalUrlProtocols[i] !== 'string') {
        errors.push(`internalUrlProtocols[${i}] 必须是字符串`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: obj as unknown as Config, errors: [] };
}

/**
 * Validate a single DailyRating object.
 */
export function validateRating(input: unknown): ValidationResult<DailyRating> {
  const errors: string[] = [];

  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['评分必须是 JSON 对象'] };
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.score !== 'number' || !Number.isInteger(obj.score)) {
    errors.push('score 必须是整数');
  } else if (obj.score < 1 || obj.score > 5) {
    errors.push('score 必须在 1-5 之间');
  }

  if (obj.note !== undefined) {
    if (typeof obj.note !== 'string') {
      errors.push('note 必须是字符串');
    } else if (obj.note.length > 500) {
      errors.push('note 不能超过 500 个字符');
    }
  }

  if (typeof obj.updatedAt !== 'string') {
    errors.push('updatedAt 必须是 ISO 字符串');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: obj as unknown as DailyRating, errors: [] };
}

/**
 * Validate a full RatingsFile object.
 */
export function validateRatingsFile(input: unknown): ValidationResult<RatingsFile> {
  const errors: string[] = [];

  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['评分文件必须是 JSON 对象'] };
  }

  const obj = input as Record<string, unknown>;

  if (!obj.ratings || typeof obj.ratings !== 'object') {
    return { valid: false, errors: ['ratings 必须是对象'] };
  }

  const entries = obj.ratings as Record<string, unknown>;

  for (const [dateKey, val] of Object.entries(entries)) {
    if (!dateRegex.test(dateKey)) {
      errors.push(`日期键 "${dateKey}" 格式无效，应为 YYYY-MM-DD`);
    }
    const ratingResult = validateRating(val);
    if (!ratingResult.valid) {
      errors.push(...ratingResult.errors.map(e => `ratings["${dateKey}"]: ${e}`));
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: obj as unknown as RatingsFile, errors: [] };
}

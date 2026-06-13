import { Router } from 'express';
import { dateRegex } from '../shared/defaults.js';
import type { HealthResponse } from '../shared/types.js';
import {
  ActivityWatchError,
  checkActivityWatch,
  discoverBuckets,
  fetchEventsForDate,
  groupBuckets
} from './activitywatch.js';
import {
  readConfig,
  readRatings,
  StorageReadError,
  StorageValidationError,
  writeConfig,
  writeRating
} from './storage.js';
import { buildDailySummary, buildTrendsResponse, dateRangeEnding, todayLocalDate } from './summary.js';

interface ApiErrorBody {
  error: string;
  details?: string[];
}

function sendError(res: import('express').Response, status: number, error: string, details?: string[]): void {
  const body: ApiErrorBody = { error };
  if (details && details.length > 0) {
    body.details = details;
  }
  res.status(status).json(body);
}

function isValidDateParam(date: unknown): date is string {
  if (typeof date !== 'string' || !dateRegex.test(date)) {
    return false;
  }
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function readSingleQueryParam(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

function parseDaysParam(days: unknown): number | undefined {
  if (days === undefined) {
    return 7;
  }
  if (typeof days !== 'string' || !/^\d+$/.test(days)) {
    return undefined;
  }
  const parsed = Number(days);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function handleRouteError(res: import('express').Response, error: unknown): void {
  if (error instanceof StorageValidationError) {
    sendError(res, 400, '数据校验失败', error.errors);
    return;
  }
  if (error instanceof StorageReadError) {
    sendError(res, 500, error.message);
    return;
  }
  if (error instanceof ActivityWatchError) {
    sendError(res, error.status, error.message);
    return;
  }
  sendError(res, 500, '服务器内部错误');
}

export function createRouter(): Router {
  const router = Router();

  router.get('/api/health', async (_req, res) => {
    let activityWatchUrl = '配置中的 ActivityWatch 地址';
    try {
      const config = await readConfig();
      activityWatchUrl = config.activityWatchBaseUrl;
      const [activityWatch, buckets] = await Promise.all([
        checkActivityWatch(config),
        discoverBuckets(config)
      ]);
      const relevantBucketIds = buckets
        .filter(bucket => ['currentwindow', 'web.tab.current', 'afkstatus'].includes(bucket.type))
        .map(bucket => bucket.id);
      const warnings = relevantBucketIds.length === 0 ? ['未发现可用的 ActivityWatch 行为数据 bucket'] : [];
      const response: HealthResponse = {
        ok: true,
        activityWatch,
        buckets: relevantBucketIds,
        warnings
      };
      res.json(response);
    } catch (error) {
      if (error instanceof ActivityWatchError) {
        const response: HealthResponse = {
          ok: false,
          activityWatch: {
            status: 'unavailable',
            url: activityWatchUrl
          },
          buckets: [],
          warnings: [error.message]
        };
        res.status(503).json(response);
        return;
      }
      handleRouteError(res, error);
    }
  });

  router.get('/api/buckets', async (_req, res) => {
    try {
      const config = await readConfig();
      const buckets = await discoverBuckets(config);
      res.json({ buckets: groupBuckets(buckets) });
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.get('/api/events', async (req, res) => {
    const date = req.query.date;
    if (!isValidDateParam(date)) {
      sendError(res, 400, 'date 必须是有效日期，格式为 YYYY-MM-DD');
      return;
    }

    try {
      const config = await readConfig();
      const response = await fetchEventsForDate(config, date);
      res.json(response);
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.get('/api/summary', async (req, res) => {
    const date = req.query.date;
    if (!isValidDateParam(date)) {
      sendError(res, 400, 'date 必须是有效日期，格式为 YYYY-MM-DD');
      return;
    }

    try {
      const config = await readConfig();
      const dayEvents = await fetchEventsForDate(config, date);
      res.json(buildDailySummary(dayEvents, config));
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.get('/api/trends', async (req, res) => {
    const days = parseDaysParam(req.query.days);
    if (days === undefined) {
      sendError(res, 400, 'days 必须是正整数');
      return;
    }

    const end = readSingleQueryParam(req.query.end) ?? todayLocalDate();
    if (!isValidDateParam(end)) {
      sendError(res, 400, 'end 必须是有效日期，格式为 YYYY-MM-DD');
      return;
    }

    try {
      const config = await readConfig();
      const summaries = [];
      for (const date of dateRangeEnding(end, days)) {
        const dayEvents = await fetchEventsForDate(config, date);
        summaries.push(buildDailySummary(dayEvents, config));
      }
      res.json(buildTrendsResponse(days, end, summaries));
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.get('/api/config', async (_req, res) => {
    try {
      res.json(await readConfig());
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.put('/api/config', async (req, res) => {
    try {
      res.json(await writeConfig(req.body));
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.get('/api/ratings', async (_req, res) => {
    try {
      res.json(await readRatings());
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  router.put('/api/ratings/:date', async (req, res) => {
    const { date } = req.params;
    if (!isValidDateParam(date)) {
      sendError(res, 400, '日期必须是有效日期，格式为 YYYY-MM-DD');
      return;
    }

    try {
      const rating = await writeRating(date, req.body);
      res.json({ date, rating });
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  return router;
}

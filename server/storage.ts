import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig, emptyRatings } from '../shared/defaults.js';
import { validateConfig, validateRating, validateRatingsFile } from '../shared/schema.js';
import type { Config, DailyRating, RatingsFile } from '../shared/types.js';

export class StorageValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('；'));
    this.name = 'StorageValidationError';
  }
}

export class StorageReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageReadError';
  }
}

/**
 * 规范化配置：将 mainTaskKeywords 中含中文逗号/顿号的 pattern 拆分为多个独立 pattern，
 * 防止用户用中文逗号输入关键词时被合并成一个无法匹配的长字符串。
 * 去重、去空白、去空串。
 */
function normalizeConfig(config: Config): Config {
  return {
    ...config,
    mainTaskKeywords: config.mainTaskKeywords.map(rule => ({
      ...rule,
      patterns: [...new Set(
        rule.patterns
          .flatMap(pattern => pattern.split(/[,，、]/))
          .map(s => s.trim())
          .filter(Boolean)
      )]
    }))
  };
}

const dataDir = path.join(process.cwd(), 'data');
const configPath = path.join(dataDir, 'config.json');
const ratingsPath = path.join(dataDir, 'ratings.json');

async function ensureDataDir(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
}

async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<unknown> {
  await ensureDataDir();
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await writeJsonFile(filePath, defaultValue);
      return defaultValue;
    }
    if (error instanceof SyntaxError) {
      throw new StorageReadError(`数据文件 ${path.basename(filePath)} 不是有效 JSON`);
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readConfig(): Promise<Config> {
  const raw = await readJsonFile(configPath, defaultConfig);
  const result = validateConfig(raw);
  if (!result.valid || !result.data) {
    throw new StorageValidationError(result.errors);
  }
  return normalizeConfig(result.data);
}

export async function writeConfig(input: unknown): Promise<Config> {
  const result = validateConfig(input);
  if (!result.valid || !result.data) {
    throw new StorageValidationError(result.errors);
  }
  const normalized = normalizeConfig(result.data);
  await writeJsonFile(configPath, normalized);
  return normalized;
}

export async function readRatings(): Promise<RatingsFile> {
  const raw = await readJsonFile(ratingsPath, emptyRatings);
  const result = validateRatingsFile(raw);
  if (!result.valid || !result.data) {
    throw new StorageValidationError(result.errors);
  }
  return result.data;
}

export async function writeRatings(input: unknown): Promise<RatingsFile> {
  const result = validateRatingsFile(input);
  if (!result.valid || !result.data) {
    throw new StorageValidationError(result.errors);
  }
  await writeJsonFile(ratingsPath, result.data);
  return result.data;
}

export async function writeRating(date: string, input: unknown): Promise<DailyRating> {
  if (!input || typeof input !== 'object') {
    throw new StorageValidationError(['评分必须是 JSON 对象']);
  }

  const body = input as Record<string, unknown>;
  const ratingInput: DailyRating = {
    score: body.score as number,
    updatedAt: new Date().toISOString()
  };
  if (body.note !== undefined) {
    ratingInput.note = body.note as string;
  }

  const ratingResult = validateRating(ratingInput);
  if (!ratingResult.valid || !ratingResult.data) {
    throw new StorageValidationError(ratingResult.errors);
  }

  const ratingsFile = await readRatings();
  const nextRatings: RatingsFile = {
    ratings: {
      ...ratingsFile.ratings,
      [date]: ratingResult.data
    }
  };
  await writeRatings(nextRatings);
  return ratingResult.data;
}

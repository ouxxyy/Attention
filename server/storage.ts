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

function normalizeKeywordList(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .flatMap(value => value.split(/[,，、]/))
        .map(value => value.trim())
        .filter(Boolean)
    )
  ];
}

function collectDuplicatedPatterns(mainTaskKeywords: Config['mainTaskKeywords']): string[] {
  const counts = new Map<string, number>();

  for (const rule of mainTaskKeywords) {
    for (const pattern of normalizeKeywordList(rule.patterns)) {
      const lower = pattern.toLowerCase();
      counts.set(lower, (counts.get(lower) ?? 0) + 1);
    }
  }

  const duplicated = new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([pattern]) => pattern)
  );

  if (duplicated.size === 0) {
    return [];
  }

  const ordered: string[] = [];
  for (const rule of mainTaskKeywords) {
    for (const pattern of normalizeKeywordList(rule.patterns)) {
      if (duplicated.has(pattern.toLowerCase()) && !ordered.some(item => item.toLowerCase() === pattern.toLowerCase())) {
        ordered.push(pattern);
      }
    }
  }

  return ordered;
}

/**
 * 规范化配置：
 * 1. 将关键词中含中文逗号/顿号的内容拆分为多个独立词；
 * 2. 将重复出现在多条规则中的词自动收敛到 sharedKeywords；
 * 3. 规则本身只保留“真正决定归属”的专属词，避免共享工具词把不同主要工作硬判成切换。
 */
function normalizeConfig(config: Config): Config {
  const normalizedRules = config.mainTaskKeywords.map(rule => ({
    ...rule,
    patterns: normalizeKeywordList(rule.patterns)
  }));
  const sharedKeywords = normalizeKeywordList([
    ...(config.sharedKeywords ?? []),
    ...collectDuplicatedPatterns(normalizedRules)
  ]);
  const sharedKeywordSet = new Set(sharedKeywords.map(pattern => pattern.toLowerCase()));

  return {
    ...config,
    mainTaskKeywords: normalizedRules.map(rule => ({
      ...rule,
      patterns: rule.patterns.filter(pattern => !sharedKeywordSet.has(pattern.toLowerCase()))
    })),
    sharedKeywords
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

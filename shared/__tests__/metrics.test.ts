import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../defaults';
import { analysisTaskKey, computeMetrics } from '../metrics';
import type { Config, TaskSegment } from '../types';

const baseTime = Date.parse('2026-05-31T00:00:00.000Z');

function iso(offsetSec: number, baseMs = baseTime): string {
  return new Date(baseMs + offsetSec * 1000).toISOString();
}

function segment(offsetSec: number, durationSec: number, taskKey: string, overrides: Partial<TaskSegment> = {}): TaskSegment {
  return {
    start: iso(offsetSec),
    end: iso(offsetSec + durationSec),
    durationSec,
    app: 'App',
    title: taskKey,
    taskKey,
    source: 'window',
    confidence: 'low',
    ...overrides
  };
}

function segmentAt(baseMs: number, offsetSec: number, durationSec: number, taskKey: string): TaskSegment {
  return {
    start: iso(offsetSec, baseMs),
    end: iso(offsetSec + durationSec, baseMs),
    durationSec,
    app: 'App',
    title: taskKey,
    taskKey,
    source: 'window',
    confidence: 'low'
  };
}

function configWithKeywords(mainTaskKeywords: Config['mainTaskKeywords']): Config {
  return { ...defaultConfig, mainTaskKeywords };
}

function expectFiniteNumbers(value: unknown): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      expectFiniteNumbers(item);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      expectFiniteNumbers(item);
    }
  }
}

describe('computeMetrics', () => {
  it('detects one flow block and low energy waste for focused work with one short interruption', () => {
    const result = computeMetrics(
      [
        segment(0, 900, '写作:Task 4 plan'),
        segment(900, 90, 'Slack:quick reply'),
        segment(990, 900, '写作:Task 4 plan')
      ],
      configWithKeywords([{ label: '写作', patterns: ['写作'], match: 'substring', priority: 100 }])
    );

    expect(result.metrics.activeTimeSec).toBe(1890);
    expect(result.metrics.switchCount).toBe(2);
    expect(result.metrics.rawSwitchCount).toBe(2);
    expect(result.metrics.meaningfulSwitchCount).toBe(2);
    expect(result.metrics.shortStayCount).toBe(1);
    expect(result.metrics.shortStayTimeSec).toBe(90);
    expect(result.metrics.frequentWindows).toBe(0);
    expect(result.metrics.mainTaskTimeSec).toBe(1800);
    expect(result.metrics.energyWasteScore).toBeLessThan(40);
    expect(result.flowBlocks).toHaveLength(1);
    expect(result.flowBlocks[0]).toMatchObject({
      taskKey: '主任务:写作',
      activeDurationSec: 1800,
      toleratedInterruptions: 1
    });
  });

  it('groups different apps into one focus block when they match the same main-task rule', () => {
    const result = computeMetrics(
      [
        segment(0, 900, 'Terminal:opencode ~/project'),
        segment(900, 900, 'Codex:project review')
      ],
      configWithKeywords([{ label: '编码', patterns: ['opencode', 'Codex'], match: 'substring', priority: 100 }])
    );

    expect(result.metrics.rawSwitchCount).toBe(1);
    expect(result.metrics.meaningfulSwitchCount).toBe(0);
    expect(result.metrics.mainTaskTimeSec).toBe(1800);
    expect(result.flowBlocks).toHaveLength(1);
    expect(result.flowBlocks[0]).toMatchObject({
      taskKey: '主任务:编码',
      activeDurationSec: 1800,
      segmentCount: 2
    });
  });

  it('counts greedy frequent switching windows and produces elevated energy waste for rapid switching', () => {
    const segments = Array.from({ length: 8 }, (_, index) => segment(index * 60, 60, `Task:${index % 2}`));

    const result = computeMetrics(segments, configWithKeywords([]));

    expect(result.metrics.switchCount).toBe(7);
    expect(result.metrics.meaningfulSwitchCount).toBe(7);
    expect(result.metrics.frequentWindows).toBeGreaterThanOrEqual(1);
    expect(result.metrics.componentScores.frequentSwitchScore).toBe(39);
    expect(result.metrics.shortStayCount).toBe(8);
    expect(result.metrics.componentScores.shortStayScore).toBe(100);
    expect(result.metrics.energyWasteScore).toBeGreaterThanOrEqual(40);
  });

  it('returns finite zero metrics and no crash for a zero-event day', () => {
    const result = computeMetrics([], defaultConfig);

    expect(result.metrics).toMatchObject({
      activeTimeSec: 0,
      switchCount: 0,
      rawSwitchCount: 0,
      meaningfulSwitchCount: 0,
      shortStayCount: 0,
      shortStayTimeSec: 0,
      frequentWindows: 0,
      mainTaskTimeSec: 0,
      deviationRatio: 0,
      recoveryCostMin: 0,
      energyWasteScore: 0,
      scoringVersion: 'v2',
      scoringNotes: []
    });
    expect(result.flowBlocks).toEqual([]);
    expectFiniteNumbers(result);
  });

  it('does not count a switch for a single-event day', () => {
    const result = computeMetrics([segment(0, 600, 'Code:metrics.ts')], defaultConfig);

    expect(result.metrics.switchCount).toBe(0);
    expect(result.metrics.activeTimeSec).toBe(600);
  });

  it('counts all short stays and scores them by segment count', () => {
    const result = computeMetrics(
      [segment(0, 30, 'Task:A'), segment(30, 120, 'Task:B'), segment(150, 90, 'Task:C')],
      defaultConfig
    );

    expect(result.metrics.shortStayCount).toBe(3);
    expect(result.metrics.shortStayTimeSec).toBe(240);
    expect(result.metrics.componentScores.shortStayScore).toBe(100);
  });

  it('does not let sub-15-second jitter dominate meaningful switch scoring', () => {
    const result = computeMetrics(
      [
        segment(0, 600, 'Task:A'),
        segment(600, 5, 'Task:Jitter'),
        segment(605, 600, 'Task:A')
      ],
      configWithKeywords([{ label: 'A', patterns: ['Task:A'], match: 'substring', priority: 100 }])
    );

    expect(result.metrics.rawSwitchCount).toBe(2);
    expect(result.metrics.meaningfulSwitchCount).toBe(0);
    expect(result.metrics.componentScores.frequentSwitchScore).toBe(0);
    expect(result.metrics.energyWasteScore).toBeLessThan(20);
  });

  it('scores short stays by time share instead of segment count', () => {
    const result = computeMetrics(
      [
        segment(0, 600, 'Focus:long'),
        segment(600, 60, 'Chat:short'),
        segment(660, 600, 'Focus:long')
      ],
      configWithKeywords([{ label: 'Focus', patterns: ['Focus'], match: 'substring', priority: 100 }])
    );

    expect(result.metrics.shortStayCount).toBe(1);
    expect(result.metrics.shortStayTimeSec).toBe(60);
    expect(result.metrics.componentScores.shortStayScore).toBeCloseTo(4.76, 1);
  });

  it('does not apply deviation score when no main-task keyword matches', () => {
    const result = computeMetrics([segment(0, 600, 'Unknown:work')], configWithKeywords([]));

    expect(result.metrics.deviationRatio).toBe(1);
    expect(result.metrics.componentScores.deviationScore).toBe(0);
    expect(result.metrics.scoringNotes).toContain('还没认出今天主要在忙什么，所以“不在主要事情里的时间”先不扣分。请在底部添加你的主要事情。');
  });

  it('uses the highest-priority main task keyword match when multiple rules match one segment', () => {
    const result = computeMetrics(
      [segment(0, 600, 'VS Code:docs code metrics')],
      configWithKeywords([
        { label: '编码', patterns: ['code'], match: 'substring', priority: 10 },
        { label: '文档', patterns: ['docs'], match: 'substring', priority: 100 }
      ])
    );

    expect(result.metrics.mainTaskTimeSec).toBe(600);
    expect(result.metrics.primaryMainTaskLabel).toBe('文档');
  });

  it('matches browser internal pages by title even when taskKey hides the tab title', () => {
    const browserInternalSegment = segment(0, 600, '浏览器内部操作:chrome', {
      app: 'chrome',
      title: 'New Tab',
      source: 'web'
    });
    const config = configWithKeywords([{ label: '编程', patterns: ['New Tab'], match: 'substring', priority: 100 }]);

    expect(analysisTaskKey(browserInternalSegment, config)).toBe('主任务:编程');

    const result = computeMetrics([browserInternalSegment], config);
    expect(result.metrics.mainTaskTimeSec).toBe(600);
    expect(result.metrics.primaryMainTaskLabel).toBe('编程');
  });

  it('keeps one flow block when same-task segments are separated by a gap within afkGraceMinutes', () => {
    const result = computeMetrics(
      [segment(0, 900, '写作:deep work'), segment(1020, 900, '写作:deep work')],
      configWithKeywords([{ label: '写作', patterns: ['写作'], match: 'substring', priority: 100 }])
    );

    expect(result.metrics.activeTimeSec).toBe(1800);
    expect(result.flowBlocks).toHaveLength(1);
    expect(result.flowBlocks[0]).toMatchObject({
      taskKey: '主任务:写作',
      activeDurationSec: 1800,
      toleratedInterruptions: 1,
      segmentCount: 2
    });
  });

  it('counts switches across a midnight timestamp boundary when the gap is within five minutes', () => {
    const midnightBase = Date.parse('2026-05-31T23:59:00.000Z');
    const result = computeMetrics(
      [segmentAt(midnightBase, 0, 90, 'Task:before midnight'), segmentAt(midnightBase, 90, 120, 'Task:after midnight')],
      defaultConfig
    );

    expect(result.metrics.switchCount).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../defaults';
import { normalizeEvents, type NormalizationEvent } from '../normalize';

const baseTime = Date.parse('2026-05-31T00:00:00.000Z');

function iso(offsetSec: number): string {
  return new Date(baseTime + offsetSec * 1000).toISOString();
}

function windowEvent(offsetSec: number, duration: number, app: string, title: string): NormalizationEvent {
  return {
    bucketId: 'aw-watcher-window_example-host.local',
    bucketType: 'currentwindow',
    timestamp: iso(offsetSec),
    duration,
    data: { app, title }
  };
}

function webEvent(
  offsetSec: number,
  duration: number,
  url: string,
  title: string,
  bucketId = 'aw-watcher-web-chrome_example-host.local',
  domain?: string
): NormalizationEvent {
  return {
    bucketId,
    bucketType: 'web.tab.current',
    timestamp: iso(offsetSec),
    duration,
    data: { url, domain, title }
  };
}

function afkEvent(offsetSec: number, duration: number, status: 'afk' | 'not-afk'): NormalizationEvent {
  return {
    bucketId: 'aw-watcher-afk_example-host.local',
    bucketType: 'afkstatus',
    timestamp: iso(offsetSec),
    duration,
    data: { status }
  };
}

describe('normalizeEvents', () => {
  it('uses web segment when it overlaps at least 50% of a window segment', () => {
    const segments = normalizeEvents(
      {
        windowEvents: [windowEvent(0, 100, 'Google Chrome', 'Docs - Chrome')],
        webEvents: [webEvent(10, 60, 'https://docs.google.com/document/1', 'Project plan')],
        afkEvents: [afkEvent(0, 200, 'not-afk')]
      },
      defaultConfig
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      start: iso(10),
      end: iso(70),
      source: 'web',
      app: 'Google Chrome',
      title: 'Project plan',
      domain: 'docs.google.com',
      url: 'https://docs.google.com/document/1',
      taskKey: 'docs.google.com:Project plan',
      confidence: 'high'
    });
  });

  it('infers zero-duration heartbeat end from next same-bucket event and caps distant next events at 120 seconds', () => {
    const segments = normalizeEvents(
      {
        windowEvents: [
          windowEvent(0, 0, 'Terminal', 'Claude Code'),
          windowEvent(90, 0, 'Terminal', 'Claude Code'),
          windowEvent(300, 0, 'Terminal', 'Claude Code'),
          windowEvent(500, 10, 'Terminal', 'Claude Code')
        ],
        webEvents: [],
        afkEvents: [afkEvent(0, 700, 'not-afk')]
      },
      defaultConfig
    );

    expect(segments.map(segment => [segment.start, segment.end, segment.durationSec])).toEqual([
      [iso(0), iso(210), 210],
      [iso(300), iso(420), 120],
      [iso(500), iso(510), 10]
    ]);
  });

  it('classifies internal browser URLs as browser internal operations', () => {
    const segments = normalizeEvents(
      {
        windowEvents: [windowEvent(0, 60, 'Google Chrome', 'Extensions')],
        webEvents: [webEvent(0, 60, 'chrome://extensions', 'Extensions')],
        afkEvents: [afkEvent(0, 100, 'not-afk')]
      },
      defaultConfig
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      source: 'web',
      app: 'chrome',
      title: 'Extensions',
      taskKey: '浏览器内部操作:chrome',
      confidence: 'low'
    });
    expect(segments[0].url).toBeUndefined();
    expect(segments[0].domain).toBeUndefined();
  });

  it('splits active segments around AFK periods longer than 3 minutes', () => {
    const segments = normalizeEvents(
      {
        windowEvents: [windowEvent(0, 600, 'VS Code', 'normalize.ts')],
        webEvents: [],
        afkEvents: [afkEvent(0, 200, 'not-afk'), afkEvent(200, 240, 'afk'), afkEvent(440, 200, 'not-afk')]
      },
      defaultConfig
    );

    expect(segments.map(segment => [segment.start, segment.end, segment.durationSec])).toEqual([
      [iso(0), iso(200), 200],
      [iso(440), iso(600), 160]
    ]);
    expect(segments.every(segment => segment.taskKey === 'VS Code:normalize.ts')).toBe(true);
  });

  it('falls back to window task when no usable web URL exists', () => {
    const segments = normalizeEvents(
      {
        windowEvents: [windowEvent(0, 60, 'Cursor', 'focus')],
        webEvents: [webEvent(0, 20, 'https://example.com', 'Too short')],
        afkEvents: [afkEvent(0, 100, 'not-afk')]
      },
      defaultConfig
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      source: 'window',
      app: 'Cursor',
      title: 'focus',
      taskKey: 'Cursor:focus',
      confidence: 'low'
    });
  });

  it('deduplicates cross-web events with same normalized domain and title when overlap is at least 80%', () => {
    const segments = normalizeEvents(
      {
        windowEvents: [windowEvent(0, 100, 'Google Chrome', 'DeepSeek Platform')],
        webEvents: [
          webEvent(0, 100, 'https://platform.deepseek.com/usage', 'DeepSeek Platform'),
          webEvent(
            10,
            80,
            'https://platform.deepseek.com/usage?tab=costs',
            'DeepSeek Platform',
            'aw-watcher-web-chrome_AnotherHost.local'
          )
        ],
        afkEvents: [afkEvent(0, 200, 'not-afk')]
      },
      defaultConfig
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      start: iso(0),
      end: iso(100),
      domain: 'platform.deepseek.com',
      taskKey: 'platform.deepseek.com:DeepSeek Platform'
    });
  });

  it('returns sorted non-overlapping segments', () => {
    const segments = normalizeEvents(
      {
        windowEvents: [windowEvent(80, 40, 'Terminal', 'B'), windowEvent(0, 40, 'Terminal', 'A')],
        webEvents: [],
        afkEvents: [afkEvent(0, 200, 'not-afk')]
      },
      defaultConfig
    );

    expect(segments.map(segment => segment.taskKey)).toEqual(['Terminal:A', 'Terminal:B']);
    expect(Date.parse(segments[0].end)).toBeLessThanOrEqual(Date.parse(segments[1].start));
  });
});

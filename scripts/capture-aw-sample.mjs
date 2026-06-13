import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.ACTIVITYWATCH_BASE_URL ?? 'http://localhost:5600/api/0';
const HOST_CONTEXT = process.env.AW_HOST_CONTEXT ?? os.hostname();
const TARGET_TYPES = new Set(['currentwindow', 'web.tab.current', 'afkstatus']);
const EVENT_LIMIT_PER_BUCKET_DAY = Number(process.env.AW_SAMPLE_LIMIT ?? 200);

const FIXTURE_PATH = path.join('shared', 'fixtures', 'sample-events.json');
const EVIDENCE_DIR = path.join('.omo', 'evidence');
const EVIDENCE_MD_PATH = path.join(EVIDENCE_DIR, 'task-1-buckets.md');
const EVIDENCE_JSON_PATH = path.join(EVIDENCE_DIR, 'task-1-buckets.json');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatRfc3339Local(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
    offset,
  ].join('');
}

function localDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayRange(offsetDays) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays + 1, 0, 0, 0, 0);
  return {
    label: offsetDays === 0 ? 'today' : offsetDays === -1 ? 'yesterday' : `offset-${offsetDays}`,
    date: localDateKey(start),
    start: formatRfc3339Local(start),
    end: formatRfc3339Local(end),
  };
}

function localAt(day, hour, minute, second = 0) {
  const [year, month, date] = day.date.split('-').map(Number);
  return formatRfc3339Local(new Date(year, month - 1, date, hour, minute, second, 0));
}

function addSeconds(timestamp, seconds) {
  return new Date(new Date(timestamp).getTime() + seconds * 1000).toISOString();
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return { text, json: JSON.parse(text) };
}

function bucketEntries(bucketsJson) {
  return Object.entries(bucketsJson).map(([id, bucket]) => ({ id, ...bucket }));
}

function trimString(value, maxLength = 120) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function sanitizeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const pathParts = parsed.pathname.split('/').filter(Boolean).slice(0, 2);
      const safePath = pathParts.length ? `/${pathParts.map(encodeURIComponent).join('/')}` : '';
      return `${parsed.protocol}//${parsed.hostname}${safePath}`;
    }
    return trimString(`${parsed.protocol}${parsed.pathname}`, 160);
  } catch {
    return trimString(value, 160);
  }
}

function domainFromUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.hostname || parsed.protocol.replace(':', '');
  } catch {
    return undefined;
  }
}

function trimData(data, type) {
  if (!data || typeof data !== 'object') return {};
  if (type === 'currentwindow') {
    return {
      app: trimString(data.app, 80),
      title: trimString(data.title, 120),
    };
  }
  if (type === 'web.tab.current') {
    const url = sanitizeUrl(data.url);
    return {
      url,
      domain: domainFromUrl(data.url) ?? domainFromUrl(url),
      title: trimString(data.title ?? data.tabTitle, 120),
    };
  }
  if (type === 'afkstatus') {
    return {
      status: trimString(data.status, 40),
    };
  }
  return {};
}

function sanitizeEvent(event, bucket, day) {
  return {
    bucketId: bucket.id,
    bucketType: bucket.type,
    day: day.date,
    timestamp: event.timestamp,
    duration: Number(event.duration ?? 0),
    data: trimData(event.data, bucket.type),
  };
}

function sortEvents(events) {
  return events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.bucketId).localeCompare(String(b.bucketId)));
}

function coverageFor(events, type) {
  if (type !== 'web.tab.current') return null;
  if (events.length === 0) return 0;
  const withUrl = events.filter((event) => Boolean(event.data?.url)).length;
  return Math.round((withUrl / events.length) * 10000) / 100;
}

function eventInterval(event) {
  const startMs = Date.parse(event.timestamp);
  const durationSec = Number(event.duration ?? 0);
  if (!Number.isFinite(startMs) || !Number.isFinite(durationSec)) return null;
  return {
    startMs,
    endMs: startMs + Math.max(0, durationSec) * 1000,
    domain: event.data?.domain,
    title: event.data?.title,
    bucketId: event.bucketId,
  };
}

function computeWebOverlapNotes(webEvents) {
  const byBucket = new Map();
  for (const event of webEvents) {
    if (!byBucket.has(event.bucketId)) byBucket.set(event.bucketId, []);
    byBucket.get(event.bucketId).push(event);
  }

  const bucketIds = [...byBucket.keys()].sort();
  const notes = [];
  let totalOverlapSec = 0;
  let totalOverlapPairs = 0;
  let sameDomainTitlePairs = 0;

  for (let i = 0; i < bucketIds.length; i += 1) {
    for (let j = i + 1; j < bucketIds.length; j += 1) {
      const left = byBucket.get(bucketIds[i]).map(eventInterval).filter(Boolean);
      const right = byBucket.get(bucketIds[j]).map(eventInterval).filter(Boolean);
      let pairOverlapSec = 0;
      let pairOverlapCount = 0;
      let pairSameDomainTitle = 0;

      for (const a of left) {
        for (const b of right) {
          const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
          if (overlapMs <= 0) continue;
          pairOverlapCount += 1;
          pairOverlapSec += overlapMs / 1000;
          if (a.domain && b.domain && a.domain === b.domain && a.title && b.title && a.title === b.title) {
            pairSameDomainTitle += 1;
          }
        }
      }

      totalOverlapSec += pairOverlapSec;
      totalOverlapPairs += pairOverlapCount;
      sameDomainTitlePairs += pairSameDomainTitle;
      notes.push({
        buckets: [bucketIds[i], bucketIds[j]],
        overlappingPairs: pairOverlapCount,
        overlapSeconds: Math.round(pairOverlapSec),
        sameDomainTitlePairs: pairSameDomainTitle,
      });
    }
  }

  return {
    comparedBucketPairs: notes.length,
    overlappingPairs: totalOverlapPairs,
    overlapSeconds: Math.round(totalOverlapSec),
    sameDomainTitlePairs,
    notes,
  };
}

function confidenceFromCoverage(webEvents) {
  if (webEvents.length === 0) return 'low';
  const coverage = coverageFor(webEvents, 'web.tab.current') ?? 0;
  if (coverage >= 70) return 'high';
  if (coverage >= 30) return 'medium';
  return 'low';
}

function metadataForBucket(bucket, selected, events = [], fetchErrors = []) {
  const urlCoveragePercent = coverageFor(events, bucket.type);
  const dayCounts = events.reduce((counts, event) => {
    counts[event.day] = (counts[event.day] ?? 0) + 1;
    return counts;
  }, {});
  return {
    id: bucket.id,
    type: bucket.type,
    hostname: bucket.hostname,
    client: bucket.client,
    created: bucket.created,
    lastUpdated: bucket.last_updated ?? bucket.lastUpdated,
    selected,
    sampledEventCount: selected ? events.length : null,
    dayCounts,
    urlCoveragePercent,
    fetchErrors,
  };
}

function targetArrays(eventsByType) {
  return {
    windowEvents: sortEvents(eventsByType.get('currentwindow') ?? []),
    webEvents: sortEvents(eventsByType.get('web.tab.current') ?? []),
    afkEvents: sortEvents(eventsByType.get('afkstatus') ?? []),
  };
}

function fallbackFixture(days, error) {
  const today = days.find((day) => day.label === 'today') ?? days[0];
  const yesterday = days.find((day) => day.label === 'yesterday') ?? days[0];
  const windowEvents = [
    {
      bucketId: 'fallback-currentwindow',
      bucketType: 'currentwindow',
      day: today.date,
      timestamp: localAt(today, 9, 0),
      duration: 1800,
      data: { app: 'Code', title: 'Focus Dashboard' },
    },
    {
      bucketId: 'fallback-currentwindow',
      bucketType: 'currentwindow',
      day: yesterday.date,
      timestamp: localAt(yesterday, 15, 0),
      duration: 900,
      data: { app: 'Browser', title: 'Reference Research' },
    },
  ];
  const webEvents = [
    {
      bucketId: 'fallback-web-tab-current',
      bucketType: 'web.tab.current',
      day: today.date,
      timestamp: localAt(today, 9, 5),
      duration: 600,
      data: { url: 'https://example.invalid/work', domain: 'example.invalid', title: 'Work Reference' },
    },
    {
      bucketId: 'fallback-web-tab-current',
      bucketType: 'web.tab.current',
      day: today.date,
      timestamp: localAt(today, 9, 15),
      duration: 0,
      data: { url: 'https://example.invalid/work', domain: 'example.invalid', title: 'Zero Duration Heartbeat' },
    },
  ];
  const afkEvents = [
    {
      bucketId: 'fallback-afkstatus',
      bucketType: 'afkstatus',
      day: today.date,
      timestamp: localAt(today, 9, 30),
      duration: 300,
      data: { status: 'afk' },
    },
    {
      bucketId: 'fallback-afkstatus',
      bucketType: 'afkstatus',
      day: today.date,
      timestamp: localAt(today, 9, 35),
      duration: 0,
      data: { status: 'not-afk' },
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    source: 'fallback-documented-shapes',
    confidence: 'low',
    activityWatchBaseUrl: BASE_URL,
    hostContext: HOST_CONTEXT,
    days,
    notes: [
      `ActivityWatch unavailable: ${error.message}`,
      'Fallback preserves documented shapes only; do not use for real coverage conclusions.',
      'Includes duration=0 heartbeat examples because ActivityWatch can emit zero-duration events before flood/normalization.',
    ],
    windowEvents,
    webEvents,
    afkEvents,
    bucketMetadata: [
      { id: 'fallback-currentwindow', type: 'currentwindow', selected: true, sampledEventCount: windowEvents.length, urlCoveragePercent: null },
      { id: 'fallback-web-tab-current', type: 'web.tab.current', selected: true, sampledEventCount: webEvents.length, urlCoveragePercent: 100 },
      { id: 'fallback-afkstatus', type: 'afkstatus', selected: true, sampledEventCount: afkEvents.length, urlCoveragePercent: null },
    ],
    webOverlap: computeWebOverlapNotes(webEvents),
  };
}

function markdownTable(rows) {
  if (rows.length === 0) return '_No rows._';
  const headers = Object.keys(rows[0]);
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${headers.map((header) => String(row[header] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderEvidence({ fixture, rawBucketText, unavailableError }) {
  const zeroDurationCount = [...fixture.windowEvents, ...fixture.webEvents, ...fixture.afkEvents].filter((event) => Number(event.duration) === 0).length;
  const rows = fixture.bucketMetadata.map((bucket) => ({
    id: bucket.id,
    type: bucket.type,
    selected: bucket.selected === false ? 'no' : 'yes',
    sampledEventCount: bucket.sampledEventCount ?? 'not sampled',
    urlCoverage: bucket.urlCoveragePercent == null ? 'n/a' : `${bucket.urlCoveragePercent}%`,
    fetchErrors: bucket.fetchErrors?.length ? bucket.fetchErrors.join('; ') : '',
  }));
  const overlapRows = fixture.webOverlap.notes.map((note) => ({
    buckets: note.buckets.join(' ↔ '),
    overlappingPairs: note.overlappingPairs,
    overlapSeconds: note.overlapSeconds,
    sameDomainTitlePairs: note.sameDomainTitlePairs,
  }));

  return `# Task 1 ActivityWatch bucket evidence

- Generated at: ${fixture.generatedAt}
- ActivityWatch base URL: ${fixture.activityWatchBaseUrl}
- Host context: ${fixture.hostContext}
- Source: ${fixture.source}
- Confidence: ${fixture.confidence}
- Day ranges: ${fixture.days.map((day) => `${day.label} ${day.start} → ${day.end}`).join('; ')}
- Discovery rule: selected buckets by \`type\` only (\`currentwindow\`, \`web.tab.current\`, \`afkstatus\`); no hardcoded bucket IDs.
- Privacy rule: fixture keeps timestamp, duration, bucket id/type, and minimal data fields only; URL query strings/fragments are removed and titles are truncated.
- Boundary note: events may overlap query boundaries; downstream normalization must clip intervals to the requested day range.
- Heartbeat note: ${zeroDurationCount} sampled events have \`duration=0\`; downstream flood/normalization must handle zero-duration heartbeat events.

## Bucket summary

${markdownTable(rows)}

## URL coverage and overlap notes

- URL confidence: ${fixture.confidence}
- Web events sampled: ${fixture.webEvents.length}
- Web URL coverage: ${coverageFor(fixture.webEvents, 'web.tab.current') ?? 0}%
- Compared web bucket pairs: ${fixture.webOverlap.comparedBucketPairs}
- Overlapping web event pairs: ${fixture.webOverlap.overlappingPairs}
- Overlap seconds: ${fixture.webOverlap.overlapSeconds}
- Same domain/title overlap pairs: ${fixture.webOverlap.sameDomainTitlePairs}
- Dedup implication: ${fixture.webOverlap.overlappingPairs > 0 ? 'multiple web buckets overlap; Task 3 should deduplicate by overlap + normalized domain/title before metrics.' : 'no overlapping web buckets found in this sample; Task 3 should still keep dedup logic for other days/browsers.'}

${overlapRows.length ? markdownTable(overlapRows) : '_No web bucket overlap rows._'}

## Fixture event counts

- windowEvents: ${fixture.windowEvents.length}
- webEvents: ${fixture.webEvents.length}
- afkEvents: ${fixture.afkEvents.length}
- bucketMetadata: ${fixture.bucketMetadata.length}

## ActivityWatch bucket curl output

${unavailableError ? `Unavailable error: ${unavailableError.message}` : 'Raw output from `GET /api/0/buckets/`:'}

\`\`\`json
${rawBucketText ?? JSON.stringify({ error: unavailableError?.message }, null, 2)}
\`\`\`
`;
}

async function writeOutputs(fixture, rawBucketText, unavailableError) {
  await mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  await writeFile(EVIDENCE_MD_PATH, renderEvidence({ fixture, rawBucketText, unavailableError }));
  await writeFile(EVIDENCE_JSON_PATH, `${rawBucketText ?? JSON.stringify({ error: unavailableError?.message }, null, 2)}\n`);
}

async function main() {
  const days = [dayRange(0), dayRange(-1)];
  let rawBucketText;
  let bucketsJson;

  try {
    const response = await fetchJson(`${BASE_URL}/buckets/`);
    rawBucketText = response.text;
    bucketsJson = response.json;
  } catch (error) {
    const fixture = fallbackFixture(days, error);
    await writeOutputs(fixture, rawBucketText, error);
    console.warn(`ActivityWatch unavailable; wrote low-confidence fallback fixture: ${error.message}`);
    return;
  }

  const allBuckets = bucketEntries(bucketsJson);
  const selectedBuckets = allBuckets.filter((bucket) => TARGET_TYPES.has(bucket.type));
  const eventsByBucket = new Map();
  const fetchErrorsByBucket = new Map();
  const eventsByType = new Map();

  for (const bucket of selectedBuckets) {
    const bucketEvents = [];
    const fetchErrors = [];

    for (const day of days) {
      const url = `${BASE_URL}/buckets/${encodeURIComponent(bucket.id)}/events?start=${encodeURIComponent(day.start)}&end=${encodeURIComponent(day.end)}&limit=${EVENT_LIMIT_PER_BUCKET_DAY}`;
      try {
        const { json: events } = await fetchJson(url);
        const sanitized = Array.isArray(events) ? events.map((event) => sanitizeEvent(event, bucket, day)) : [];
        bucketEvents.push(...sanitized);
      } catch (error) {
        fetchErrors.push(`${day.label}: ${error.message}`);
      }
    }

    eventsByBucket.set(bucket.id, bucketEvents);
    fetchErrorsByBucket.set(bucket.id, fetchErrors);
    if (!eventsByType.has(bucket.type)) eventsByType.set(bucket.type, []);
    eventsByType.get(bucket.type).push(...bucketEvents);
  }

  const arrays = targetArrays(eventsByType);
  const bucketMetadata = allBuckets.map((bucket) => metadataForBucket(
    bucket,
    TARGET_TYPES.has(bucket.type),
    eventsByBucket.get(bucket.id) ?? [],
    fetchErrorsByBucket.get(bucket.id) ?? [],
  ));

  const fixture = {
    generatedAt: new Date().toISOString(),
    source: 'activitywatch-local-api',
    confidence: confidenceFromCoverage(arrays.webEvents),
    activityWatchBaseUrl: BASE_URL,
    hostContext: HOST_CONTEXT,
    days,
    notes: [
      'Bucket discovery filtered by type, not hardcoded IDs.',
      'Sample ranges use timezone-aware RFC3339 local timestamps.',
      'Events may overlap query boundaries; downstream normalization should clip to day range.',
      'duration=0 heartbeat events are preserved in the fixture.',
    ],
    ...arrays,
    bucketMetadata,
    webOverlap: computeWebOverlapNotes(arrays.webEvents),
  };

  await writeOutputs(fixture, rawBucketText, null);
  console.log(`Wrote ${FIXTURE_PATH}`);
  console.log(`Wrote ${EVIDENCE_MD_PATH}`);
  console.log(`Wrote ${EVIDENCE_JSON_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

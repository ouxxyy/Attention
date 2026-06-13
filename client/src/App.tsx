import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchHealth, fetchSummary, fetchTrends,
  fetchConfig, putConfig, fetchRatings, putRating,
  formatDuration, formatTime, toLocalDate,
  confidenceLabel, dataStatusLabel, wasteLevel,
  type HealthResponse, type DailySummaryResponse, type TrendsResponse,
  type ConfigResponse, type KeywordRule, type RatingsResponse, type DailyRating
} from './api';

interface DashboardState {
  health: HealthResponse | null;
  healthError: string | null;
  summary: DailySummaryResponse | null;
  summaryError: string | null;
  trends: TrendsResponse | null;
  trendsError: string | null;
  selectedDate: string;
  loading: boolean;
  config: ConfigResponse | null;
  ratings: RatingsResponse | null;
  lastUpdated: string | null;
}

function App() {
  const [state, setState] = useState<DashboardState>({
    health: null,
    healthError: null,
    summary: null,
    summaryError: null,
    trends: null,
    trendsError: null,
    selectedDate: toLocalDate(new Date()),
    loading: true,
    config: null,
    ratings: null,
    lastUpdated: null,
  });

  const [notifEnabled, setNotifEnabled] = useState(false);
  const notifEnabledRef = useRef(notifEnabled);
  notifEnabledRef.current = notifEnabled;

  const lastNotifTime = useRef(0);
  const configRef = useRef(state.config);
  configRef.current = state.config;
  const loadSeqRef = useRef(0);

  const loadData = useCallback(async (date: string) => {
    const seq = ++loadSeqRef.current;
    setState(prev => ({ ...prev, loading: true, summaryError: null, trendsError: null }));
    try {
      const [summary, trends] = await Promise.all([
        fetchSummary(date),
        fetchTrends(7, date),
      ]);
      if (seq !== loadSeqRef.current) { loadSeqRef.current = 0; return; }
      setState(prev => ({ ...prev, summary, trends, loading: false, lastUpdated: new Date().toISOString() }));
      loadSeqRef.current = 0;
    } catch (err) {
      if (seq !== loadSeqRef.current) { loadSeqRef.current = 0; return; }
      const message = err instanceof Error ? err.message : '未知错误';
      setState(prev => ({ ...prev, summaryError: message, loading: false }));
      loadSeqRef.current = 0;
    }
  }, []);

  useEffect(() => {
    fetchHealth()
      .then(health => setState(prev => ({ ...prev, health, healthError: null })))
      .catch(err => {
        const message = err instanceof Error ? err.message : '无法连接';
        setState(prev => ({ ...prev, healthError: message }));
      });
  }, []);

  useEffect(() => {
    fetchConfig()
      .then(config => {
        setState(prev => ({ ...prev, config }));
        setNotifEnabled(config.notifications.enabled);
      })
      .catch(() => {});
    fetchRatings()
      .then(ratings => setState(prev => ({ ...prev, ratings })))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadData(state.selectedDate);
  }, [state.selectedDate, loadData]);

  const checkAndNotify = useCallback((summary: DailySummaryResponse, config: ConfigResponse) => {
    if (!notifEnabledRef.current) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    const frequentSwitchDetected = summary.metrics.frequentWindows > 0;
    if (!frequentSwitchDetected) return;

    const cooldownMs = config.notifications.cooldownMinutes * 60 * 1000;
    const now = Date.now();
    if (now - lastNotifTime.current < cooldownMs) return;

    lastNotifTime.current = now;
    new Notification('专注力提醒', {
      body: `检测到你频繁换到别的事情（${summary.metrics.frequentWindows} 次），可以看一下是不是被打断了`,
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      // 手动刷新进行中时跳过自动刷新，避免 loadSeqRef 竞态
      // loadData 完成后会将 loadSeqRef 重置为 0
      if (loadSeqRef.current !== 0) return;

      fetchSummary(state.selectedDate)
        .then(summary => {
          setState(prev => ({ ...prev, summary, lastUpdated: new Date().toISOString() }));
          const cfg = configRef.current;
          if (cfg) {
            checkAndNotify(summary, cfg);
          }
        })
        .catch(() => {});
    }, 60_000);

    return () => clearInterval(interval);
  }, [state.selectedDate, checkAndNotify]);

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setState(prev => ({ ...prev, selectedDate: e.target.value }));
  };

  const handleManualRefresh = () => {
    loadData(state.selectedDate);
  };

  const persistNotifConfig = async (enabled: boolean) => {
    if (!state.config) return;
    const prevEnabled = notifEnabled;
    const next: ConfigResponse = {
      ...state.config,
      notifications: { ...state.config.notifications, enabled },
    };
    try {
      const saved = await putConfig(next);
      setState(prev => ({ ...prev, config: saved }));
    } catch {
      setNotifEnabled(prevEnabled);
    }
  };

  const handleToggleNotification = () => {
    if (typeof Notification === 'undefined') return;

    if (Notification.permission === 'granted') {
      const next = !notifEnabled;
      setNotifEnabled(next);
      persistNotifConfig(next);
      return;
    }

    if (Notification.permission === 'denied') return;

    Notification.requestPermission().then(perm => {
      if (perm === 'granted') {
        setNotifEnabled(true);
        persistNotifConfig(true);
      }
    });
  };

  const handleSaveRating = async (score: number, note: string): Promise<boolean> => {
    const body: { score: number; note?: string } = { score };
    if (note.trim()) body.note = note.trim();
    try {
      const result = await putRating(state.selectedDate, body);
      setState(prev => prev.ratings
        ? { ...prev, ratings: { ratings: { ...prev.ratings.ratings, [state.selectedDate]: result.rating } } }
        : prev
      );
      return true;
    } catch {
      return false;
    }
  };

  const handleSaveKeywords = async (keywords: KeywordRule[]): Promise<boolean> => {
    if (!state.config) return false;
    const next: ConfigResponse = { ...state.config, mainTaskKeywords: keywords };
    try {
      const saved = await putConfig(next);
      setState(prev => ({ ...prev, config: saved }));
      // 保存后等待按新规则重新拉取当日汇总，避免 UI 先显示“已保存”但列表仍是旧分类
      await loadData(state.selectedDate);
      return true;
    } catch {
      return false;
    }
  };

  const { health, healthError, summary, summaryError, trends, selectedDate, loading, config, ratings, lastUpdated } = state;
  const awConnected = health?.ok === true;
  const currentRating = ratings?.ratings[selectedDate] ?? null;

  const notifPerm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const notifEffectivelyEnabled = notifEnabled && notifPerm === 'granted';

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>专注力仪表盘</h1>
          <p className="subtitle">看看今天有没有一直被打断、有没有离开主要事情</p>
        </div>
        <div className="header-meta">
          <span>ActivityWatch 实时汇总</span>
          <span>{lastUpdated ? `最后更新 ${formatTime(lastUpdated)}` : '等待首次更新'}</span>
        </div>
      </header>

      <main className="main">
        <section className="control-bar">
          <ConnectionCard health={health} error={healthError} />
          <div className="date-row">
            <label htmlFor="date-select" className="date-label">选择日期</label>
            <input
              id="date-select"
              type="date"
              value={selectedDate}
              onChange={handleDateChange}
              className="date-input"
            />
            <button className="btn btn--ghost btn--small" onClick={handleManualRefresh} disabled={loading}>
              刷新
            </button>
            <span className="poll-indicator">
              <span className="poll-dot" />
              每 60 秒自动刷新当日数据
            </span>
          </div>
        </section>

        {!awConnected && !healthError && (
          <section className="card card--warning">
            <p>正在检查 ActivityWatch 连接状态…</p>
          </section>
        )}

        {awConnected && loading && (
          <section className="card">
            <p className="muted">加载数据中…</p>
          </section>
        )}

        {awConnected && !loading && summaryError && (
          <section className="card card--error">
            <h2>数据加载失败</h2>
            <p>{summaryError}</p>
          </section>
        )}

        {awConnected && !loading && summary && (
          <>
            <section className="dashboard-grid dashboard-grid--hero">
              <EnergyWasteCard summary={summary} />
              <FrequentSwitchCard summary={summary} />
            </section>
            <section className="dashboard-grid">
              <FlowBlocksCard summary={summary} config={config} />
              <TrendsCard trends={trends} selectedDate={selectedDate} ratings={ratings} />
            </section>
            <TopTasksCard tasks={summary.topTasks} />
            <SwitchTimelineCard timeline={summary.switchTimeline} />
            <UnclassifiedCard tasks={summary.unclassifiedActivityCandidates} />
            {summary.warnings.length > 0 && <WarningsCard warnings={summary.warnings} />}
          </>
        )}

        <section className="dashboard-grid dashboard-grid--settings">
          <RatingCard
            rating={currentRating}
            onSave={handleSaveRating}
          />
          <div className="settings-stack">
            <NotificationToggle
              enabled={notifEnabled}
              permission={notifPerm}
              onToggle={handleToggleNotification}
              cooldownMinutes={config?.notifications.cooldownMinutes ?? 15}
              windowMinutes={config?.thresholds.frequentSwitchWindowMinutes ?? 15}
              switchThreshold={config?.thresholds.frequentSwitchCount ?? 6}
            />
            {config && (
              <KeywordConfigEditor
                keywords={config.mainTaskKeywords}
                onSave={handleSaveKeywords}
              />
            )}
          </div>
        </section>
      </main>

      <footer className="footer">
        <p className="muted">专注力仪表盘 · 数据来自 ActivityWatch</p>
      </footer>
    </div>
  );
}

function ConnectionCard({ health, error }: { health: HealthResponse | null; error: string | null }) {
  const connected = health?.ok === true;
  const statusText = error
    ? `连接失败: ${error}`
    : connected
      ? `ActivityWatch 已连接 (${health?.activityWatch.url ?? ''})`
      : health
        ? `ActivityWatch 不可用 — ${health.warnings.join('; ') || '请确认 ActivityWatch 正在运行'}`
        : '检查中…';

  return (
    <div className={`connection-card ${connected ? 'connection-card--success' : error ? 'connection-card--error' : ''}`}>
      <div className="connection-row">
        <span className={`status-dot ${connected ? 'status-dot--on' : 'status-dot--off'}`} />
        <span className="connection-text">{statusText}</span>
      </div>
    </div>
  );
}

function RatingCard({ rating, onSave }: { rating: DailyRating | null; onSave: (score: number, note: string) => Promise<boolean> }) {
  const [score, setScore] = useState(rating?.score ?? 0);
  const [note, setNote] = useState(rating?.note ?? '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setScore(rating?.score ?? 0);
    setNote(rating?.note ?? '');
    setStatus('idle');
  }, [rating]);

  const handleSave = async () => {
    if (score < 1 || score > 5) return;
    setStatus('saving');
    const ok = await onSave(score, note);
    setStatus(ok ? 'saved' : 'error');
    if (ok) {
      setTimeout(() => setStatus(prev => prev === 'saved' ? 'idle' : prev), 2000);
    }
  };

  const statusText = status === 'saving' ? '保存中…'
    : status === 'saved' ? '已保存'
    : status === 'error' ? '保存失败，请重试' : '';

  return (
    <section className="card">
      <h2>今日评分</h2>
      <div className="rating-row">
        <div>
          <div className="rating-stars">
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                className={`rating-star ${n <= score ? 'rating-star--active' : ''}`}
                onClick={() => setScore(n === score ? 0 : n)}
                aria-label={`${n} 分`}
              >
                ★
              </button>
            ))}
          </div>
          <div className="rating-save-row">
            <button
              className="btn btn--primary"
              onClick={handleSave}
              disabled={score < 1 || score > 5 || status === 'saving'}
            >
              保存评分
            </button>
            {statusText && (
              <span className={`rating-status ${status === 'saved' ? 'rating-status--saved' : ''} ${status === 'error' ? 'rating-status--error' : ''}`}>
                {statusText}
              </span>
            )}
          </div>
        </div>
        <div className="rating-note">
          <textarea
            placeholder="备注（可选）"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

function NotificationToggle({ enabled, permission, onToggle, cooldownMinutes, windowMinutes, switchThreshold }: {
  enabled: boolean;
  permission: NotificationPermission | 'unsupported';
  onToggle: () => void;
  cooldownMinutes: number;
  windowMinutes: number;
  switchThreshold: number;
}) {
  const denied = permission === 'denied';
  const unsupported = permission === 'unsupported';

  let statusText = '';
  if (unsupported) {
    statusText = '当前浏览器不支持通知';
  } else if (denied) {
    statusText = '通知权限已被拒绝，请在浏览器设置中允许';
  } else if (enabled && permission === 'granted') {
    statusText = `已开启，冷却时间 ${cooldownMinutes} 分钟`;
  } else if (enabled) {
    statusText = '等待授权…';
  }

  return (
    <section className="card card--compact">
      <div className="notif-row">
        <label className="notif-toggle">
          <input
            type="checkbox"
            checked={enabled && !denied && !unsupported}
            onChange={onToggle}
            disabled={unsupported || denied}
          />
          <span className="notif-toggle-track" />
        </label>
        <span className="notif-label" onClick={onToggle}>频繁被打断提醒</span>
        <InfoTooltip text={`${windowMinutes} 分钟内换到别的事 ${switchThreshold} 次以上时弹出提醒。每次提醒后有 ${cooldownMinutes} 分钟冷却，不会连续弹。`} />
        {statusText && (
          <span className={`notif-status ${denied ? 'notif-status--denied' : ''}`}>
            {statusText}
          </span>
        )}
      </div>
    </section>
  );
}

function KeywordConfigEditor({ keywords, onSave }: {
  keywords: KeywordRule[];
  onSave: (keywords: KeywordRule[]) => Promise<boolean>;
}) {
  const [items, setItems] = useState<KeywordRule[]>(keywords);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setItems(keywords);
  }, [keywords]);

  const updateItem = (index: number, field: 'label' | 'patterns' | 'priority', value: string | number) => {
    setItems(prev => {
      const next = [...prev];
      const item = { ...next[index] };
      if (field === 'label') {
        item.label = value as string;
      } else if (field === 'patterns') {
        item.patterns = (value as string).split(/[,，、]/).map(s => s.trim()).filter(Boolean);
      } else {
        item.priority = value as number;
      }
      next[index] = item;
      return next;
    });
  };

  const addItem = () => {
    const nextPriority = items.length === 0
      ? 100
      : Math.max(...items.map(item => Number.isFinite(item.priority) ? item.priority : 0)) + 10;
    setItems(prev => [
      ...prev,
      { label: '', patterns: [], match: 'substring', priority: nextPriority }
    ]);
  };

  const removeItem = (index: number) => {
    setItems(prev => prev.filter((_item, itemIndex) => itemIndex !== index));
  };

  const handleSave = async () => {
    if (validationMessage) return;
    setStatus('saving');
    const ok = await onSave(items);
    setStatus(ok ? 'saved' : 'error');
    if (ok) {
      setTimeout(() => setStatus(prev => prev === 'saved' ? 'idle' : prev), 2000);
    }
  };

  const hasChanges = JSON.stringify(items) !== JSON.stringify(keywords);
  const validationMessage = getKeywordValidationMessage(items);

  return (
    <section className="card keyword-card">
      <div className="section-title-row">
        <div>
          <h2>我的主要事情</h2>
          <p className="muted">这是整个仪表盘的分类表，会影响上面的列表、心流时间段和分心分。</p>
        </div>
        <InfoTooltip text="例如你把 Codex、opencode、VS Code 都放进“编码”，它们之间来回切就算同一件事。只有从“编码”跳到聊天、娱乐、查资料等其他事，才算换到另一件事。排序数字只在同一条活动同时命中多个任务时使用，数字大的优先。" />
      </div>

      <div className="keyword-guide">
        <div>
          <span className="guide-step">1</span>
          <p>写一件正事，例如“编码”。</p>
        </div>
        <div>
          <span className="guide-step">2</span>
          <p>把相关工具和网页名写进去，例如“Codex, opencode, VS Code”。</p>
        </div>
        <div>
          <span className="guide-step">3</span>
          <p>如果一条活动同时命中多件事，排序数字大的优先。</p>
        </div>
      </div>

      <div className="keyword-grid">
        {items.map((kw, i) => (
          <div key={i} className="keyword-item">
            <div className="keyword-item-head">
              <span>规则 {i + 1}</span>
              <button className="text-button" type="button" onClick={() => removeItem(i)}>
                删除
              </button>
            </div>
            <label className="field-label">
                这件事叫
              <input
                value={kw.label}
                onChange={e => updateItem(i, 'label', e.target.value)}
                placeholder="例如：编码"
              />
            </label>
            <label className="field-label">
              包含这些字就算这件事
            </label>
            <div className="tag-editor">
              {kw.patterns.map((pattern, pi) => (
                <span key={pi} className="tag-chip">
                  {pattern}
                  <button
                    type="button"
                    className="tag-chip__x"
                    onClick={() => {
                      const next = [...kw.patterns];
                      next.splice(pi, 1);
                      updateItem(i, 'patterns', next.join(','));
                    }}
                    aria-label={`删除 ${pattern}`}
                  >×</button>
                </span>
              ))}
              <input
                className="tag-editor__input"
                placeholder={kw.patterns.length === 0 ? '输入关键词，回车添加' : '继续添加…'}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    const value = (e.target as HTMLInputElement).value.trim();
                    if (value) {
                      const next = [...kw.patterns, value];
                      updateItem(i, 'patterns', next.join(','));
                      (e.target as HTMLInputElement).value = '';
                    }
                  } else if (e.key === 'Backspace' && (e.target as HTMLInputElement).value === '' && kw.patterns.length > 0) {
                    const next = [...kw.patterns];
                    next.pop();
                    updateItem(i, 'patterns', next.join(','));
                  }
                }}
              />
            </div>
            <label className="field-label field-label--priority">
              排序数字
              <input
                type="number"
                value={kw.priority}
                onChange={e => updateItem(i, 'priority', Number(e.target.value))}
                placeholder="100"
              />
            </label>
            <div className="keyword-item-meta">
              包含任一个词就算命中；数字越大越优先。
            </div>
          </div>
        ))}
      </div>
      <div className="keyword-actions">
        <button
          className="btn btn--ghost btn--small"
          onClick={addItem}
          type="button"
        >
          新增一件事
        </button>
        <button
          className="btn btn--primary btn--small"
          onClick={handleSave}
          disabled={!hasChanges || Boolean(validationMessage) || status === 'saving'}
        >
          保存设置
        </button>
        {validationMessage && <span className="config-status config-status--error">{validationMessage}</span>}
        {status === 'saving' && <span className="config-status">保存中…</span>}
        {status === 'saved' && <span className="config-status config-status--saved">已保存</span>}
        {status === 'error' && <span className="config-status config-status--error">保存失败，请重试</span>}
      </div>
    </section>
  );
}

function getKeywordValidationMessage(items: KeywordRule[]): string {
  for (const [index, item] of items.entries()) {
    if (!item.label.trim()) return `第 ${index + 1} 件事还没起名字`;
    if (item.patterns.length === 0) return `第 ${index + 1} 件事至少要填 1 个匹配词`;
    if (!Number.isFinite(item.priority)) return `第 ${index + 1} 件事的排序数字必须是数字`;
  }
  return '';
}

function EnergyWasteCard({ summary }: { summary: DailySummaryResponse }) {
  const { metrics, dataStatus, confidence } = summary;
  const level = wasteLevel(metrics.energyWasteScore);
  const statusNote = dataStatus !== 'ok' ? `（${dataStatusLabel(dataStatus)}）` : '';
  const scoreRows = [
    {
      label: '换到另一件事',
      score: metrics.componentScores.frequentSwitchScore,
      weight: '35%',
      detail: `${metrics.meaningfulSwitchCount} 次换到别的事 / ${metrics.rawSwitchCount} 条窗口记录`
    },
    {
      label: '很快离开',
      score: metrics.componentScores.shortStayScore,
      weight: '25%',
      detail: `${formatDuration(metrics.shortStayTimeSec)} / ${metrics.shortStayCount} 段记录`
    },
    {
      label: '不属于我的主要事情',
      score: metrics.componentScores.deviationScore,
      weight: '25%',
      detail: metrics.primaryMainTaskLabel ? `主要在做 ${metrics.primaryMainTaskLabel}` : '还没认出主要在忙什么'
    },
    {
      label: '切回来成本',
      score: metrics.componentScores.recoveryScore,
      weight: '15%',
      detail: `${Math.round(metrics.recoveryCostMin)} 分钟`
    }
  ];

  return (
    <section className="card energy-card">
      <div className="section-title-row">
        <h2>分心程度分</h2>
      </div>
      <div className="energy-row">
        <div className="energy-score" style={{ color: level.color }}>
          {metrics.energyWasteScore}
          <span className="energy-level">{level.label}</span>
        </div>
        <div className="energy-details">
          <p>电脑前时间: {formatDuration(metrics.activeTimeSec)} {statusNote}</p>
          <p>换到另一件事: {metrics.meaningfulSwitchCount} 次</p>
          <p>窗口/网页跳动记录: {metrics.rawSwitchCount} 条</p>
          <p>很快离开的时间: {formatDuration(metrics.shortStayTimeSec)}</p>
          <p>15 分钟内来回换: {metrics.frequentWindows} 次</p>
          <p>不属于我的主要事情: {Math.round(metrics.deviationRatio * 100)}%</p>
          <p>切回来成本: {Math.round(metrics.recoveryCostMin)} 分钟</p>
          <p>数据完整度: {confidenceLabel(confidence)}</p>
          {metrics.primaryMainTaskLabel && <p>主要在做: {metrics.primaryMainTaskLabel}</p>}
        </div>
      </div>
      <div className="score-breakdown">
        {scoreRows.map(row => (
          <div key={row.label} className="score-row">
            <div className="score-row-head">
              <span>{row.label}</span>
              <span>{Math.round(row.score)} · {row.weight}</span>
            </div>
            <div className="score-meter" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, row.score))}%` }} />
            </div>
            <p>{row.detail}</p>
          </div>
        ))}
      </div>
      {metrics.scoringNotes.length > 0 && (
        <ul className="note-list">
          {metrics.scoringNotes.map(note => <li key={note}>{note}</li>)}
        </ul>
      )}
    </section>
  );
}

function FlowBlocksCard({ summary, config }: { summary: DailySummaryResponse; config: ConfigResponse | null }) {
  const { flowBlocks } = summary;
  const flowMinMinutes = config?.thresholds.flowMinMinutes ?? 25;
  const shortSwitchMaxMinutes = config?.thresholds.shortSwitchMaxMinutes ?? 2;
  const afkGraceMinutes = config?.thresholds.afkGraceMinutes ?? 3;

  return (
    <section className="card">
      <div className="section-title-row">
        <h2>心流时间段</h2>
        <div className="inline-help">
          <span className="subtle-pill">{flowMinMinutes} 分钟阈值</span>
          <InfoTooltip text={`同一件事连续累计 ${flowMinMinutes} 分钟以上，就会出现在这里。底部“我的主要事情”会把同类工具合并，比如 Codex、opencode、VS Code 都可以算“编码”。中间 ${shortSwitchMaxMinutes} 分钟以内的小插曲可以容忍，离开电脑超过 ${afkGraceMinutes} 分钟会重新计算。`} />
        </div>
      </div>
      {flowBlocks.length === 0 ? (
        <p className="muted">
          今天还没找到一段足够长的连续工作。当前规则要求同一件事累计至少 {flowMinMinutes} 分钟，
          中间可以有 {shortSwitchMaxMinutes} 分钟以内的小插曲；离开电脑超过 {afkGraceMinutes} 分钟会重新计算。
        </p>
      ) : (
        <ul className="flow-list">
          {flowBlocks.map((block, i) => (
            <li key={i} className="flow-item">
              <span className="flow-time">{formatTime(block.start)} – {formatTime(block.end)}</span>
              <span className="flow-duration">{formatDuration(block.activeDurationSec)}</span>
              <span className="flow-task">{block.taskKey.split(':').pop()}</span>
              {block.toleratedInterruptions > 0 && (
                <span className="flow-tol">中间有 {block.toleratedInterruptions} 次小插曲</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FrequentSwitchCard({ summary }: { summary: DailySummaryResponse }) {
  const { metrics } = summary;
  return (
    <section className="card">
      <div className="section-title-row">
        <h2>有没有换到别的事</h2>
        <InfoTooltip text="换到另一件事：前后两段活动不属于同一件事，而且中间间隔不超过 5 分钟。比如 Codex 和 opencode 都放进“编码”，它们之间来回切就还算在做同一件事。窗口/网页切换记录会保留，但 15 秒以下的小抖动不会拿来扣分。" />
      </div>
      <div className="metric-grid">
        <div className="metric-cell">
          <span className="metric-value">{metrics.meaningfulSwitchCount}</span>
          <span className="metric-label">换到另一件事</span>
        </div>
        <div className="metric-cell">
          <span className="metric-value">{metrics.rawSwitchCount}</span>
          <span className="metric-label">窗口/网页跳动记录</span>
        </div>
        <div className="metric-cell">
          <span className="metric-value">{metrics.frequentWindows}</span>
          <span className="metric-label">15 分钟内来回跳</span>
        </div>
        <div className="metric-cell">
          <span className="metric-value">{formatDuration(metrics.shortStayTimeSec)}</span>
          <span className="metric-label">很快离开的时间</span>
        </div>
      </div>
    </section>
  );
}

function TrendsCard({ trends, selectedDate, ratings }: { trends: TrendsResponse | null; selectedDate: string; ratings: RatingsResponse | null }) {
  if (!trends) return null;
  const entries = trends.entries;
  const ratingMap = ratings?.ratings ?? {};

  return (
    <section className="card">
      <h2>近 7 天趋势</h2>
      <div className="trends-scroll">
        <table className="trends-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>状态</th>
              <th>评分</th>
              <th>分心分</th>
              <th>换到别的事</th>
              <th>心流段</th>
              <th>电脑前时间</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => {
              const isToday = entry.date === selectedDate;
              const dayRating = ratingMap[entry.date];
              return (
                <tr key={entry.date} className={isToday ? 'row--today' : ''}>
                  <td>{formatDateShort(entry.date)}</td>
                  <td>
                    <span className={`badge badge--${entry.dataStatus}`}>
                      {dataStatusLabel(entry.dataStatus)}
                    </span>
                  </td>
                  <td>
                    {dayRating ? (
                      <span className="trends-rating">{'\u2605'.repeat(dayRating.score)}{'\u2606'.repeat(5 - dayRating.score)}</span>
                    ) : (
                      <span className="trends-rating trends-rating--empty">{'\u2013'}</span>
                    )}
                  </td>
                  <td style={{ color: wasteLevel(entry.metrics.energyWasteScore).color }}>
                    {entry.dataStatus === 'ok' || entry.dataStatus === 'sparse' ? entry.metrics.energyWasteScore : '–'}
                  </td>
                  <td>{entry.dataStatus === 'ok' ? entry.metrics.meaningfulSwitchCount : '–'}</td>
                  <td>{entry.dataStatus === 'ok' ? entry.flowBlockCount : '–'}</td>
                  <td>{entry.dataStatus === 'ok' ? formatDuration(entry.metrics.activeTimeSec) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TopTasksCard({ tasks }: { tasks: DailySummaryResponse['topTasks'] }) {
  if (tasks.length === 0) {
    return (
      <section className="card">
        <h2>今天主要在忙什么</h2>
        <p className="muted">暂无活动数据。</p>
      </section>
    );
  }

  const top = tasks.slice(0, 8);
  return (
    <section className="card">
      <div className="section-title-row">
        <div>
          <h2>今天主要在忙什么</h2>
          <p className="muted">这里会按底部“我的主要事情”合并。比如 Codex、opencode、VS Code 都会合到“编码”。</p>
        </div>
        <InfoTooltip text="这张列表不是简单按窗口标题排，而是先看底部“我的主要事情”。命中同一件事的多个工具和网页会合并到一起；没命中的活动会按原始标题显示，并出现在“还没认出来的活动”里。" />
      </div>
      <ul className="task-list">
        {top.map(task => (
          <li key={task.taskKey} className="task-item">
            <div className="task-main">
              <span className="task-name">{displayTaskName(task)}</span>
              <span className="task-meta">
                {task.taskKey.startsWith('主任务:')
                  ? `${task.app} · 由“我的主要事情”合并 · ${task.segmentCount} 段`
                  : `${task.app} · ${task.source === 'web' ? '网页' : '窗口'} · ${task.segmentCount} 段`}
              </span>
            </div>
            <span className="task-duration">{formatDuration(task.durationSec)}</span>
            {task.mergedItems && task.mergedItems.length >= 2 && (
              <div className="merged-popover">
                <div className="merged-popover__title">合并自 {task.mergedItems.length} 条活动</div>
                <ul className="merged-popover__list">
                  {task.mergedItems.map((item, j) => (
                    <li key={j} className="merged-popover__item">
                      <span className="merged-popover__item-title" title={`${item.app}: ${item.title}`}>
                        {item.title || item.app}
                      </span>
                      <span className="merged-popover__item-time">{formatDuration(item.durationSec)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SwitchTimelineCard({ timeline }: { timeline: DailySummaryResponse['switchTimeline'] }) {
  const switches = timeline.filter(e => e.isSwitch);
  if (switches.length === 0) {
    return (
      <section className="card">
        <h2>最近换到别的事</h2>
        <p className="muted">今天还没看到从一件事切到另一件事。</p>
      </section>
    );
  }

  const shown = switches.slice(-20).reverse();
  return (
    <section className="card">
      <div className="section-title-row">
        <h2>最近换到别的事</h2>
        <InfoTooltip text="这里展示最近 20 次“从一件事换到另一件事”。数据由前端每 60 秒重新请求 /api/summary 更新；后端每次请求都会实时查询 ActivityWatch，不做服务端缓存。" />
      </div>
      <p className="muted">显示最近 {shown.length} 次换到别的事（共 {switches.length} 次），最新在上。</p>
      <ul className="timeline-list">
        {shown.map((entry, i) => (
          <li key={i} className="timeline-item">
            <span className="timeline-time">{formatTime(entry.at)}</span>
            <span className="timeline-arrow">→</span>
            <span className="timeline-task">{displayTimelineName(entry.taskGroupKey, entry.title, entry.taskKey)}</span>
            <span className="timeline-from">
              {entry.fromTaskGroupKey ? `从 ${displayTimelineName(entry.fromTaskGroupKey, '', entry.fromTaskKey ?? '')}` : ''}
            </span>
            <span className="timeline-duration">{formatTimelineDuration(entry.durationSec)}</span>
            <div className="timeline-popover">
              <div className="timeline-popover__row">
                <span className="timeline-popover__label">时间</span>
                <span className="timeline-popover__value">{formatTime(entry.at)}</span>
              </div>
              <div className="timeline-popover__row">
                <span className="timeline-popover__label">从</span>
                <span className="timeline-popover__value" title={entry.fromTaskKey ?? ''}>
                  {entry.fromTaskGroupKey
                    ? displayTimelineName(entry.fromTaskGroupKey, '', entry.fromTaskKey ?? '')
                    : (entry.fromTaskKey ?? '—')}
                </span>
              </div>
              <div className="timeline-popover__row">
                <span className="timeline-popover__label">到</span>
                <span className="timeline-popover__value" title={entry.taskKey}>
                  {displayTimelineName(entry.taskGroupKey, entry.title, entry.taskKey)}
                </span>
              </div>
              <div className="timeline-popover__divider" />
              <div className="timeline-popover__row">
                <span className="timeline-popover__label">应用</span>
                <span className="timeline-popover__value">{entry.app}</span>
              </div>
              <div className="timeline-popover__row">
                <span className="timeline-popover__label">时长</span>
                <span className="timeline-popover__value">{formatDuration(entry.durationSec)}</span>
              </div>
              <div className="timeline-popover__row">
                <span className="timeline-popover__label">间隔</span>
                <span className="timeline-popover__value">{entry.gapSec < 60 ? `${Math.round(entry.gapSec)} 秒` : formatDuration(entry.gapSec)}</span>
              </div>
              {entry.domain && (
                <div className="timeline-popover__row">
                  <span className="timeline-popover__label">域名</span>
                  <span className="timeline-popover__value">{entry.domain}</span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="info-tooltip" tabIndex={0} aria-label={text}>
      ?
      <span className="info-tooltip__bubble" role="tooltip">{text}</span>
    </span>
  );
}

function UnclassifiedCard({ tasks }: { tasks: DailySummaryResponse['unclassifiedActivityCandidates'] }) {
  if (tasks.length === 0) return null;

  return (
    <section className="card">
      <h2>还没认出来的活动</h2>
      <p className="muted">这些活动还没归到任何一件事里。经常出现的话，可以在底部加到“我的主要事情”。</p>
      <ul className="task-list">
        {tasks.slice(0, 5).map(task => (
          <li key={task.taskKey} className="task-item">
            <div className="task-main">
              <span className="task-name">{task.title || task.taskKey}</span>
              <span className="task-meta">{task.app} · {formatDuration(task.durationSec)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WarningsCard({ warnings }: { warnings: string[] }) {
  return (
    <section className="card card--warning">
      <h2>注意事项</h2>
      <ul className="warning-list">
        {warnings.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </section>
  );
}

function formatDateShort(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  const weekday = new Date(Number(y), Number(m) - 1, Number(d))
    .toLocaleDateString('zh-CN', { weekday: 'short' });
  return `${m}/${d} ${weekday}`;
}

function formatTimelineDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '0 秒';
  if (totalSec < 60) return `${Math.max(1, Math.round(totalSec))} 秒`;
  if (totalSec < 3600) {
    const minutes = Math.floor(totalSec / 60);
    const seconds = Math.round(totalSec % 60);
    return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  }
  return formatDuration(totalSec);
}

function truncateTaskKey(key: string): string {
  const parts = key.split(':');
  return parts.length > 1 ? parts.slice(1).join(':') : key;
}

function displayTimelineName(groupKey: string, title: string, taskKey: string): string {
  if (groupKey.startsWith('主任务:')) {
    return groupKey.replace(/^主任务:/, '');
  }
  return title || truncateTaskKey(taskKey);
}

function displayTaskName(task: DailySummaryResponse['topTasks'][number]): string {
  if (task.taskKey.startsWith('主任务:')) {
    return task.taskKey.replace(/^主任务:/, '');
  }
  return task.title || task.taskKey;
}

export default App;

# 每日飞书专注力日报 · 近 7 天数据聚合算法

> 文档版本：v1.0
> 适用范围：每日 07:00 cron 任务，聚合 D-7 到 D-1（昨日）共 7 天的 ActivityWatch 数据
> 下一棒：@developer 按本文档实现 cron 内逻辑（**不要写实际代码，只看本文档**）

---

## 0. 数据获取策略（实现前必读）

仪表盘后端**已经内置了趋势接口**，请优先使用，避免 7 次串行请求：

| 调用方式 | 用途 | 备注 |
|---------|------|------|
| `GET /api/trends?days=7&end={D-1}` | 一次性拿 7 天 `TrendDayEntry[]` | 含 metrics + topTasks(5) + flowBlockCount |
| `GET /api/summary?date={D-1}` | 拿昨日完整 `DailySummaryResponse` | 含 switchTimeline，用于「偏离热点」识别 |

**总计 2 次 HTTP 调用**。若 `/api/trends` 不可用，回退方案见 §4。

返回结构关键路径：
- `TrendsResponse.entries[i].metrics` → 7 天指标
- `TrendsResponse.entries[i].topTasks` → top 5 任务（含 mergedItems）
- `TrendsResponse.entries[i].dataStatus` → `'ok' | 'sparse' | 'missing'`
- `DailySummaryResponse.switchTimeline` → 每段活动明细，含 `app`/`title`/`durationSec`/`isSwitch`

---

## 1. 五维核心指标定义表

> 设计原则：5 个维度覆盖「总量 / 结构占比 / 综合质量 / 行为稳定 / 碎片化」四个心智模型，避免维度间冗余。

| # | 中文名 | 英文字段 | 算法（来自单日 metrics） | 单位 | 好的方向 | 显示格式 | 说明 |
|---|--------|---------|----------------------|------|---------|---------|------|
| D1 | 主任务投入 | `mainTaskHours` | `metrics.mainTaskTimeSec / 3600` | 小时 | **越大越好** ↑ | `3h 24m` | 一天中最核心的"在做事"总量，体现工作产出潜力 |
| D2 | 专注占比 | `focusRatio` | `1 - metrics.deviationRatio`，即 `mainTaskTimeSec / activeTimeSec` | 百分比 | **越大越好** ↑ | `68%` | 活跃时间里有多少落在"主任务"上，体现目标清晰度 |
| D3 | 能量浪费分 | `energyWaste` | `metrics.energyWasteScore` | 0-100 分 | **越小越好** ↓ | `42/100` | 后端已聚合的复合分（35% 频切 + 25% 短停 + 25% 偏离 + 15% 恢复） |
| D4 | 切换密度 | `switchRate` | `metrics.meaningfulSwitchCount / (metrics.activeTimeSec / 3600)` | 次/小时 | **越小越好** ↓ | `5.2 次/h` | 单位时间内有意义切换次数，体现注意力稳定性 |
| D5 | 碎片化占比 | `fragmentRatio` | `metrics.shortStayTimeSec / metrics.activeTimeSec` | 百分比 | **越小越好** ↓ | `12%` | 短停留总时长占活跃时间比，体现诱惑窗口的"时间税" |

### 1.1 衍生展示项（非独立维度，但日报会展示）

| 字段 | 来源 | 用途 |
|------|------|------|
| `activeHours` | `activeTimeSec / 3600` | 当日总活跃时长（背景信息） |
| `primaryTaskLabel` | `metrics.primaryMainTaskLabel` | 当日主任务标签（如「编程」「自媒体」） |
| `flowBlockCount` | `TrendDayEntry.flowBlockCount` | 心流块数量（≥ 阈值的连续深度块） |
| `flowHours` | `flowBlockCount × flowDurationSec / 3600` | 心流总时长 |
| `recoveryCostMin` | `metrics.recoveryCostMin` | 当日切换恢复成本（分钟） |

---

## 2. 七天聚合算法

### 2.1 输入

```typescript
// 概念类型（不要求实现成 TS，伪代码）
input.entries     : TrendDayEntry[7]   // 已按日期升序，entries[6] = 昨天 D-1
input.yesterday   : DailySummaryResponse  // 完整昨日数据，用于偏离热点
```

> **日期约定**：`entries[0]` = D-7（最早），`entries[6]` = D-1（昨天）。
> 趋势条、均值、对比都基于此顺序。

### 2.2 输出（最终聚合对象 schema）

```jsonc
{
  "meta": {
    "reportDate": "2026-06-07",          // 报告生成日（今天）
    "windowStart": "2026-05-31",         // D-7
    "windowEnd": "2026-06-06",           // D-1 = 昨天
    "generatedAt": "2026-06-07T07:00:00+08:00",
    "dataQuality": {
      "availableDays": 6,                // entries 里 dataStatus='ok' 的天数
      "missingDays": ["2026-06-03"],     // dataStatus='missing' 的日期
      "sparseDays": ["2026-06-01"],      // dataStatus='sparse' 的日期
      "okRatio": 0.86                    // availableDays / 7
    }
  },
  "yesterday": {                          // 昨日单日完整值（见 §2.4）
    "date": "2026-06-06",
    "primaryTaskLabel": "编程",
    "activeHours": 7.2,
    "dimensions": { /* 见 §2.4 */ },
    "topTasks": [ /* 前 5 个 */ ],
    "hotspots": [ /* 见 §2.7 */ ]
  },
  "weekStats": {                          // 7 天聚合统计（见 §2.5）
    "dimensions": {
      "mainTaskHours": { "mean": 3.8, "trend": [/* 7 个浮点数 */], "sparkline": "▃▅▆▄▇▆▇" },
      "focusRatio":     { "mean": 0.65, /* ... */ },
      "energyWaste":    { "mean": 48,   /* ... */ },
      "switchRate":     { "mean": 6.1,  /* ... */ },
      "fragmentRatio":  { "mean": 0.14, /* ... */ }
    }
  },
  "delta": {                              // 昨日 vs 7 天均值（见 §2.6）
    "mainTaskHours": { "value": 4.2, "delta": "+0.4h", "pct": 10.5, "direction": "up", "isGood": true, "symbol": "↑" },
    "focusRatio":     { "value": 0.72, "delta": "+7pp", "pct": 10.8, "direction": "up", "isGood": true, "symbol": "↑" },
    "energyWaste":    { "value": 38,   "delta": "-10",  "pct": -20.8, "direction": "down", "isGood": true, "symbol": "↓" },
    "switchRate":     { "value": 8.5,  "delta": "+2.4", "pct": 39.3, "direction": "up", "isGood": false, "symbol": "↑" },
    "fragmentRatio":  { "value": 0.18, "delta": "+4pp", "pct": 28.6, "direction": "up", "isGood": false, "symbol": "↑" }
  },
  "worstDimension": {                      // 见 §2.8
    "key": "switchRate",
    "name": "切换密度",
    "yesterdayValue": 8.5,
    "weekMean": 6.1,
    "degradationPct": 39.3,
    "absoluteDelta": 2.4,
    "hint": "昨日切换密度比 7 天均值高 39%（8.5 vs 6.1 次/h），是当日最差维度"
  },
  "bestDimension": {                       // 见 §2.8（正向反馈用）
    "key": "energyWaste",
    "name": "能量浪费分",
    "yesterdayValue": 38,
    "weekMean": 48,
    "improvementPct": 20.8,
    "hint": "能量浪费分比均值低 10 分，做得不错"
  },
  "briefing": {                            // 见 §5，丢给 LLM 的数据简报
    "headline": "...",
    "signals": [ /* ... */ ],
    "topTasks": [ /* ... */ ],
    "hotspots": [ /* ... */ ]
  }
}
```

### 2.3 算法主流程（伪代码）

```
FUNCTION aggregateReport():
    # Step 1: 数据获取
    LET end = localDateString(today() - 1 day)
    LET trends = httpGet("/api/trends?days=7&end=" + end)
    LET yesterdaySummary = httpGet("/api/summary?date=" + end)
    
    # 兜底：若 trends 失败，见 §4
    IF trends 失败:
        RETURN buildDegradedReport(yesterdaySummary, end)   # 见 §4.3
    
    LET entries = trends.entries   # 长度 = 7，按日期升序
    
    # Step 2: 数据质量评估
    LET meta = buildMeta(entries, end)
    IF meta.dataQuality.okRatio < 0.4:    # 不到 3 天有效数据
        RETURN buildLowDataReport(entries, meta, yesterdaySummary)
    
    # Step 3: 计算每日 5 维
    LET dailyDims = entries.map(entry => computeDimensions(entry.metrics))
    
    # Step 4: 计算昨日单日
    LET yesterday = {
        date: end,
        primaryTaskLabel: entries[6].metrics.primaryMainTaskLabel ?? "未识别",
        activeHours: entries[6].metrics.activeTimeSec / 3600,
        dimensions: dailyDims[6],
        topTasks: entries[6].topTasks.slice(0, 5),
        hotspots: detectHotspots(yesterdaySummary)
    }
    
    # Step 5: 计算 7 天统计 + 趋势条
    LET weekStats = buildWeekStats(dailyDims)
    
    # Step 6: 计算环比 (delta)
    LET delta = buildDelta(dailyDims[6], weekStats.dimensions)
    
    # Step 7: 识别最差/最优维度
    LET worstDim = identifyWorstDimension(delta, dailyDims[6])
    LET bestDim  = identifyBestDimension(delta, dailyDims[6])
    
    # Step 8: 生成 LLM 数据简报
    LET briefing = buildLLMBriefing(yesterday, weekStats, delta, worstDim, bestDim)
    
    RETURN { meta, yesterday, weekStats, delta, worstDimension: worstDim, bestDimension: bestDim, briefing }
```

### 2.4 单日维度计算函数

```
FUNCTION computeDimensions(m):
    RETURN {
        mainTaskHours: round(m.mainTaskTimeSec / 3600, 2),       # 小时
        focusRatio:    round(1 - m.deviationRatio, 4),           # 0-1
        energyWaste:   m.energyWasteScore,                       # 0-100
        switchRate:    m.activeTimeSec > 0
                       ? round(m.meaningfulSwitchCount / (m.activeTimeSec / 3600), 1)
                       : 0,                                       # 次/h
        fragmentRatio: m.activeTimeSec > 0
                       ? round(m.shortStayTimeSec / m.activeTimeSec, 4)
                       : 0                                        # 0-1
    }
```

### 2.5 七天均值 + 趋势数组

```
FUNCTION buildWeekStats(dailyDims):    # dailyDims 长度 = 7
    LET dims = ["mainTaskHours", "focusRatio", "energyWaste", "switchRate", "fragmentRatio"]
    LET result = {}
    FOR EACH dim IN dims:
        LET values = dailyDims.map(d => d[dim])    # 7 个数
        
        # 均值（仅对有效日计算）
        LET validValues = values.filter((v, i) => entries[i].dataStatus === 'ok')
        LET mean = validValues.length > 0 ? avg(validValues) : 0
        
        # 趋势条
        LET sparkline = renderSparkline(values, dim)
        
        result[dim] = { mean, trend: values, sparkline }
    RETURN result
```

> **均值口径**：用 `dataStatus === 'ok'` 的天做分母。`sparse` 和 `missing` 不参与均值，但仍占趋势条位置。

### 2.6 同比/环比 delta 计算

```
FUNCTION buildDelta(yesterdayDim, weekStats):
    LET result = {}
    FOR EACH dim IN dimensions:
        LET weekMean = weekStats[dim].mean
        LET yesterday = yesterdayDim[dim]
        LET diff = yesterday - weekMean
        
        # 百分比变化（防除零）
        LET pct = weekMean != 0
                  ? round(diff / abs(weekMean) * 100, 1)
                  : (yesterday != 0 ? 100 : 0)
        
        # 是否向好（依据维度方向）
        LET isGood = isPositiveChange(dim, diff)
        
        # 符号
        LET symbol = diff > 0.5% ? "↑" : (diff < -0.5% ? "↓" : "→")
        
        # delta 文本（差异化格式）
        LET deltaText = formatDeltaText(dim, diff)
        
        result[dim] = {
            value: yesterday,
            delta: deltaText,
            pct: pct,
            direction: diff > 0 ? "up" : (diff < 0 ? "down" : "flat"),
            isGood: isGood,
            symbol: symbol
        }
    RETURN result

FUNCTION isPositiveChange(dim, diff):
    LET upGoodDims = {"mainTaskHours", "focusRatio"}        # 越大越好
    LET downGoodDims = {"energyWaste", "switchRate", "fragmentRatio"}  # 越小越好
    IF dim IN upGoodDims:   RETURN diff > 0
    IF dim IN downGoodDims: RETURN diff < 0
    RETURN false

FUNCTION formatDeltaText(dim, diff):
    # 按维度个性化格式
    SWITCH dim:
        CASE "mainTaskHours":  # 小时
            RETURN formatHourDiff(diff)        # "+0.4h" / "-12m"
        CASE "focusRatio":     # 百分比
            RETURN (diff * 100).toFixed(0) + "pp"  # "+7pp"
        CASE "energyWaste":    # 分值
            RETURN (diff >= 0 ? "+" : "") + diff.toFixed(0)
        CASE "switchRate":     # 次/h
            RETURN (diff >= 0 ? "+" : "") + diff.toFixed(1)
        CASE "fragmentRatio":  # 百分比
            RETURN (diff * 100).toFixed(0) + "pp"
```

> **格式辅助**：`formatHourDiff(diff)` —— 若 |diff| < 0.5h，显示分钟（如 `+24m`）；否则显示小时（如 `+1.2h`）。

### 2.7 偏离热点识别（短停留 top 3）

```
FUNCTION detectHotspots(yesterdaySummary):
    # 输入是完整 DailySummaryResponse，含 switchTimeline
    # 默认短停留阈值 = 90 秒（可配置，与后端 shortSwitchMaxMinutes 解耦，因为我们要更激进的"诱惑窗口"识别）
    LET SHORT_THRESHOLD_SEC = 90
    LET MIN_DURATION_SEC = 2            # 过滤纯 AFK 噪声
    LET MIN_HIT_COUNT = 2               # 至少被打开关掉 2 次才算"诱惑"
    
    # Step 1: 过滤短停留段
    LET shortSegs = yesterdaySummary.switchTimeline.filter(s =>
        s.durationSec >= MIN_DURATION_SEC
        AND s.durationSec <= SHORT_THRESHOLD_SEC
    )
    
    # Step 2: 按 app + title 分组
    LET groups = groupBy(shortSegs, s => s.app + "|" + s.title)
    
    # Step 3: 聚合
    LET candidates = []
    FOR EACH group IN groups:
        LET hitCount = group.length
        LET totalSec = sum(group.map(s => s.durationSec))
        LET avgSec   = totalSec / hitCount
        IF hitCount >= MIN_HIT_COUNT:
            candidates.push({
                app: group[0].app,
                title: normalizeTitle(group[0].title),
                hitCount: hitCount,
                totalDurationSec: totalSec,
                avgDurationSec: round(avgSec, 0)
            })
    
    # Step 4: 排序：先按 hitCount 倒序，再按 totalDurationSec 倒序
    candidates.sort((a, b) => b.hitCount - a.hitCount OR b.totalDurationSec - a.totalDurationSec)
    
    # Step 5: 取 top 3，若不足 3 个则补足提示
    LET top3 = candidates.slice(0, 3)
    
    RETURN top3.length > 0
        ? top3
        : [{ app: "无", title: "昨日没有明显短停留窗口，保持节奏！", hitCount: 0, totalDurationSec: 0 }]

FUNCTION normalizeTitle(title):
    # 去掉常见前缀，避免列表污染
    # - "GitHub - " -> "GitHub"
    # - 截断超长 title 到 40 字符
    LET cleaned = title.replace(/^(GitHub - |.*? - )/, "").trim()
    RETURN cleaned.length > 40 ? cleaned.slice(0, 40) + "..." : cleaned
```

### 2.8 最差/最优维度识别

```
FUNCTION identifyWorstDimension(delta, yesterdayDim):
    # 思路：综合「退化幅度（pct）」与「绝对量级」
    # 单看 pct 会被低基线放大；单看绝对值会偏袒大数值维度
    # 采用：badnessScore = pct_bad_direction × magnitudeFactor
    
    LET candidates = []
    FOR EACH dim IN delta:
        IF delta[dim].symbol === "→":   CONTINUE   # 平局，不参与"最差"
        IF delta[dim].isGood === true:  CONTINUE   # 向好，跳过
        
        # magnitudeFactor = 昨日值占该维度"典型量级"的比，避免低基线放大效应
        LET baseline = DIMENSION_BASELINE[dim]      # 见下表
        LET mag = min(1, yesterdayDim[dim] / baseline)
        
        # badness = 退化百分比 × 量级因子（× 100 让数值直观）
        LET badness = abs(delta[dim].pct) * (0.4 + 0.6 * mag)
        
        candidates.push({
            key: dim,
            name: DIMENSION_NAME[dim],
            yesterdayValue: yesterdayDim[dim],
            weekMean: weekStats[dim].mean,
            degradationPct: abs(delta[dim].pct),
            absoluteDelta: abs(yesterdayDim[dim] - weekStats[dim].mean),
            badnessScore: badness
        })
    
    IF candidates.length === 0:
        RETURN null    # 昨日所有维度都向好或持平
    
    candidates.sort((a, b) => b.badnessScore - a.badnessScore)
    
    LET worst = candidates[0]
    RETURN {
        ...worst,
        hint: `${worst.name}比 7 天均值${worst.degradationPct > 0 ? "差" : "好"} ${worst.degradationPct.toFixed(1)}%（${formatValue(worst.key, worst.yesterdayValue)} vs ${formatValue(worst.key, worst.weekMean)}），是当日最差维度`
    }

# 维度典型基线（用于量级因子，可调整）
DIMENSION_BASELINE = {
    mainTaskHours: 4.0,    # 4 小时
    focusRatio:    0.6,    # 60%
    energyWaste:   50,     # 50 分
    switchRate:    5.0,    # 5 次/h
    fragmentRatio: 0.15    # 15%
}
DIMENSION_NAME = {
    mainTaskHours: "主任务投入",
    focusRatio:    "专注占比",
    energyWaste:   "能量浪费分",
    switchRate:    "切换密度",
    fragmentRatio: "碎片化占比"
}
```

> **`identifyBestDimension` 镜像逻辑**：把 `isGood === true` 的候选纳入，按 `improvementPct × magnitudeFactor` 排序取 top 1。如果没有向好的维度则返回 `null`。

---

## 3. ASCII 趋势条渲染规则

### 3.1 字符映射表

使用 8 级 Block 字符：

| 索引 | 字符 | Unicode |
|------|------|---------|
| 0 | ▁ | U+2581 |
| 1 | ▂ | U+2582 |
| 2 | ▃ | U+2583 |
| 3 | ▄ | U+2584 |
| 4 | ▅ | U+2585 |
| 5 | ▆ | U+2586 |
| 6 | ▇ | U+2587 |
| 7 | █ | U+2588 |

### 3.2 渲染算法

```
FUNCTION renderSparkline(values[7], dim):
    # Step 1: 过滤无效值（missing / sparse 日）
    # 但保留位置（用于与日期对齐）
    
    IF all values are 0:
        RETURN "▁▁▁▁▁▁▁"          # 全 0，统一显示最低
    
    IF all valid values are equal:
        RETURN "▄▄▄▄▄▄▄"          # 全相同（且非 0），统一显示中间
    
    LET vMin = min(valid values)
    LET vMax = max(valid values)
    LET vRange = vMax - vMin
    
    LET chars = []
    FOR i = 0 TO 6:
        v = values[i]
        IF entry[i].dataStatus === 'missing' OR v is null:
            chars.push("·")        # 用中点表示缺数据
            CONTINUE
        
        # 线性归一化到 [0, 1]，再映射到 [0, 7]
        LET normalized = (v - vMin) / vRange
        LET level = round(normalized * 7)   # 0..7
        level = clamp(level, 0, 7)
        chars.push(BLOCK_CHARS[level])
    
    RETURN join(chars)
```

### 3.3 边界处理汇总

| 边界场景 | 处理 | 示例 |
|---------|------|------|
| 7 天全 0（用户没开机） | `▁▁▁▁▁▁▁` | — |
| 7 天全相同非 0 | `▄▄▄▄▄▄▄` | 稳定但不分化 |
| 某天 `dataStatus='missing'` | 该位用 `·`（U+00B7）占位 | `▃▅·▆▇▆▇` |
| 某天 `dataStatus='sparse'` 且值 > 0 | 正常渲染（数据虽稀但有信号） | — |
| 某天 `dataStatus='sparse'` 且值 = 0 | 该位用 `·` 占位 | — |
| `vMin === vMax` 但不全 0 | `▄▄▄▄▄▄▄` | — |
| 极端 outlier（一天远高于其他） | 正常按线性归一化，其他 6 天会被压低；这是**有意行为**（让 outlier 显眼） | `▁▁▁▁▁▁█` |

### 3.4 排序约定

- **顺序：D-7（左）→ D-1（右）**，时间从远到近
- 用户阅读顺序：从左到右 = 从过去到昨天
- 7 个字符，每个对应一天，严格 1:1

### 3.5 显示格式（飞书消息中）

每个维度一行，格式：
```
{维度名}    {昨日值} {symbol}{delta}  {sparkline}    7 天均值 {mean}
```

示例：
```
主任务投入  3h 24m ↑ +0.4h  ▃▅▆▄▇▆▇    7 天均值 3.0h
专注占比    72%   ↑ +7pp   ▃▄▅▆▇▆▇    7 天均值 65%
能量浪费分  42    ↓ -10    ▇▆▅▆▄▃▂    7 天均值 52
切换密度    8.5   ↑ +2.4   ▂▃▄▃▅▆▇    7 天均值 6.1 次/h
碎片化占比  18%   ↑ +4pp   ▂▃▂▄▅▄▆    7 天均值 14%
```

> **注**：能量浪费分、切换密度、碎片化占比是「越小越好」。当昨日值 > 均值时，趋势条右端（昨日）可能反而更高，这是**正确的**——趋势条始终表达原始量级，方向性由 `↑↓→` 符号 + 文字提示传达。**不要反转**。

---

## 4. 数据异常兜底

### 4.1 Dashboard 服务挂了

**判定**：`/api/trends` 或 `/api/summary` 返回：
- 连接拒绝 / 超时（无 HTTP 响应）
- HTTP 5xx

**输出**：

```
{
  "meta": {
    "reportDate": "2026-06-07",
    "windowStart": null,
    "windowEnd": null,
    "generatedAt": "...",
    "dataQuality": { "availableDays": 0, "okRatio": 0 },
    "error": {
      "type": "DASHBOARD_UNAVAILABLE",
      "message": "本地仪表盘服务无法访问 (http://localhost:8787)",
      "httpStatus": null | 500 | 503,
      "suggestion": "请检查：1) 仪表盘进程是否运行 2) ActivityWatch 是否启动 3) 端口 8787 是否被占用"
    }
  },
  "yesterday": null,
  "weekStats": null,
  "delta": null,
  "worstDimension": null,
  "bestDimension": null,
  "briefing": null,
  "fallbackMessage": "⚠️ 今日专注力日报生成失败：本地仪表盘无法访问。请欧总启动仪表盘后手动重试。"
}
```

**飞书卡片**：只发送一段简短文本：

> ⚠️ 专注力日报失败｜{日期}
> 本地仪表盘无法访问（http://localhost:8787）。
> 请确认仪表盘进程在跑，然后手动触发 [重试链接]。

### 4.2 某一天数据为空

**判定**：`entry.dataStatus === 'missing'`（后端已检测，rawEventCount=0）

**处理**：
- **均值计算**：跳过该日，分母 = 有效天数（不强制 / 7）
- **趋势条**：该日位置用 `·` 占位（见 §3.3）
- **日报文本**：在数据质量区显示 `"6/7 天有效数据，1 天缺失：2026-06-03"`

**`activeTimeSec=0` 但 `dataStatus='sparse'` 的特殊情况**：
- 视为有效 0，参与均值（会让均值降低）
- 趋势条该位为 `▁`
- 这是有意保留的：用户开了一天机但没工作，要反馈出来

### 4.3 LLM 二次推理失败

**判定**：调用 glm-5.1 时返回错误 / 超时 / 内容为空

**降级输出**：使用 `briefing` 字段中的纯结构化数据，渲染成"裸数据版"飞书卡片：

```
📊 欧总｜{日期} 专注力日报（数据版，AI 建议生成失败）

📈 5 维数据（昨日 vs 7 天均值）
- 主任务投入：3h 24m ↑ +0.4h （7d 均值 3.0h）
- 专注占比：72% ↑ +7pp （7d 均值 65%）
- 能量浪费分：42 ↓ -10 （7d 均值 52）
- 切换密度：8.5 ↑ +2.4 次/h （7d 均值 6.1）
- 碎片化占比：18% ↑ +4pp （7d 均值 14%）

⚠️ 当日最差维度：切换密度（+39%，8.5 vs 6.1）

🎯 昨日偏离热点（建议今日砍掉的诱惑窗口）
1. 微信｜xxx 发来一条消息 — 12 次 / 共 8 分 30 秒
2. Chrome｜Bilibili 首页 — 7 次 / 共 5 分 12 秒
3. ...

📌 主任务标签：编程
💧 心流块：3 个 / 共 1h 50m
⏱️ 活跃时长：7h 12m

（AI 建议生成失败，纯数据版）
```

**触发条件**：在主流程末尾，先 try LLM，catch 后用纯数据模板渲染。

### 4.4 数据质量过低（兜底兜底）

**判定**：`meta.dataQuality.okRatio < 0.4`（7 天里 < 3 天有效）

**输出 `buildLowDataReport`**：

```
{
  "meta": { ..., "dataQuality": { "okRatio": 0.28 } },
  "briefing": {
    "headline": "本周数据不足，难以给出可靠建议",
    "signals": [
      "7 天里只有 2 天有完整 ActivityWatch 数据",
      "可能原因：电脑未开机 / ActivityWatch 未启动 / 仪表盘配置错误"
    ],
    "rawYesterday": { ... }    # 如果昨日有数据，照常输出昨日单日
  },
  "fallbackMessage": "⚠️ 本周数据不足（仅 N/7 天有效）。建议先确认 ActivityWatch 持续运行一周后再观察趋势。"
}
```

---

## 5. LLM 数据简报 Schema

> 这一节定义**丢给 glm-5.1 的数据结构**。LLM 拿到这个简报，配合「乔布斯视角」prompt 就能输出有针对性的尖锐建议。

### 5.1 简报结构（推荐 JSON）

```jsonc
{
  "briefing": {
    "version": "1.0",
    "reportDate": "2026-06-07",
    "yesterdayDate": "2026-06-06",
    "primaryTaskLabel": "编程",
    
    "headline": "昨日主任务 4.2h，超均值 10%；但切换密度飙升 39%（8.5 vs 6.1 次/h），是本周最差表现。",
    
    "signals": [
      {
        "type": "positive",
        "dimension": "mainTaskHours",
        "text": "主任务投入 4.2h，比 7 天均值（3.0h）多 0.4h（+10.5%）"
      },
      {
        "type": "positive",
        "dimension": "focusRatio",
        "text": "专注占比 72%，比均值（65%）高 7 个百分点"
      },
      {
        "type": "positive",
        "dimension": "energyWaste",
        "text": "能量浪费分 42，比均值（52）低 10 分，效率较好"
      },
      {
        "type": "negative",
        "dimension": "switchRate",
        "text": "切换密度 8.5 次/h，比均值（6.1）高 2.4 次（+39%），是当日最差维度"
      },
      {
        "type": "negative",
        "dimension": "fragmentRatio",
        "text": "碎片化占比 18%，比均值（14%）高 4 个百分点"
      }
    ],
    
    "weekContext": {
      "availableDays": 7,
      "missingDays": [],
      "trend7d": {
        "mainTaskHours": [3.2, 2.5, 4.0, 3.5, 2.8, 2.9, 4.2],
        "focusRatio":    [0.60, 0.55, 0.68, 0.62, 0.58, 0.61, 0.72],
        "energyWaste":   [55, 60, 48, 52, 58, 53, 42],
        "switchRate":    [5.5, 7.2, 5.0, 6.0, 6.8, 6.3, 8.5],
        "fragmentRatio": [0.12, 0.18, 0.10, 0.14, 0.16, 0.13, 0.18]
      }
    },
    
    "worstDimension": {
      "name": "切换密度",
      "yesterday": 8.5,
      "weekMean": 6.1,
      "degradationPct": 39.3
    },
    
    "bestDimension": {
      "name": "能量浪费分",
      "yesterday": 42,
      "weekMean": 52,
      "improvementPct": 20.8
    },
    
    "hotspots": [
      {
        "rank": 1,
        "app": "WeChat",
        "title": "微信",
        "hitCount": 12,
        "totalDurationSec": 510,
        "avgDurationSec": 42,
        "verdict": "一天偷瞄 12 次微信，每次平均 42 秒。这就是 8 分半钟被切碎成 12 段。"
      },
      {
        "rank": 2,
        "app": "Chrome",
        "title": "Bilibili 首页 - ...",
        "hitCount": 7,
        "totalDurationSec": 312,
        "avgDurationSec": 45,
        "verdict": "7 次返回 B 站首页，平均每次 45 秒。说明在刷推荐流。"
      },
      {
        "rank": 3,
        "app": "Slack",
        "title": "xxx team",
        "hitCount": 5,
        "totalDurationSec": 240,
        "avgDurationSec": 48,
        "verdict": "5 次短暂查看 Slack，平均不到 1 分钟。"
      }
    ],
    
    "topTasks": [
      { "taskKey": "主任务:编程", "durationSec": 10800, "primaryApp": "VS Code" },
      { "taskKey": "主任务:写作", "durationSec": 2700, "primaryApp": "Notion" }
    ],
    
    "flowBlocks": {
      "count": 3,
      "totalMinutes": 110,
      "longestMinutes": 50
    },
    
    "notes": [
      "数据置信度：high",
      "本周主任务标签变化：前 3 天以「工作」为主，后 4 天切换到「编程」"
    ]
  }
}
```

### 5.2 字段优先级（LLM 必须看到的信号）

LLM 生成建议时，**最关键的 5 个信号**（按优先级）：

1. **`worstDimension`**：触发"乔布斯式"尖锐建议的核心信号
2. **`hotspots`**：具体的"砍掉这些诱惑"建议来源
3. **`bestDimension`**：用于正向反馈（乔布斯也会夸人）
4. **`signals[negative]`**：其他负向信号的补充上下文
5. **`primaryTaskLabel` + `topTasks`**：让建议落到具体行为上

### 5.3 推荐的 LLM Prompt 模板（参考）

```
你是乔布斯，正在给一位产品经理（欧总）写今日的专注力日报。

【数据简报】
{briefing JSON}

【输出要求】
1. 标题：用一句话总结昨日的最大特征（不超过 20 字）
2. 一针见血（≤ 80 字）：基于 worstDimension，给出尖锐但建设性的观察。乔布斯风格：直接、不留情面、但指出方向。
3. 今日聚焦（3 条）：
   - 一条针对 worstDimension 的具体改进建议
   - 一条针对 hotspots 的"砍掉诱惑"指令（要具体到 app 名）
   - 一条针对 bestDimension 的"保持这个"肯定
4. 数据卡片：把 briefing 里的 5 维数据和趋势条原样呈现

【约束】
- 不要客套话
- 不要罗列所有数据
- 永远从 worstDimension 切入
- 每条建议都要可立即执行（"今天上午 9 点开始 X" 而不是"你应该 X"）
```

---

## 6. 实现检查清单（@developer 用）

### 6.1 实现路径建议

```
focus/
├── cron/
│   ├── dailyReport.ts           # 主入口：07:00 触发
│   ├── aggregator.ts            # 本文档 §2 的所有算法
│   ├── sparkline.ts             # 本文档 §3 的渲染
│   ├── hotspots.ts              # 本文档 §2.7
│   ├── briefing.ts              # 本文档 §5 的 schema 构建
│   ├── llmClient.ts             # glm-5.1 调用 + §4.3 降级
│   └── feishuCard.ts            # 飞书消息卡片渲染
└── docs/
    └── AGGREGATION_ALGORITHM.md  # 本文档
```

### 6.2 30 分钟落地步骤

| 步骤 | 时长 | 产出 |
|------|------|------|
| 1. 实现 §2.4 `computeDimensions` | 5 min | 输入 metrics → 输出 5 维对象 |
| 2. 实现 §2.5 `buildWeekStats` + §3 `renderSparkline` | 8 min | 7 天均值 + 趋势条 |
| 3. 实现 §2.6 `buildDelta` + `formatDeltaText` | 5 min | 同比环比对象 |
| 4. 实现 §2.7 `detectHotspots` | 5 min | top 3 诱惑窗口 |
| 5. 实现 §2.8 `identifyWorstDimension` | 3 min | 最差维度 |
| 6. 实现 §5.1 `buildLLMBriefing` | 3 min | LLM 数据简报 |
| 7. 串联 + §4 兜底 | 1 min | 主流程 |

### 6.3 单元测试必覆盖

- [ ] 全 0 输入 → sparkline = `▁▁▁▁▁▁▁`
- [ ] 全相同非 0 输入 → sparkline = `▄▄▄▄▄▄▄`
- [ ] 含 missing 日 → 该位为 `·`
- [ ] outlier 检测：`[1, 1, 1, 1, 1, 1, 100]` → `▁▁▁▁▁▁█`
- [ ] 5 维方向的 `isGood` 判定：mainTaskHours↑good / energyWaste↓good
- [ ] worstDimension 优先级：degradationPct 大但量级小的，不应排第一
- [ ] hotspots：`hitCount < 2` 的不入选
- [ ] LLM 失败 → 降级输出纯数据版

### 6.4 关键魔数表

```js
const CONFIG = {
  SHORT_STAY_THRESHOLD_SEC: 90,     // §2.7 短停留阈值（与后端 shortSwitchMaxMinutes 解耦）
  HOTSPOT_MIN_HIT_COUNT: 2,         // §2.7 最少命中次数
  HOTSPOT_MIN_DURATION_SEC: 2,      // §2.7 最短段长（过滤噪声）
  HOTSPOT_TITLE_MAX_LEN: 40,        // §2.7 title 截断
  SPARKLINE_MISSING_CHAR: "·",      // §3.3 缺数据占位
  SPARKLINE_FLAT_CHAR: "▄",         // §3.3 全相同占位（中位）
  DATA_QUALITY_THRESHOLD: 0.4,      // §4.4 低数据兜底阈值（okRatio < 0.4）
  DELTA_FLAT_THRESHOLD_PCT: 0.5,    // §2.6 平局阈值（|pct| < 0.5% 算 →）
  DIMENSION_BASELINE: {              // §2.8 量级基线（可调）
    mainTaskHours: 4.0,
    focusRatio:    0.6,
    energyWaste:   50,
    switchRate:    5.0,
    fragmentRatio: 0.15
  }
}
```

---

## 7. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-06-07 | 初稿。基于 server/summary.ts 和 shared/metrics.ts 实测契约设计。 |

---

## 附录 A：维度选择的心智模型

为什么是这 5 个维度？逻辑链：

```
总量层     → D1 主任务投入 (mainTaskHours)        我做了多少正事？
                ↓
结构层     → D2 专注占比 (focusRatio)             正事占活跃时间多少？
           → D5 碎片化占比 (fragmentRatio)        噪声时间占多少？
                ↓
质量层     → D3 能量浪费分 (energyWaste)          综合行为质量
                ↓
稳定层     → D4 切换密度 (switchRate)             注意力是否稳定？
```

不选 `recoveryCostMin` 单独成维：因为它 = `switchCount × 1.5`，与 D4 高度共线。
不选 `frequentWindows` 单独成维：因为它已进入 D3 的 35% 权重。
不选 `shortStayCount` 单独成维：用 D5 的"占比"更可比（绝对次数受总时长影响）。

## 附录 B：飞书卡片最终效果参考

```
┌────────────────────────────────────────────────────────┐
│ 📊 欧总｜2026-06-06（周三）专注力日报                    │
│ 主任务标签：编程                                         │
├────────────────────────────────────────────────────────┤
│ 🎯 一针见血                                              │
│ 主任务时长是好的（4.2h），但你一天切了 60 次有效切换。   │
│ 这不是「忙」，是「被切碎」。深度工作做不出。             │
├────────────────────────────────────────────────────────┤
│ 📈 五维数据                                              │
│                                                         │
│ 主任务投入  4h 12m ↑ +0.4h   ▃▅▆▄▇▆▇   均值 3.0h       │
│ 专注占比    72%   ↑ +7pp     ▃▄▅▆▇▆▇   均值 65%        │
│ 能量浪费分  42    ↓ -10 ✓    ▇▆▅▆▄▃▂   均值 52         │
│ 切换密度    8.5   ↑ +2.4 ⚠   ▂▃▄▃▅▆▇   均值 6.1 次/h   │
│ 碎片化占比  18%   ↑ +4pp     ▂▃▂▄▅▄▆   均值 14%        │
│                                                         │
│ 数据置信度：high｜有效数据：7/7 天                       │
├────────────────────────────────────────────────────────┤
│ 🪓 今日聚焦                                              │
│ 1. ⚠️ 切换密度飙升 → 上午 9-11 点关掉所有 IM 通知        │
│ 2. 🪓 微信被偷瞄 12 次 → 全屏模式 + 微信退登             │
│ 3. ✅ 能量浪费分低 → 保持昨天的工作节奏                  │
├────────────────────────────────────────────────────────┤
│ 💧 心流：3 块 / 共 1h 50m / 最长 50m                     │
│ ⏱️ 活跃时长：7h 12m                                      │
└────────────────────────────────────────────────────────┘
```

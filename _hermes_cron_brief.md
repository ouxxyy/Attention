# 专注力日报 Cron 任务 — 任务简报

> 本文档是 @prompt-engineer 和 @developer 共享的任务背景，避免重复探索。

## 一、任务目标

每天 07:00 拉取欧总本地专注力仪表盘（http://localhost:8787）的 7 天数据，由 glm-5.1 生成改进建议，推送到飞书私聊。

## 二、欧总画像（写 prompt 时参考）

- 产品经理，心理学专业背景
- 内容创作者：公众号（健康/科技）+ AI 视频短片（赛博朋克风格）
- 工具栈：可灵 Kling、Hermes Agent、ChatGPT、Tabbit、TickTick
- **建议风格要求**：数据冷静派——直说哪里差，不要鸡汤，不要彩虹屁；每条建议必须**具体可执行**（不要"少刷手机"这种废话）

## 三、数据接口

唯一接口：`GET http://localhost:8787/api/summary?date=YYYY-MM-DD`

返回 JSON，关键字段：

```json
{
  "date": "2026-06-06",
  "dataSufficiency": { "status": "ok", "rawEventCount": 1551, "normalizedSegmentCount": 344, "activeTimeSec": 12286.93 },
  "metrics": {
    "activeTimeSec": 12286.93,        // 活跃总时长（秒）
    "switchCount": 327,                // 总切换次数
    "meaningfulSwitchCount": 32,       // 有意义切换（跨任务）
    "shortStayCount": 322,             // 短停留次数（被切断）
    "shortStayTimeSec": 6686.62,       // 短停留总耗时
    "frequentWindows": 2,              // 频繁被打断窗口
    "mainTaskTimeSec": 8541.30,        // 主任务时长
    "primaryMainTaskLabel": "工作",    // 主要任务标签
    "deviationRatio": 0.3048,          // 偏离率（0-1，越低越好）
    "recoveryCostMin": 48,             // 恢复成本（分钟）
    "componentScores": {
      "frequentSwitchScore": 100,      // 频繁切换分（0-100，越高越好）
      "shortStayScore": 54.42,         // 短停留分
      "deviationScore": 30,            // 偏离分
      "recoveryScore": 80              // 恢复分
    },
    "energyWasteScore": 68,            // 能量浪费综合分（0-100，越低越好）
  },
  "topTasks": [                        // Top 3 主任务及组成
    {
      "taskKey": "主任务:工作",
      "title": "工作",
      "durationSec": 5450.61,
      "mergedItems": [
        {"app": "Hermes", "title": "Hermes", "durationSec": 1258.11},
        {"app": "ChatGPT", "title": "专注力仪表盘", "durationSec": 575.22}
      ]
    }
  ],
  "flowBlocks": []                     // 心流时段（≥25分钟连续无切换）
}
```

## 四、5 大核心指标定义

| 指标 | 字段 | 含义 | 健康方向 |
|---|---|---|---|
| 活跃时长 | `metrics.activeTimeSec` | 当天鼠标/键盘有交互的总时长 | 持平/稳步上升 |
| 主任务占比 | `mainTaskTimeSec / activeTimeSec` | 在主任务上的时长占比 | ≥ 70% 为佳 |
| 能量浪费分 | `metrics.energyWasteScore` | 综合分（短停留+偏离+频繁切换） | ≤ 30 为佳 |
| 切换次数 | `metrics.meaningfulSwitchCount` | 有意义的跨任务切换 | 因任务性质而异 |
| 恢复成本 | `metrics.recoveryCostMin` | 被打断后恢复所需总分钟数 | ≤ 20min 为佳 |

## 五、推送格式（飞书 Markdown）

```markdown
📊 专注力日报 | 2026-06-07 周日

📍 今日聚焦
（基于昨日偏离点，1-2 句话给今日方向）

📍 改进建议
1. （具体可执行的建议，结合昨日数据）
2. ...
3. ...

📍 昨日核心指标（06-06 周六）
⏱ 活跃时长    3h 24min    ▁▂▃▅▆▆▅
🎯 主任务占比  70%         ▂▃▅▆▆▆▇
⚡ 浪费分     68 ⚠️       ▇▆▅▆▇▆▅
🔀 切换次数   32 次       ▃▅▇▆▇▅▆
🔄 恢复成本   48 min      ▁▂▃▄▅▅▆

📍 7天均值
活跃 3.5h | 主任务 75% | 浪费分 62 | 切换 28 | 恢复 35min

数据源：本地专注力仪表盘 http://localhost:8787
```

## 六、推送渠道

- 飞书私聊：`feishu:oc_d5722221af3793cf53d9c191cf21fd1b`
- 使用 Hermes cronjob 工具的 deliver 字段

## 七、容错要求

1. **dashboard 挂了**：脚本探测 HTTP 5xx 或连接超时 → 推送「⚠️ 数据源异常」提醒，不让 cron 静默失败
2. **LLM 失败兜底**：glm-5.1 调用失败 → 降级输出纯数据版简报（不带建议）+ 标红警告
3. **数据不足**：某天 rawEventCount < 100 → 标记为「数据稀疏日」，不参与 7 天均值计算

## 八、LLM 配置

- Provider: `zai`
- Model: `glm-5.1`（cron 硬规则：用户明确指定，覆盖默认 gpt-5.3-codex）
- 调用方式：在 cron 内通过 HTTP 直接调（避免依赖 execute_code 之外的 Python 包）

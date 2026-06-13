# Focus Dashboard

本地专注力仪表盘。从 ActivityWatch 采集桌面行为数据，计算“有没有换到别的事”“分心程度”“连续专注段”等指标，在网页端呈现每日报告和趋势。

## 前置条件

| 服务 | 地址 | 说明 |
|------|------|------|
| ActivityWatch | `http://localhost:5600/api/0` | 桌面行为采集，需提前启动 |
| Express 后端 | `http://localhost:8787` | `npm run server:dev` |
| Vite 前端 | `http://localhost:5173` | `npm run client:dev`，代理 `/api` 到 8787 |

Node >= 18。

## 快速启动

```bash
npm install
npm run dev
```

`npm run dev` 用 concurrently 同时拉起后端和前端，打开 `http://localhost:5173` 即可。

## npm scripts

| 命令 | 作用 |
|------|------|
| `npm run dev` | concurrently 启动 server + client |
| `npm run server:dev` | tsx watch 启动后端（端口 8787） |
| `npm run client:dev` | Vite 开发服务器（端口 5173） |
| `npm test` | vitest watch 模式 |
| `npm run test:run` | vitest 单次运行 |

## 项目结构

```
server/
  index.ts          Express 入口，端口 8787
  routes.ts         API 路由定义
  activitywatch.ts  ActivityWatch API 客户端
  storage.ts        data/ 目录读写，校验
  summary.ts        日汇总 & 趋势构建
shared/
  metrics.ts        核心指标计算
  normalize.ts      事件归一化（心跳展开、web 叠加、去重、合并）
  schema.ts         JSON 校验
  types.ts          类型定义
  defaults.ts       默认配置 & 空评分
client/
  src/App.tsx       单页仪表盘（React）
  src/api.ts        前端 API 封装
data/
  config.json       运行时配置（阈值、关键词、通知）
  ratings.json      每日主观评分
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | ActivityWatch 连接状态 + bucket 列表 |
| GET | `/api/buckets` | 发现并按类型分组 bucket |
| GET | `/api/events?date=YYYY-MM-DD` | 当天原始事件 |
| GET | `/api/summary?date=YYYY-MM-DD` | 当天汇总（指标 + 连续专注段 + 时间线） |
| GET | `/api/trends?days=N&end=YYYY-MM-DD` | 多日趋势（默认 days=7） |
| GET | `/api/config` | 读取配置 |
| PUT | `/api/config` | 更新配置 |
| GET | `/api/ratings` | 读取全部评分 |
| PUT | `/api/ratings/:date` | 写入某日评分（1-5 分 + 可选备注） |

## 持久化

配置和评分存放在 `data/` 目录：

- `data/config.json` — 阈值、关键词规则、通知开关。首次启动自动生成默认值。
- `data/ratings.json` — 每日评分，格式 `{ ratings: { "YYYY-MM-DD": { score, note, updatedAt } } }`。

两个文件都经过 schema 校验，PUT 写入失败会返回 400 + 具体错误信息。

`data/*.json` 会包含本机 ActivityWatch hostname 和个人评分备注，默认已在 `.gitignore` 中排除。开源或部署时可参考 `data/config.example.json` 与 `data/ratings.example.json`。

## 界面主题

前端支持系统级浅色/深色模式（`prefers-color-scheme`），不需要额外配置。

## 核心指标公式

### switchCount（窗口/网页跳动记录）与 meaningfulSwitchCount（换到另一件事）

遍历排序后的时间片段，相邻片段 taskKey 不同且间隔 <= 300 秒时计一次切换。

`rawSwitchCount` 保留上述原始窗口/网页跳动记录；`meaningfulSwitchCount` 会先按“我的主要事情”聚合，再过滤任一侧时长低于 15 秒的小抖动，作为分心分的主要输入。例如 Codex、opencode、VS Code 都命中“编码”时，它们之间的切换仍算同一件事。

### shortStayCount（很快离开的记录数）

时间片段持续时长 <= `shortSwitchMaxMinutes * 60`（默认 120 秒）的片段个数。

### frequentWindows（频繁切换窗口数）

滑动窗口：窗口宽度 = `frequentSwitchWindowMinutes`（默认 15 分钟），窗口内切换次数 >= `frequentSwitchCount`（默认 6）时计一个频繁窗口。

### energyWasteScore（分心程度分）

0-100 分，加权合成：

```
energyWasteScore = round(
  0.35 × frequentSwitchScore +
  0.25 × shortStayScore +
  0.25 × deviationScore +
  0.15 × recoveryScore
)
```

各子分计算：

| 子分 | 公式 | 含义 |
|------|------|------|
| frequentSwitchScore | min(100, frequentWindows × 25 + meaningfulSwitchCount × 2) | 换到另一件事的影响 |
| shortStayScore | min(100, shortStayTimeSec × 100 / activeTimeSec) | 很快离开的时间占比 |
| deviationScore | 有主要事情命中时 round(deviationRatio × 100)，否则 0 并输出 scoringNotes | 不属于“我的主要事情”的时间占比 |
| recoveryScore | min(100, recoveryCostMin × 100 / 60) | 反复切回来带来的估算成本 |

recoveryCostMin = meaningfulSwitchCount × 1.5

deviationRatio = 1 - mainTaskTimeSec / activeTimeSec（mainTaskTime 通过“我的主要事情”匹配）

### flowBlock（连续专注段）

一段连续的同一任务时段，满足：
- 活跃时长 >= `flowMinMinutes`（默认 25 分钟）
- 容忍的打断次数 <= floor(活跃时长 / flowMinMinutes)
- 同一条“我的主要事情”下的多个应用会合并为同一件事
- 打断判定：不同事情片段持续 <= `shortSwitchMaxMinutes`（默认 2 分钟），且之后紧接同一件事（间隔 <= 60 秒）
- AFK 空隙 > `afkGraceMinutes`（默认 3 分钟）直接截断

### 数据完整度

基于 web 事件有 URL/domain 的占比：>= 70% 为 high，>= 30% 为 medium，否则 low。

## 默认阈值

```json
{
  "flowMinMinutes": 25,
  "shortSwitchMaxMinutes": 2,
  "frequentSwitchWindowMinutes": 15,
  "frequentSwitchCount": 6,
  "afkGraceMinutes": 3
}
```

可在 `data/config.json` 或通过 `PUT /api/config` 修改。

## ActivityWatch 数据假设

- 需要 `currentwindow`、`web.tab.current`、`afkstatus` 三类 bucket。
- 心跳事件（duration=0）会向后推断至下一个事件或最长 120 秒。
- Web 事件优先级高于窗口事件（重叠 >= 50% 时 web 覆盖窗口）。
- 相邻同 taskKey 片段间隔 <= 60 秒会自动合并。

## 测试

```bash
npm run test:run
```

测试覆盖归一化、指标计算、schema 校验。位于 `shared/__tests__/`。

## 故障排除

| 现象 | 检查项 |
|------|--------|
| 仪表盘显示 "ActivityWatch 不可用" | 确认 ActivityWatch 已启动，访问 http://localhost:5600/api/0/info 是否返回 JSON |
| /api/health 返回 503 | 后端连不上 ActivityWatch，检查端口和防火墙 |
| 当天数据为空 | 确认 ActivityWatch watcher 正在录制，检查 buckets 页面是否有当日事件 |
| 数据置信度 low | web watcher 未运行或浏览器插件缺失，仅窗口标题可用 |
| 分心程度分为 0 | 当天活跃时间不足或无切换行为 |
| PUT /api/config 返回 400 | 提交的 JSON 不符合 schema，查看返回的 details 字段 |
| 端口被占用 | 后端默认 8787，前端默认 5173，可在代码中修改 |

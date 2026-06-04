# AttentionBudget - Attention Budget Manager / 注意力预算管理器

Track every minute of your attention like bookkeeping. Gentle reminders instead of forced blocking — your focus, your choice.

像会计记账一样追踪每一分钟注意力，用柔性引导而非强制屏蔽帮助你专注。

---

## Features / 功能特性

- **Real-time Attention Tracking / 实时注意力追踪**: Automatically tracks tab switching and calculates attention cost. / 自动追踪标签页切换，计算注意力消耗。
- **Budget Visualization / 预算可视化**: Daily attention budget displayed in real-time, remaining time at a glance. / 每日注意力预算实时显示，剩余时间一目了然。
- **Gentle Intervention / 柔性干预**: Shows a friendly reminder before visiting distracting sites — you always keep the final say. / 访问分心网站前显示温馨提醒，保留用户选择权。
- **Focus Statistics / 专注统计**: Records focus sessions to help you discover your best working patterns. / 记录专注会话，发现个人最佳工作模式。
- **Full Privacy / 完全隐私**: All data stored locally. No account required. Works out of the box. / 所有数据存储在本地，无需账号，开箱即用。

---

## Prerequisites / 前置依赖

### ActivityWatch

This extension requires [ActivityWatch](https://github.com/ActivityWatch/activitywatch) to be installed and running in the background.

本插件需要先安装并运行 [ActivityWatch](https://github.com/ActivityWatch/activitywatch)。

**Why / 为什么需要**: ActivityWatch is an open-source time tracker that records which windows and applications you use. AttentionBudget reads this data to understand your actual attention patterns, instead of guessing from browser tabs alone. / ActivityWatch 是一个开源的时间追踪工具，记录你使用了哪些窗口和应用。AttentionBudget 通过读取它的数据来了解你真实的注意力模式，而不是仅靠浏览器标签页来猜测。

**Install / 安装**: Download from [activitywatch.net](https://activitywatch.net/) or `brew install activitywatch` on macOS.

---

## Installation (for Humans) / 安装指引（给人看）

1. **Install ActivityWatch** / **安装 ActivityWatch**: See prerequisites above. / 见上方前置依赖。

2. **Clone the repo** / **克隆仓库**:

   ```bash
   git clone https://github.com/ouxxyy/Attention.git
   cd Attention
   ```

3. **Install dependencies** / **安装依赖**:

   ```bash
   npm install
   ```

4. **Build the extension** / **构建扩展**:

   ```bash
   npm run build
   ```

5. **Load in Chrome** / **在 Chrome 中加载**:
   - Open `chrome://extensions/` / 打开 `chrome://extensions/`
   - Enable "Developer mode" / 开启「开发者模式」
   - Click "Load unpacked" / 点击「加载已解压的扩展程序」
   - Select the `dist` folder / 选择 `dist` 目录

---

## Installation (for AI Agents) / 安装指引（给 AI 看）

> Structured format optimized for AI parsing. / 结构化格式，便于 AI 解析。

```yaml
# AttentionBudget Setup Steps
project:
  name: attention-budget
  repo: https://github.com/ouxxyy/Attention.git
  type: chrome-extension-mv3

prerequisites:
  - name: ActivityWatch
    url: https://github.com/ActivityWatch/activitywatch
    reason: Reads window/application time-tracking data
    install:
      macos: brew install activitywatch
      linux: Download from https://activitywatch.net/
      windows: Download from https://activitywatch.net/
    verify: curl -s http://localhost:5600/api/0/info

setup:
  - action: clone
    command: git clone https://github.com/ouxxyy/Attention.git && cd Attention

  - action: install_deps
    command: npm install
    expected: exit 0, node_modules/ created

  - action: build
    command: npm run build
    expected: exit 0, dist/ created with manifest.json

  - action: load_extension
    description: Load dist/ folder as unpacked extension at chrome://extensions/
    requires: Developer mode enabled

  - action: verify
    description: Open extension popup, verify connection to ActivityWatch at localhost:5600
```

---

## Project Structure / 项目结构

```
src/
├── background/          # Service Worker / 后台服务
│   └── background.ts    # Core tracking logic / 核心追踪逻辑
├── content/             # Content Scripts / 内容脚本
│   ├── content.ts       # Intervention popup logic / 干预弹窗逻辑
│   └── content.css      # Popup styles / 弹窗样式
├── popup/               # Extension Popup / 插件弹出窗口
│   ├── popup.html       # UI interface / UI 界面
│   └── popup.ts         # Interaction logic / 交互逻辑
├── options/             # Settings Page / 设置页面
│   ├── options.html
│   └── options.ts
├── dashboard/           # Dashboard Page / 仪表盘页面
│   ├── dashboard.html
│   └── dashboard.ts
├── lib/                 # Utilities / 工具库
│   ├── constants.ts     # Constants / 常量定义
│   └── utils.ts         # Utility functions / 工具函数
├── types/               # Type Definitions / 类型定义
│   └── index.ts
├── icons/               # Icon Assets / 图标资源
└── manifest.json        # Extension Config / 扩展配置
```

---

## Core Concepts / 核心概念

### Attention Budget / 注意力预算

- Default daily budget: 480 minutes (8 hours) / 默认每日预算: 480 分钟 (8 小时)
- Switch cost per interruption: 23 minutes (research-backed) / 每次切换成本: 23 分钟 (基于研究数据)
- Warning triggered when remaining budget < 20% / 当剩余预算 < 20% 时显示警告

### Switch Cost / 切换成本

Research shows it takes ~23 minutes to fully regain focus after a task switch. This extension applies this as the attention cost for each interruption.

研究表明，每次任务切换后需要约 23 分钟才能完全恢复专注状态。本插件将此作为每次切换的注意力成本。

### Focus Sessions / 专注会话

Spending ≥ 25 minutes continuously on the same tab counts as one focus session.

连续在同一个标签页停留 ≥ 25 分钟，计为一次专注会话。

---

## Settings / 设置选项

- **Daily Attention Budget / 每日注意力预算**: Adjust based on your actual working hours. / 根据实际工作时长调整。
- **Switch Cost / 切换成本**: Customize attention cost per switch. / 可自定义每次切换的注意力消耗。
- **Intervention Mode / 干预模式**: All hours / Focus hours only. / 所有时段 / 仅专注时段。
- **Distracting Site List / 分心网站列表**: Customize which sites trigger intervention. / 自定义需要干预的网站。

---

## Development / 开发指引

```bash
# Dev mode (hot reload) / 开发模式 (热重载)
npm run dev

# Production build / 构建
npm run build

# Type check / 类型检查
npm run lint
```

---

## Privacy / 隐私说明

- All data stored locally via Chrome Storage. / 所有数据完全存储在本地 (Chrome Storage)。
- No data collected to any cloud. / 不收集任何用户数据到云端。
- No account registration required. / 不需要账号注册。
- One-click clear all data. / 支持一键清除所有数据。

---

## Tech Stack / 技术栈

- Chrome Extension Manifest V3
- TypeScript
- Vite + @crxjs/vite-plugin
- Chrome Storage API
- IndexedDB (via idb)

---

## License / 许可证

MIT License

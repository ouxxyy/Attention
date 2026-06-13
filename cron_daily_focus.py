#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cron_daily_focus.py — 欧总每日专注力日报. 拉7天数据 → GLM-5.1 → 飞书. 纯 stdlib, 单文件.

Usage:
    python3 cron_daily_focus.py                       # live, pushes to Feishu
    python3 cron_daily_focus.py --dry-run             # build + print, skip push
    python3 cron_daily_focus.py --date 2026-06-06     # override "yesterday"
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, traceback
import urllib.error, urllib.request
from pathlib import Path

# Bypass any system / env HTTP proxy (broken 127.0.0.1:7890 shadow proxy on this host).
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
urllib.request.install_opener(_NO_PROXY_OPENER)

DASHBOARD = "http://localhost:8787/api/summary"
LLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
LLM_MODEL, FEISHU_TARGET = "glm-5.1", "feishu:oc_d5722221af3793cf53d9c191cf21fd1b"
PROMPT_FILE = "/Users/apple/Desktop/01_ActiveProjects/focus/_hermes_prompt.md"
ENV_FILE = os.path.expanduser("~/.hermes/.env")
BARS = "▁▂▃▄▅▆▇█"
WK_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
KEYS = ("active_h", "main_ratio_pct", "energy_waste", "switch_count", "recovery_min")
FALLBACK_SYS = ("你是专注力数据复述员。仅根据用户输入的 JSON 数据原样复述 5 大核心指标和 7 天均值，"
                "不生成任何建议、不做解释。输出格式严格遵守用户消息中的模板。")


def load_env():
    try:
        for line in Path(ENV_FILE).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except Exception:
        pass


def http_get(url, timeout=5):
    req = urllib.request.Request(url, headers={"User-Agent": "cron-daily-focus/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def fetch_summary(d):
    return json.loads(http_get(f"{DASHBOARD}?date={d}", timeout=5))


def load_system_prompt():
    try:
        text = Path(PROMPT_FILE).read_text(encoding="utf-8")
        m = (re.search(r"##\s*一、\s*System Prompt.*?```text\s*\n(.*?)```", text, re.DOTALL)
             or re.search(r"```text\s*\n(.*?)```", text, re.DOTALL))
        if m:
            return m.group(1).strip()
    except Exception as e:
        sys.stderr.write(f"[warn] load_system_prompt failed: {e}\n")
    return FALLBACK_SYS


def date_range(end_iso, n):
    d = dt.date.fromisoformat(end_iso)
    return [(d - dt.timedelta(days=n - 1 - i)).isoformat() for i in range(n)]


def metric_of(s):
    if not s:
        return None
    m = s.get("metrics", {}) or {}
    active = m.get("activeTimeSec") or 0
    main = m.get("mainTaskTimeSec") or 0
    return {
        "active_h": active / 3600.0,
        "main_ratio_pct": (main / active * 100) if active > 0 else 0.0,
        "energy_waste": m.get("energyWasteScore"),
        "switch_count": m.get("meaningfulSwitchCount"),
        "recovery_min": m.get("recoveryCostMin"),
    }


def aggregate(mlist, sparse):
    valid = [m for m, s in zip(mlist, sparse) if m and not s]
    if not valid:
        return None
    out = {}
    for k in KEYS:
        vs = [v[k] for v in valid if v.get(k) is not None]
        out[k] = (sum(vs) / len(vs)) if vs else None
    return out


def trend_bars(mlist, sparse):
    bars = {}
    for k in KEYS:
        vals = [(m[k] if m else None) for m in mlist]
        numeric = [v for v, s in zip(vals, sparse) if not s and v is not None]
        if not numeric:
            bars[k] = "·" * len(vals); continue
        lo, hi, span = min(numeric), max(numeric), max(numeric) - min(numeric)
        chars = []
        for v, s in zip(vals, sparse):
            if s or v is None:
                chars.append("·")
            elif span == 0:
                chars.append(BARS[3])
            else:
                chars.append(BARS[int(round((v - lo) / span * (len(BARS) - 1)))])
        bars[k] = "".join(chars)
    return bars


def build_user_prompt(y_iso, summaries, means, bars, sparse, dates):
    ysum = next((s for s in summaries if s and s.get("date") == y_iso), None)
    slim_top, ym, flow_count = [], {}, 0
    if ysum:
        for t in (ysum.get("topTasks") or [])[:5]:
            slim_top.append({"taskKey": t.get("taskKey"), "title": t.get("title"),
                             "durationSec": round(t.get("durationSec", 0) or 0, 1)})
        ym = ysum.get("metrics", {}) or {}
        flow_count = len(ysum.get("flowBlocks") or [])
    active = ym.get("activeTimeSec") or 0
    today = (dt.date.fromisoformat(y_iso) + dt.timedelta(days=1)).isoformat()
    payload = {
        "today": today, "yesterday": y_iso,
        "yesterday_metrics": {
            "activeTimeSec": ym.get("activeTimeSec"),
            "mainTaskTimeSec": ym.get("mainTaskTimeSec"),
            "mainRatioPct": round((ym.get("mainTaskTimeSec", 0) / active) * 100, 1) if active else None,
            "energyWasteScore": ym.get("energyWasteScore"),
            "meaningfulSwitchCount": ym.get("meaningfulSwitchCount"),
            "shortStayCount": ym.get("shortStayCount"),
            "frequentWindows": ym.get("frequentWindows"),
            "recoveryCostMin": ym.get("recoveryCostMin"),
        },
        "yesterday_topTasks": slim_top,
        "yesterday_flowBlocks_count": flow_count,
        "seven_day_means": means, "trend_bars_7d": bars,
        "sparse_days": [d for d, s in zip(dates, sparse) if s],
    }
    today_wk = WK_CN[dt.date.fromisoformat(today).weekday()]
    return (f"请基于以下结构化数据生成欧总今日（{today} {today_wk}）的飞书专注力日报。\n"
            "严格按 system prompt 中的「输出契约」输出完整 Markdown。\n\n"
            "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```\n\n"
            "现在直接输出日报：")


def call_llm(sys_prompt, user_prompt, api_key, timeout=30):
    body = json.dumps({
        "model": LLM_MODEL,
        "messages": [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": user_prompt}],
        "temperature": 0.3,
    }).encode("utf-8")
    req = urllib.request.Request(
        LLM_URL, data=body,
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json",
                 "User-Agent": "cron-daily-focus/1.0"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))["choices"][0]["message"]["content"]


def fmt_active(hours):
    if hours is None:
        return "—"
    h = int(hours); m = int(round((hours - h) * 60))
    return f"{h}h {m:02d}min"


def build_markdown(y_iso, means, bars, ym, llm_out, llm_ok, sparse_y, llm_err):
    today = (dt.date.fromisoformat(y_iso) + dt.timedelta(days=1)).isoformat()
    today_wk, yest_wk = WK_CN[dt.date.fromisoformat(today).weekday()], WK_CN[dt.date.fromisoformat(y_iso).weekday()]
    focus, suggest = None, None
    if llm_out:
        m = re.search(r"📍\s*今日聚焦\s*\n+(.*?)\n+📍\s*改进建议\s*\n+(.*?)(?:\n+📍|\Z)",
                      llm_out, re.DOTALL)
        if m:
            focus, suggest = m.group(1).strip(), m.group(2).strip()
    if focus is None:
        focus = ("⚠️ 昨日数据稀疏，今日请保持仪表盘运行" if sparse_y
                 else (f"⚠️ LLM 调用失败，以下为纯数据简报（{llm_err or '未知错误'}）" if not llm_ok
                       else "（LLM 输出解析失败，原始输出见末尾附录）"))
    if suggest is None:
        suggest = "—（无可用建议）"

    m = ym or {}
    active = m.get("activeTimeSec") or 0
    main = m.get("mainTaskTimeSec") or 0
    ratio = (main / active * 100) if active > 0 else 0
    waste = m.get("energyWasteScore")
    sw = m.get("meaningfulSwitchCount")
    rec = m.get("recoveryCostMin")
    waste_warn = " ⚠️" if (waste is not None and waste > 30) else ""
    w = lambda k: bars.get(k, "·" * 7)

    metrics_block = (
        f"⏱ 活跃时长    {fmt_active(active / 3600.0 if active else None)}    {w('active_h')}\n"
        f"🎯 主任务占比  {ratio:.0f}%           {w('main_ratio_pct')}\n"
        f"⚡ 浪费分     {waste if waste is not None else '—'}{waste_warn}          {w('energy_waste')}\n"
        f"🔀 切换次数   {sw if sw is not None else '—'} 次         {w('switch_count')}\n"
        f"🔄 恢复成本   {rec if rec is not None else '—'} min        {w('recovery_min')}"
    )
    if means:
        means_line = (
            f"活跃 {means['active_h']:.1f}h | 主任务 {means['main_ratio_pct']:.0f}% | "
            f"浪费分 {means['energy_waste']:.0f} | 切换 {means['switch_count']:.0f} | "
            f"恢复 {means['recovery_min']:.0f}min")
    else:
        means_line = "⚠️ 近 7 天无有效数据"

    md = [f"📊 专注力日报 | {today} {today_wk}", "",
          "📍 今日聚焦", focus, "",
          "📍 改进建议", suggest, "",
          f"📍 昨日核心指标（{y_iso[5:]} {yest_wk}）", metrics_block, "",
          "📍 7天均值", means_line, "",
          "数据源：本地专注力仪表盘 http://localhost:8787"]
    if llm_ok and llm_out and focus is None:
        md += ["", "— LLM 原始输出（附录）—", llm_out.strip()]
    return "\n".join(md)


def push_feishu(md):
    subprocess.run(["hermes", "send", "--target", FEISHU_TARGET, "--message", md],
                   check=True, timeout=30)


def main():
    ap = argparse.ArgumentParser(description="Daily focus report → Feishu")
    ap.add_argument("--date", help="Override 'yesterday' (YYYY-MM-DD)")
    ap.add_argument("--dry-run", action="store_true", help="Print MD, skip push")
    args = ap.parse_args()
    load_env()
    api_key = os.environ.get("ZAI_API_KEY", "")
    yesterday = args.date or (dt.date.today() - dt.timedelta(days=1)).isoformat()
    try:
        dt.date.fromisoformat(yesterday)
    except ValueError:
        sys.stderr.write(f"Invalid date: {yesterday}\n"); sys.exit(2)

    dates = date_range(yesterday, 7)
    summaries, sparse_flags, fetch_errs = [], [], []
    for d in dates:
        try:
            s = fetch_summary(d)
            summaries.append(s)
            raw = (s.get("dataSufficiency") or {}).get("rawEventCount", 0) or 0
            sparse_flags.append(raw < 100)
        except Exception as e:
            fetch_errs.append((d, str(e)))
            summaries.append(None)
            sparse_flags.append(True)

    if all(s is None for s in summaries):
        msg = ("⚠️ 专注力日报：数据源异常\n\n"
               f"无法从 {DASHBOARD} 获取任何数据（最近 7 天全部失败）。\n\n"
               "详情：\n" + "\n".join(f"- {d}: {e}" for d, e in fetch_errs))
        if args.dry_run:
            print(msg); return
        try:
            push_feishu(msg)
        except Exception:
            sys.stderr.write("Feishu push also failed:\n" + traceback.format_exc())
        return

    mlist = [metric_of(s) for s in summaries]
    means = aggregate(mlist, sparse_flags)
    bars = trend_bars(mlist, sparse_flags)
    ysum = next((s for s in summaries if s and s.get("date") == yesterday), None)
    ym = (ysum.get("metrics") or {}) if ysum else {}
    sparse_y = (ysum is None) or ((ysum.get("dataSufficiency") or {}).get("rawEventCount", 0) < 100)

    llm_out, llm_ok, llm_err = None, False, None
    if not api_key:
        llm_err = "ZAI_API_KEY not set"
    else:
        try:
            llm_out = call_llm(load_system_prompt(),
                               build_user_prompt(yesterday, summaries, means, bars, sparse_flags, dates),
                               api_key)
            llm_ok = True
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            llm_err = f"HTTP {e.code}: {body}"
        except Exception as e:
            llm_err = f"{type(e).__name__}: {e}"
        if not llm_ok:
            sys.stderr.write(f"[warn] LLM call failed: {llm_err}\n")

    md = build_markdown(yesterday, means, bars, ym, llm_out, llm_ok, sparse_y, llm_err)
    if args.dry_run:
        print(md); return
    try:
        push_feishu(md)
    except Exception:
        sys.stderr.write("Feishu push failed:\n" + traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        msg = f"⚠️ 专注力日报 cron 异常崩溃\n\n{e}\n\n{traceback.format_exc()}"
        sys.stderr.write(msg + "\n")
        if "--dry-run" in sys.argv:
            print(msg)
        else:
            try:
                push_feishu(msg)
            except Exception:
                pass
        sys.exit(1)

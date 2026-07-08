import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import request

import akshare as ak


ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"
OUTPUT_FILE = DOCS_DIR / "source-status.json"

TUSHARE_ENDPOINT = os.getenv("TUSHARE_ENDPOINT") or "https://api.tushare.pro"
TUSHARE_TOKEN = (os.getenv("TUSHARE_TOKEN") or "").strip()

MAIN_BOARD_RE = re.compile(r"^(600|601|603|605|000|001|002)")


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def as_float(value):
    try:
        if value is None or value == "":
            return None
        parsed = float(value)
        if parsed != parsed:
            return None
        return parsed
    except Exception:
        return None


def as_text(value):
    if value is None:
        return ""
    return str(value)


def provider_failed(name, error):
    return {
        "provider": name,
        "status": "failed",
        "errorCode": getattr(error, "code", "provider_error"),
        "error": str(error),
    }


def has_st_name(name):
    value = as_text(name).upper()
    return "ST" in value or "*ST" in value or "退" in value


def find_col(columns, candidates):
    for candidate in candidates:
        if candidate in columns:
            return candidate
    return None


def probe_akshare_spot():
    df = ak.stock_zh_a_spot_em()
    columns = list(df.columns)
    code_col = find_col(columns, ["代码", "code"])
    name_col = find_col(columns, ["名称", "name"])
    price_col = find_col(columns, ["最新价", "最新价格", "price"])
    pct_col = find_col(columns, ["涨跌幅", "change_percent"])
    turnover_col = find_col(columns, ["换手率"])
    amount_col = find_col(columns, ["成交额"])
    pe_dynamic_col = find_col(columns, ["市盈率-动态", "市盈率"])
    pe_ttm_col = find_col(columns, ["市盈率TTM", "市盈率-TTM", "市盈率(ttm)", "市盈率 TTM"])

    if not code_col or not name_col:
        raise RuntimeError(f"AKShare spot missing code/name columns: {columns}")

    codes = df[code_col].astype(str).str.zfill(6)
    names = df[name_col].astype(str)
    main_mask = codes.str.match(MAIN_BOARD_RE)
    ordinary_mask = main_mask & ~names.map(has_st_name)
    price_series = df[price_col].map(as_float) if price_col else None
    pct_series = df[pct_col].map(as_float) if pct_col else None

    if price_series is not None and pct_series is not None:
        price_pct_mask = (
            ordinary_mask
            & price_series.notna()
            & pct_series.notna()
            & (price_series < 30)
            & (pct_series >= 2)
            & (pct_series <= 5)
        )
        price_pct_count = int(price_pct_mask.sum())
    else:
        price_pct_count = 0

    sample_rows = []
    for _, row in df.head(5).iterrows():
        sample_rows.append(
            {
                "code": as_text(row.get(code_col)).zfill(6),
                "name": as_text(row.get(name_col)),
                "price": as_float(row.get(price_col)) if price_col else None,
                "pctChange": as_float(row.get(pct_col)) if pct_col else None,
                "turnoverRate": as_float(row.get(turnover_col)) if turnover_col else None,
                "amount": as_float(row.get(amount_col)) if amount_col else None,
                "peDynamic": as_float(row.get(pe_dynamic_col)) if pe_dynamic_col else None,
                "peTtm": as_float(row.get(pe_ttm_col)) if pe_ttm_col else None,
            }
        )

    return {
        "provider": "akshare.stock_zh_a_spot_em",
        "status": "ready",
        "docs": "https://akshare.akfamily.xyz/data/stock/stock.html",
        "totalRows": int(len(df)),
        "columns": columns,
        "mainBoardCount": int(main_mask.sum()),
        "ordinaryMainBoardCount": int(ordinary_mask.sum()),
        "pricePctCount": price_pct_count,
        "fields": {
            "code": code_col,
            "name": name_col,
            "price": price_col,
            "pctChange": pct_col,
            "turnoverRate": turnover_col,
            "amount": amount_col,
            "peDynamic": pe_dynamic_col,
            "peTtm": pe_ttm_col,
        },
        "sampleRows": sample_rows,
    }


def probe_akshare_kline(symbol, period):
    df = ak.stock_zh_a_hist(
        symbol=symbol,
        period=period,
        start_date="20240101",
        end_date="20500101",
        adjust="qfq",
    )
    if df is None or df.empty:
        raise RuntimeError(f"AKShare hist returned empty rows: symbol={symbol}, period={period}")
    columns = list(df.columns)
    latest = df.iloc[-1].to_dict()
    return {
        "provider": f"akshare.stock_zh_a_hist.{period}",
        "status": "ready",
        "docs": "https://akshare.akfamily.xyz/data/stock/stock.html",
        "symbol": symbol,
        "period": period,
        "count": int(len(df)),
        "columns": columns,
        "latest": {
            "date": as_text(latest.get("日期")),
            "open": as_float(latest.get("开盘")),
            "close": as_float(latest.get("收盘")),
            "high": as_float(latest.get("最高")),
            "low": as_float(latest.get("最低")),
            "volume": as_float(latest.get("成交量")),
            "amount": as_float(latest.get("成交额")),
            "pctChange": as_float(latest.get("涨跌幅")),
            "turnoverRate": as_float(latest.get("换手率")),
        },
    }


def rows_from_tushare(data):
    fields = data.get("fields") or []
    items = data.get("items") or []
    return [dict(zip(fields, item)) for item in items]


def probe_ths_hot():
    if not TUSHARE_TOKEN:
        raise RuntimeError("TUSHARE_TOKEN is not configured in GitHub Secrets.")
    payload = {
        "api_name": "ths_hot",
        "token": TUSHARE_TOKEN,
        "params": {"market": "热股", "is_new": "Y"},
        "fields": "trade_date,data_type,ts_code,ts_name,rank,pct_change,current_price,concept,hot,rank_time",
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        TUSHARE_ENDPOINT,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=35) as response:
        result = json.loads(response.read().decode("utf-8"))
    if result.get("code") != 0:
        raise RuntimeError(result.get("msg") or "Tushare ths_hot failed.")
    rows = rows_from_tushare(result.get("data") or {})
    if not rows:
        raise RuntimeError("Tushare ths_hot returned empty rows.")
    return {
        "provider": "tushare.ths_hot",
        "status": "ready",
        "docs": "https://tushare.pro/wctapi/documents/320.md",
        "count": len(rows),
        "top200Count": sum(1 for row in rows if as_float(row.get("rank")) is not None and as_float(row.get("rank")) <= 200),
        "latestRankTime": sorted([as_text(row.get("rank_time")) for row in rows if row.get("rank_time")])[-1]
        if any(row.get("rank_time") for row in rows)
        else None,
        "sampleRows": [
            {
                "ts_code": row.get("ts_code"),
                "ts_name": row.get("ts_name"),
                "rank": as_float(row.get("rank")),
                "pct_change": as_float(row.get("pct_change")),
                "current_price": as_float(row.get("current_price")),
                "hot": as_float(row.get("hot")),
                "rank_time": row.get("rank_time"),
            }
            for row in rows[:5]
        ],
    }


def capture(providers, key, fn, attempts=3):
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            providers[key] = fn()
            return
        except Exception as error:
            last_error = error
            if attempt < attempts:
                time.sleep(2 * attempt)
    providers[key] = provider_failed(key, last_error)


def capture_once(providers, key, fn):
    try:
        providers[key] = fn()
    except Exception as error:
        providers[key] = provider_failed(key, error)


def build_status():
    providers = {}
    capture(providers, "akshareSpot", probe_akshare_spot)
    time.sleep(1)
    capture(providers, "akshareDailyK", lambda: probe_akshare_kline("600179", "daily"))
    time.sleep(1)
    capture(providers, "akshareWeeklyK", lambda: probe_akshare_kline("600179", "weekly"))
    time.sleep(1)
    capture_once(providers, "thsHot", probe_ths_hot)

    spot = providers.get("akshareSpot") or {}
    has_spot = spot.get("status") == "ready"
    has_full_spot = has_spot and int(spot.get("totalRows") or 0) >= 4000
    has_daily = (providers.get("akshareDailyK") or {}).get("status") == "ready"
    has_weekly = (providers.get("akshareWeeklyK") or {}).get("status") == "ready"
    has_ths_hot = (providers.get("thsHot") or {}).get("status") == "ready"
    has_pe_ttm = has_spot and bool((spot.get("fields") or {}).get("peTtm"))
    has_pe_dynamic = has_spot and bool((spot.get("fields") or {}).get("peDynamic"))

    required = {
        "mainBoardUniverse": {
            "status": "ready" if has_full_spot else "blocked",
            "source": "akshare.stock_zh_a_spot_em",
            "notes": "AKShare spot returned enough rows for A-share universe filtering."
            if has_full_spot
            else "AKShare spot did not prove enough rows for full A-share universe.",
        },
        "nonStFilter": {
            "status": "partial" if has_full_spot else "blocked",
            "source": "akshare.stock_zh_a_spot_em.name",
            "notes": "ST/*ST/delisting are filtered by public name text only; announcement risk remains separate.",
        },
        "pctChangeAndPrice": {
            "status": "ready" if has_full_spot else "blocked",
            "source": "akshare.stock_zh_a_spot_em",
            "notes": "Price < 30 and pctChange 2%-5% are available from spot fields.",
        },
        "thsPopularityTop200": {
            "status": "ready" if has_ths_hot else "blocked",
            "source": "tushare.ths_hot",
            "notes": "Real THS popularity rank is available."
            if has_ths_hot
            else "Tushare ths_hot permission is required. Do not fake this field.",
        },
        "peTtmNonLoss": {
            "status": "ready" if has_pe_ttm else "partial" if has_pe_dynamic else "blocked",
            "source": "akshare.stock_zh_a_spot_em",
            "notes": "Exact PE TTM field is available."
            if has_pe_ttm
            else "Only dynamic PE is available from spot; this cannot be treated as PE TTM."
            if has_pe_dynamic
            else "No PE field detected.",
        },
        "hardRiskFlags": {
            "status": "blocked",
            "source": "missing",
            "notes": "Non-standard audit, investigation, major litigation, major reduction and performance blow-up need a real announcement/financial-report source. Do not default to safe.",
        },
        "dailyK": {
            "status": "ready" if has_daily else "blocked",
            "source": "akshare.stock_zh_a_hist.daily",
            "notes": "Daily K supports MA, volume, candle, breakout, MACD and KDJ calculations.",
        },
        "weeklyK": {
            "status": "ready" if has_weekly else "blocked",
            "source": "akshare.stock_zh_a_hist.weekly",
            "notes": "Weekly K supports weekly moving-average bullish alignment.",
        },
        "volumeBreakoutInputs": {
            "status": "ready" if has_daily else "blocked",
            "source": "akshare.stock_zh_a_hist.daily",
            "notes": "Daily high/low/open/close/volume can support previous-high, platform and red-candle checks.",
        },
        "macdInputs": {
            "status": "ready" if has_daily else "blocked",
            "source": "akshare.stock_zh_a_hist.daily",
            "notes": "MACD can be computed from close series.",
        },
        "kdjInputs": {
            "status": "ready" if has_daily else "blocked",
            "source": "akshare.stock_zh_a_hist.daily",
            "notes": "KDJ can be computed from high/low/close series.",
        },
    }

    blocking_issues = [
        f"{field}: {value['notes']}"
        for field, value in required.items()
        if value["status"] == "blocked"
    ]
    all_required_ready = all(value["status"] == "ready" for value in required.values())
    can_start_mvp_scanner = all(
        required[field]["status"] == "ready"
        for field in [
            "mainBoardUniverse",
            "pctChangeAndPrice",
            "dailyK",
            "weeklyK",
            "volumeBreakoutInputs",
            "macdInputs",
            "kdjInputs",
        ]
    )

    return {
        "source": "real",
        "product": "jubaopen-stock-picker",
        "generatedAt": now_iso(),
        "readiness": {
            "allRequiredReady": all_required_ready,
            "canStartMvpScanner": can_start_mvp_scanner,
            "canClaimFullStrategy": all_required_ready,
            "mustNotFake": [
                "Do not fake THS popularity rank.",
                "Do not fake PE TTM.",
                "Do not default hard-risk fields to safe.",
                "Do not call partial public coverage full-market verified unless coverage is actually proven.",
            ],
        },
        "required": required,
        "providers": providers,
        "blockingIssues": blocking_issues,
    }


def main():
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    status = build_status()
    OUTPUT_FILE.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "akshare-source-probe complete: "
        f"canStartMvpScanner={status['readiness']['canStartMvpScanner']}; "
        f"canClaimFullStrategy={status['readiness']['canClaimFullStrategy']}; "
        f"blockingIssues={len(status['blockingIssues'])}"
    )


if __name__ == "__main__":
    main()

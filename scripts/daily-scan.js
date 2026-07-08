const fs = require('fs');
const path = require('path');

const PROVIDER = 'tushare-github-actions';
const PUBLIC_PROVIDER = 'public-eastmoney-github-actions';
const TUSHARE_ENDPOINT = process.env.TUSHARE_ENDPOINT || 'https://api.tushare.pro';
const TUSHARE_TOKEN = String(process.env.TUSHARE_TOKEN || '').trim();
const REQUEST_DELAY_MS = Number(process.env.TUSHARE_REQUEST_DELAY_MS || 120);
const LOOKBACK_OPEN_DAYS = Number(process.env.TUSHARE_LOOKBACK_OPEN_DAYS || 90);
const PUBLIC_SCAN_MAX_SYMBOLS = Number(process.env.PUBLIC_SCAN_MAX_SYMBOLS || 500);
const PUBLIC_HISTORY_CONCURRENCY = Number(process.env.PUBLIC_HISTORY_CONCURRENCY || 8);
const EASTMONEY_SPOT_PAGE_SIZE = Number(process.env.EASTMONEY_SPOT_PAGE_SIZE || 100);
const EASTMONEY_SPOT_MAX_PAGES = Number(process.env.EASTMONEY_SPOT_MAX_PAGES || 80);
const DOCS_DIR = path.resolve(__dirname, '..', 'docs');
const LATEST_FILE = path.join(DOCS_DIR, 'latest-candidates.json');
const STATUS_FILE = path.join(DOCS_DIR, 'status.json');

const RISK_WARNING =
  'Real market data is for discipline assistance only; no auto order, no broker connection, no return promise.';

const EMPTY_COUNTS = Object.freeze({
  qualifiedOrWatch: 0,
  red: 0,
  verifiable: 0,
  qualified: 0,
  watch: 0,
  technicalFail: 0,
});

const CATEGORY_RANK = {
  qualified: 0,
  watch: 1,
  technicalFail: 2,
  red: 3,
};

class ProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nowIso = () => new Date().toISOString();

const chinaDateParts = (date = new Date()) => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

const formatChinaDateCompact = (date = new Date()) => {
  const { year, month, day } = chinaDateParts(date);
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
};

const dashTradeDate = (tradeDate) =>
  String(tradeDate || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

const addDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const normalizeCounts = (counts = {}) => ({
  ...EMPTY_COUNTS,
  ...Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [
      key,
      Number.isFinite(Number(value)) ? Number(value) : 0,
    ]),
  ),
});

const rowsFromTushareData = (data) => {
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map((item) =>
    Object.fromEntries(fields.map((field, index) => [field, item[index]])),
  );
};

const isPermissionDeniedMessage = (message) =>
  /(permission|denied|access|points|limit|frequency|quota|authority|privilege)/i.test(
    String(message || ''),
  );

const requestTushare = async (apiName, params = {}, fields = '') => {
  if (!TUSHARE_TOKEN) {
    throw new ProviderError(
      'provider_not_configured',
      'TUSHARE_TOKEN is not configured in GitHub Secrets; writing failed 0/0/0 JSON.',
    );
  }

  const response = await fetch(TUSHARE_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_name: apiName,
      token: TUSHARE_TOKEN,
      params,
      fields,
    }),
  });

  if (!response.ok) {
    throw new ProviderError('provider_http_error', `Tushare HTTP ${response.status}`, {
      apiName,
      status: response.status,
    });
  }

  const payload = await response.json();
  if (payload.code !== 0) {
    const message = payload.msg || `Tushare ${apiName} failed`;
    throw new ProviderError(
      isPermissionDeniedMessage(message) ? 'provider_permission_denied' : 'provider_api_error',
      message,
      { apiName, providerCode: payload.code },
    );
  }

  return rowsFromTushareData(payload.data);
};

const fetchStockBasic = () =>
  requestTushare(
    'stock_basic',
    { exchange: '', list_status: 'L' },
    'ts_code,symbol,name,area,industry,market,list_date,list_status,exchange',
  );

const fetchTradeDatesFromDailyFallback = async (warnings) => {
  const endDate = new Date();
  const maxCalendarDays = Math.max(LOOKBACK_OPEN_DAYS * 3, 220);
  const openDates = [];

  warnings.push(
    'trade_cal is unavailable for this Tushare account; inferring trade dates from non-empty tushare.daily responses.',
  );

  for (let offset = 0; offset <= maxCalendarDays && openDates.length < LOOKBACK_OPEN_DAYS; offset += 1) {
    const tradeDate = formatChinaDateCompact(addDays(endDate, -offset));
    try {
      const rows = await requestTushare('daily', { trade_date: tradeDate }, 'ts_code,trade_date');
      if (rows.length > 0) {
        openDates.push(tradeDate);
      }
    } catch (error) {
      throw new ProviderError(
        'provider_daily_calendar_fallback_failed',
        `trade_cal unavailable and daily fallback failed: ${error.message || error}`,
        { causeCode: error.code, causeDetails: error.details },
      );
    }

    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  if (openDates.length === 0) {
    throw new ProviderError(
      'provider_no_daily_calendar_fallback',
      'trade_cal unavailable and tushare.daily returned no non-empty trade dates.',
    );
  }

  return openDates.sort();
};

const fetchTradeDates = async (warnings = []) => {
  const endDate = new Date();
  const startDate = addDays(endDate, -260);
  let rows = [];
  try {
    rows = await requestTushare(
      'trade_cal',
      {
        exchange: 'SSE',
        start_date: formatChinaDateCompact(startDate),
        end_date: formatChinaDateCompact(endDate),
      },
      'exchange,cal_date,is_open,pretrade_date',
    );
  } catch (error) {
    if (error?.details?.apiName === 'trade_cal') {
      return fetchTradeDatesFromDailyFallback(warnings);
    }
    throw error;
  }

  const openDates = rows
    .filter((row) => Number(row.is_open) === 1)
    .map((row) => String(row.cal_date || ''))
    .filter(Boolean)
    .sort();

  if (openDates.length === 0) {
    throw new ProviderError('provider_no_trade_calendar', 'Tushare returned no A-share trade calendar.');
  }

  return openDates.slice(-LOOKBACK_OPEN_DAYS);
};

const fetchDailyRowsByTradeDates = async (tradeDates) => {
  const rows = [];
  for (const tradeDate of tradeDates) {
    const dailyRows = await requestTushare(
      'daily',
      { trade_date: tradeDate },
      'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
    );
    rows.push(...dailyRows);
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }
  return rows;
};

const fetchDailyBasic = (tradeDate) =>
  requestTushare(
    'daily_basic',
    { trade_date: tradeDate },
    'ts_code,trade_date,turnover_rate,volume_ratio,total_mv,circ_mv',
  );

const requestPublicJson = async (url, { retries = 3, timeoutMs = 25000 } = {}) => {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          Referer: 'https://quote.eastmoney.com/',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const jsonText = text.trim().replace(/^jQuery\d+_\d+\(/, '').replace(/\);?$/, '');
      return JSON.parse(jsonText);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(800 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
};

const secidForCode = (code) => `${code.startsWith('6') ? 1 : 0}.${code}`;

const isMainBoardCode = (code) => /^(600|601|603|605|000|001|002)/.test(String(code || ''));

const hasPublicNameRisk = (name) => {
  const value = String(name || '').toUpperCase();
  return value.includes('ST') || value.includes('*ST') || value.includes('\u9000');
};

const toFiniteOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const publicMarket = (code) => (String(code).startsWith('6') ? 'SH' : 'SZ');

const fetchEastmoneySpotRows = async () => {
  const rows = [];
  const seenCodes = new Set();
  let providerTotal = null;

  for (let page = 1; page <= EASTMONEY_SPOT_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      pn: String(page),
      pz: String(EASTMONEY_SPOT_PAGE_SIZE),
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      fid: 'f3',
      fs: 'm:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80',
      fields: 'f12,f13,f14,f2,f3,f4,f5,f6,f7,f15,f16,f17,f18,f8',
    });
    const payload = await requestPublicJson(
      `https://push2.eastmoney.com/api/qt/clist/get?${params}`,
      { retries: 3, timeoutMs: 25000 },
    );
    providerTotal = toFiniteOrNull(payload?.data?.total) ?? providerTotal;
    const pageRows = payload?.data?.diff;
    if (!Array.isArray(pageRows) || pageRows.length === 0) break;
    pageRows.forEach((row) => {
      const code = String(row.f12 || '');
      if (!seenCodes.has(code)) {
        seenCodes.add(code);
        rows.push(row);
      }
    });
    if (pageRows.length < EASTMONEY_SPOT_PAGE_SIZE) break;
    if (providerTotal !== null && rows.length >= providerTotal) break;
  }

  if (rows.length === 0) {
    throw new ProviderError('public_spot_empty', 'Eastmoney public spot API returned no A-share rows.');
  }
  rows.providerTotal = providerTotal;
  return rows;
};

const fetchEastmoneyDailyCandles = async (code) => {
  const params = new URLSearchParams({
    secid: secidForCode(code),
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: '101',
    fqt: '0',
    beg: formatChinaDateCompact(addDays(new Date(), -520)),
    end: formatChinaDateCompact(new Date()),
  });
  const payload = await requestPublicJson(
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`,
    { retries: 2, timeoutMs: 20000 },
  );
  const klines = payload?.data?.klines;
  if (!Array.isArray(klines)) return [];

  return klines
    .map((line) => {
      const [
        date,
        open,
        close,
        high,
        low,
        volume,
        amount,
        _amplitude,
        pctChange,
        change,
        turnoverRate,
      ] = String(line).split(',');
      return {
        date,
        tradeDate: String(date || '').replace(/-/g, ''),
        open: round(toNumber(open)),
        high: round(toNumber(high)),
        low: round(toNumber(low)),
        close: round(toNumber(close)),
        volume: Math.round(toNumber(volume) * 100),
        amount: round(toNumber(amount) / 100000000),
        pctChange: round(toNumber(pctChange)),
        change: round(toNumber(change)),
        turnoverRate: round(toNumber(turnoverRate), 4),
        sourceType: 'real',
      };
    })
    .filter((item) => item.date && Number.isFinite(item.close))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
};

const publicSpotToStock = (row) => {
  const code = String(row.f12 || '').padStart(6, '0');
  const market = publicMarket(code);
  const name = String(row.f14 || code);

  return {
    stock: {
      ts_code: `${code}.${market}`,
      symbol: code,
      name,
      area: '',
      industry: '',
      market,
      list_status: 'L',
      exchange: market,
      pctChange: toFiniteOrNull(row.f3),
    },
    dailyBasic: {
      turnover_rate: toFiniteOrNull(row.f8) ?? 0,
    },
    spot: {
      code,
      name,
      market,
      price: toFiniteOrNull(row.f2),
      pctChange: toFiniteOrNull(row.f3),
      amount: toFiniteOrNull(row.f6),
      turnoverRate: toFiniteOrNull(row.f8),
      high: toFiniteOrNull(row.f15),
      low: toFiniteOrNull(row.f16),
      open: toFiniteOrNull(row.f17),
      preClose: toFiniteOrNull(row.f18),
    },
  };
};

const selectPublicScanRows = (spotRows, warnings) => {
  const mainBoardRows = spotRows
    .map(publicSpotToStock)
    .filter(({ spot }) => isMainBoardCode(spot.code));
  const ordinaryRows = mainBoardRows.filter(({ spot }) => !hasPublicNameRisk(spot.name));
  const pctRangeRows = ordinaryRows.filter(
    ({ spot }) =>
      spot.price !== null &&
      spot.price > 0 &&
      spot.pctChange !== null &&
      spot.pctChange > 1 &&
      spot.pctChange < 6,
  );
  const liquidRows = ordinaryRows.filter(
    ({ spot }) => spot.price !== null && spot.price > 0 && (spot.amount ?? 0) > 30000000,
  );
  const byDiscipline = [...pctRangeRows].sort(
    (left, right) => (right.spot.amount ?? 0) - (left.spot.amount ?? 0),
  );
  const byLiquidity = [...liquidRows].sort(
    (left, right) => (right.spot.amount ?? 0) - (left.spot.amount ?? 0),
  );
  const selectedMap = new Map();

  [...byDiscipline, ...byLiquidity].forEach((row) => {
    if (selectedMap.size < PUBLIC_SCAN_MAX_SYMBOLS) {
      selectedMap.set(row.spot.code, row);
    }
  });

  warnings.push(
    `Public Eastmoney fallback spot universe=${spotRows.length}; providerTotal=${spotRows.providerTotal ?? 'unknown'}; mainBoard=${mainBoardRows.length}; ordinaryMainBoard=${ordinaryRows.length}; selectedForDailyBars=${selectedMap.size}.`,
  );
  warnings.push(
    'Public fallback is a partial candidate scan, not a full-market daily-full-market scan.',
  );

  return {
    mainBoardCount: mainBoardRows.length,
    ordinaryMainBoardCount: ordinaryRows.length,
    selectedRows: [...selectedMap.values()],
  };
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
};

const splitTsCode = (tsCode) => {
  const [code = '', market = ''] = String(tsCode || '').toUpperCase().split('.');
  return { code, market };
};

const isMainBoardTsCode = (tsCode) => {
  const { code, market } = splitTsCode(tsCode);
  if (market === 'SH') return /^(600|601|603|605)/.test(code);
  if (market === 'SZ') return /^(000|001|002)/.test(code);
  return false;
};

const hasStName = (name) => {
  const value = String(name || '');
  const upper = value.toUpperCase();
  return upper.includes('ST') || value.includes('\u9000');
};

const hasStarStName = (name) => String(name || '').toUpperCase().includes('*ST');

const hasDelistingRiskName = (name) => {
  const value = String(name || '');
  return value.includes('\u9000') || hasStarStName(value);
};

const marketBoard = (tsCode) => (isMainBoardTsCode(tsCode) ? 'main-board' : 'non-main-board');

const buildDailyMap = (rows) => {
  const map = new Map();

  rows.forEach((row) => {
    const tsCode = String(row.ts_code || '').toUpperCase();
    if (!tsCode) return;

    const candle = {
      date: dashTradeDate(row.trade_date),
      tradeDate: String(row.trade_date || ''),
      open: round(toNumber(row.open)),
      high: round(toNumber(row.high)),
      low: round(toNumber(row.low)),
      close: round(toNumber(row.close)),
      preClose: round(toNumber(row.pre_close)),
      change: round(toNumber(row.change)),
      pctChange: round(toNumber(row.pct_chg)),
      volume: Math.round(toNumber(row.vol) * 100),
      amount: round(toNumber(row.amount) / 100000),
      sourceType: 'real',
    };

    const current = map.get(tsCode) || [];
    current.push(candle);
    map.set(tsCode, current);
  });

  for (const [tsCode, dailyCandles] of map.entries()) {
    map.set(
      tsCode,
      dailyCandles.sort((left, right) => String(left.date).localeCompare(String(right.date))),
    );
  }

  return map;
};

const buildDailyBasicMap = (rows) =>
  new Map(rows.map((row) => [String(row.ts_code || '').toUpperCase(), row]));

const average = (values) => {
  const cleanValues = values.filter((value) => Number.isFinite(value));
  if (cleanValues.length === 0) return null;
  return cleanValues.reduce((sum, value) => sum + value, 0) / cleanValues.length;
};

const calculateMA = (dailyCandles, period) => {
  if (dailyCandles.length < period) return null;
  const value = average(dailyCandles.slice(-period).map((item) => item.close));
  return value === null ? null : round(value);
};

const calculateMAVolume = (dailyCandles, period) => {
  if (dailyCandles.length < period) return null;
  const value = average(dailyCandles.slice(-period).map((item) => item.volume));
  return value === null ? null : round(value, 0);
};

const calculatePreviousHigh = (dailyCandles, period = 20) => {
  if (dailyCandles.length <= 1) return null;
  const previous = dailyCandles.slice(Math.max(0, dailyCandles.length - 1 - period), -1);
  if (previous.length === 0) return null;
  return round(Math.max(...previous.map((item) => item.high)));
};

const analyzeDailyCandles = (dailyCandles) => {
  const orderedDaily = [...dailyCandles].sort((left, right) =>
    String(left.date).localeCompare(String(right.date)),
  );
  const latest = orderedDaily[orderedDaily.length - 1] || null;
  const ma5 = calculateMA(orderedDaily, 5);
  const ma10 = calculateMA(orderedDaily, 10);
  const ma20 = calculateMA(orderedDaily, 20);
  const ma60 = calculateMA(orderedDaily, 60);
  const maVol5 = calculateMAVolume(orderedDaily, 5);
  const technicalEnough =
    orderedDaily.length >= 60 &&
    latest !== null &&
    ma5 !== null &&
    ma10 !== null &&
    ma20 !== null &&
    ma60 !== null;
  const isRedK = latest ? latest.close > latest.open : false;
  const redHalfPrice = latest ? round(latest.low + (latest.high - latest.low) / 2) : null;
  const redLow = latest?.low ?? null;
  const previousHigh20 = calculatePreviousHigh(orderedDaily, 20);
  const forbiddenChasePrice = latest ? round(latest.close * 1.03) : null;
  const recent60 = orderedDaily.slice(-60);
  const positionRatio60 =
    technicalEnough && latest
      ? (() => {
          const high60 = Math.max(...recent60.map((item) => item.high));
          const low60 = Math.min(...recent60.map((item) => item.low));
          return high60 === low60
            ? 1
            : round((latest.close - low60) / Math.max(0.01, high60 - low60), 4);
        })()
      : null;
  const upperShadowRatio =
    latest === null
      ? null
      : (() => {
          const body = Math.max(Math.abs(latest.close - latest.open), 0.01);
          const upperShadow = latest.high - Math.max(latest.open, latest.close);
          return round(upperShadow / body, 4);
        })();
  const targetSpacePercent =
    latest !== null && previousHigh20 !== null && previousHigh20 > latest.close
      ? round(((previousHigh20 - latest.close) / latest.close) * 100, 2)
      : null;
  const volumeExpanded = latest === null || maVol5 === null ? null : latest.volume > maVol5;

  return {
    orderedDaily,
    latest,
    ma5,
    ma10,
    ma20,
    ma60,
    maVol5,
    technicalEnough,
    isRedK,
    redHalfPrice,
    redLow,
    previousHigh20,
    forbiddenChasePrice,
    positionRatio60,
    upperShadowRatio,
    targetSpacePercent,
    volumeExpanded,
  };
};

const classifyStock = ({ stock, dailyCandles, turnoverRate = 0, risk = {}, hasLatestDaily = true }) => {
  const calculations = analyzeDailyCandles(dailyCandles);
  const fundamentalReasons = [];
  const technicalReasons = [];
  const warningFlags = [];
  let score = 0;

  const hardRisk = Boolean(
    risk.isST || risk.isStarST || risk.delistingRisk || risk.suspended || risk.abnormalStatus,
  );

  if (hardRisk) {
    const reasons = [];
    if (risk.isST) reasons.push('ST risk: red exclusion.');
    if (risk.isStarST) reasons.push('*ST risk: red exclusion.');
    if (risk.delistingRisk) reasons.push('Delisting risk: red exclusion.');
    if (risk.suspended) reasons.push('No latest trade-date daily bar: suspended or missing data.');
    if (risk.abnormalStatus) reasons.push('Abnormal listing status.');

    return {
      category: 'red',
      action: 'do-not-buy',
      score,
      verifiable: false,
      fundamentalReasons: reasons,
      technicalReasons: [],
      warningFlags: ['hard-risk'],
      calculations,
    };
  }

  if (!hasLatestDaily) {
    technicalReasons.push('Latest trade-date daily bar is missing.');
  }

  if (!calculations.technicalEnough) {
    technicalReasons.push('Daily bars are fewer than 60; no next-day verification plan.');
  }

  if (!hasLatestDaily || !calculations.technicalEnough) {
    return {
      category: 'technicalFail',
      action: 'do-not-buy',
      score,
      verifiable: false,
      fundamentalReasons,
      technicalReasons,
      warningFlags: ['insufficient-technical-data'],
      calculations,
    };
  }

  const latest = calculations.latest;
  const pctChange = toNumber(stock.pctChange);
  const close = latest.close;

  score += 10;

  if (pctChange > 2 && pctChange < 5) {
    score += 10;
  } else {
    fundamentalReasons.push('Pct change is outside the 2%-5% discipline range.');
  }

  if (!Number.isFinite(stock.popularityRank)) {
    warningFlags.push('popularity-rank-missing');
    fundamentalReasons.push('Popularity rank is missing; not defaulting to top 200.');
  } else if (stock.popularityRank <= 200) {
    score += 10;
  } else {
    fundamentalReasons.push('Popularity rank is not top 200.');
  }

  if (turnoverRate > 0) {
    score += Math.min(8, turnoverRate >= 3 ? 8 : 4);
  }

  if (calculations.ma20 !== null && close > calculations.ma20) {
    score += 10;
  } else {
    technicalReasons.push('Close is not above MA20.');
  }

  if (
    calculations.ma5 !== null &&
    calculations.ma10 !== null &&
    calculations.ma20 !== null &&
    calculations.ma5 > calculations.ma10 &&
    calculations.ma10 > calculations.ma20
  ) {
    score += 10;
  } else {
    technicalReasons.push('MA5/MA10/MA20 are not bullishly aligned.');
  }

  if (calculations.ma5 !== null && close > calculations.ma5) {
    score += 6;
  }

  if (calculations.positionRatio60 !== null && calculations.positionRatio60 <= 0.68) {
    score += 10;
  } else if (calculations.positionRatio60 !== null) {
    technicalReasons.push('The 60-day position is high; downgrade to watch.');
    warningFlags.push('high-position-risk');
  }

  if (calculations.volumeExpanded === true) {
    score += 6;
  } else {
    technicalReasons.push('Volume expansion is not confirmed.');
    warningFlags.push('volume-not-confirmed');
  }

  if (!calculations.isRedK) {
    technicalReasons.push('The T-day candle is not red.');
  }

  if (calculations.upperShadowRatio !== null && calculations.upperShadowRatio > 0.33) {
    technicalReasons.push('Long upper shadow; next-day confirmation is required.');
    warningFlags.push('long-upper-shadow');
  }

  if (calculations.targetSpacePercent !== null && calculations.targetSpacePercent < 5) {
    technicalReasons.push('Target space before previous high is under 5%.');
    warningFlags.push('target-space-low');
  }

  const severeTechnicalFail =
    close <= (calculations.ma20 ?? 0) ||
    (calculations.positionRatio60 !== null && calculations.positionRatio60 > 0.82);

  if (severeTechnicalFail) {
    return {
      category: 'technicalFail',
      action: 'do-not-buy',
      score,
      verifiable: false,
      fundamentalReasons,
      technicalReasons,
      warningFlags,
      calculations,
    };
  }

  const category = score >= 52 && warningFlags.length === 0 ? 'qualified' : 'watch';

  return {
    category,
    action: 'wait-for-confirmation',
    score,
    verifiable: true,
    fundamentalReasons,
    technicalReasons:
      technicalReasons.length > 0
        ? technicalReasons
        : ['V5 daily trend/position/volume/K-line checks found no hard rejection.'],
    warningFlags,
    calculations,
  };
};

const buildMissingFields = () => [
  {
    field: 'popularityRank',
    reason: 'Not implemented in V7.2 static MVP; mark missing and do not default to top 200.',
    severity: 'warning',
    action: 'Do not treat missing popularity as confirmed strong.',
  },
  {
    field: 'boardStrength',
    reason: 'Not implemented in V7.2 static MVP; mark missing and do not default to strong.',
    severity: 'warning',
    action: 'Do not treat missing board strength as confirmed strong.',
  },
  {
    field: 'orderBook',
    reason: 'Not implemented in V7.2 static MVP; mark missing and do not fake intraday order-book data.',
    severity: 'blocking-intraday',
    action: 'Intraday confirmation remains unconfirmed without order-book data.',
  },
  {
    field: 'announcementRiskFlags',
    reason: 'Only stock_basic name/list_status are used for ST/delisting in V7.2 static MVP.',
    severity: 'warning',
    action: 'Do not default announcement/financial-report risk to safe.',
  },
];

const createFieldSource = ({
  field,
  sourceType,
  updatedAt,
  confidence = 'provider',
  notes = '',
  provider = PROVIDER,
}) => ({
  field,
  provider,
  sourceType,
  updatedAt,
  confidence,
  notes,
});

const buildRisk = (stock, hasLatestDaily) => {
  const name = String(stock?.name || '');
  return {
    isST: hasStName(name),
    isStarST: hasStarStName(name),
    delistingRisk: hasDelistingRiskName(name) || stock?.list_status !== 'L',
    suspended: !hasLatestDaily,
    abnormalStatus: stock?.list_status !== 'L',
  };
};

const buildItem = ({
  stock,
  dailyCandles,
  dailyBasic,
  evaluation,
  latestTradeDate,
  updatedAt,
  provider = PROVIDER,
}) => {
  const tsCode = String(stock.ts_code || '').toUpperCase();
  const { code, market } = splitTsCode(tsCode);
  const latest = dailyCandles[dailyCandles.length - 1] || null;
  const turnoverRate = round(toNumber(dailyBasic?.turnover_rate), 4);
  const risk = buildRisk(stock, latest?.tradeDate === latestTradeDate);
  const isPublicProvider = provider === PUBLIC_PROVIDER;
  const stockBasicSource = isPublicProvider ? 'eastmoney.spot' : 'tushare.stock_basic';
  const dailySource = isPublicProvider ? 'eastmoney.kline' : 'tushare.daily';
  const turnoverSource = isPublicProvider ? 'eastmoney.kline.turnover' : 'tushare.daily_basic';

  return {
    code,
    symbol: tsCode,
    name: stock.name || code,
    market,
    board: marketBoard(tsCode),
    isMainBoard: isMainBoardTsCode(tsCode),
    isST: risk.isST,
    isStarST: risk.isStarST,
    delistingRisk: risk.delistingRisk,
    pctChange: latest?.pctChange ?? 0,
    price: latest?.close ?? 0,
    open: latest?.open ?? 0,
    high: latest?.high ?? 0,
    low: latest?.low ?? 0,
    close: latest?.close ?? 0,
    turnoverRate,
    amount: latest?.amount ?? 0,
    amountText: latest ? `${latest.amount} yi` : '',
    industry: stock.industry || '',
    subIndustry: stock.industry || '',
    concepts: [],
    popularityRank: null,
    category: evaluation.category,
    decision: evaluation.action,
    score: evaluation.score,
    verifiable: evaluation.verifiable,
    fundamentalReasons: evaluation.fundamentalReasons,
    technicalReasons: evaluation.technicalReasons,
    warningFlags: evaluation.warningFlags,
    keyLevels: {
      ma5: evaluation.calculations.ma5,
      ma10: evaluation.calculations.ma10,
      ma20: evaluation.calculations.ma20,
      ma60: evaluation.calculations.ma60,
      redHalfPrice: evaluation.calculations.redHalfPrice,
      redLow: evaluation.calculations.redLow,
      previousHigh20: evaluation.calculations.previousHigh20,
      forbiddenChasePrice: evaluation.calculations.forbiddenChasePrice,
    },
    dailyCandles,
    fieldSources: {
      stockBasic: createFieldSource({
        field: 'stockBasic',
        sourceType: stockBasicSource,
        updatedAt,
        provider,
        notes: isPublicProvider
          ? 'Stock list and names from Eastmoney public spot API; listing status is partial.'
          : 'Stock list, listing status, name and industry.',
      }),
      dailyCandles: createFieldSource({
        field: 'dailyCandles',
        sourceType: dailySource,
        updatedAt,
        provider,
        notes: latestTradeDate,
      }),
      close: createFieldSource({
        field: 'close',
        sourceType: dailySource,
        updatedAt,
        provider,
        notes: latestTradeDate,
      }),
      turnoverRate: createFieldSource({
        field: 'turnoverRate',
        sourceType: dailyBasic ? turnoverSource : 'missing',
        updatedAt,
        provider,
        confidence: dailyBasic ? 'provider' : 'missing',
        notes: dailyBasic
          ? latestTradeDate
          : 'turnoverRate missing from provider; degraded to 0.',
      }),
      riskFlags: createFieldSource({
        field: 'riskFlags',
        sourceType: stockBasicSource,
        updatedAt,
        provider,
        confidence: 'partial',
        notes: isPublicProvider
          ? 'ST/delisting risk uses Eastmoney public name text only; announcement risk remains missing.'
          : 'ST/delisting risk uses stock_basic name/list_status only.',
      }),
    },
    missingFields: buildMissingFields(),
    warning: RISK_WARNING,
  };
};

const createCounts = () => ({ ...EMPTY_COUNTS });

const updateCounts = (counts, evaluation) => {
  if (evaluation.category === 'qualified') counts.qualified += 1;
  if (evaluation.category === 'watch') counts.watch += 1;
  if (evaluation.category === 'technicalFail') counts.technicalFail += 1;
  if (evaluation.category === 'red') counts.red += 1;
  if (evaluation.category === 'qualified' || evaluation.category === 'watch') {
    counts.qualifiedOrWatch += 1;
  }
  if (evaluation.verifiable) counts.verifiable += 1;
};

const classifyAndBuildItem = ({
  stock,
  dailyCandles,
  dailyBasic,
  latestTradeDate,
  updatedAt,
  provider = PROVIDER,
}) => {
  const latest = dailyCandles[dailyCandles.length - 1] || null;
  const hasLatestDaily = latest?.tradeDate === latestTradeDate;
  const risk = buildRisk(stock, hasLatestDaily);
  const evaluation = classifyStock({
    stock: {
      pctChange: latest?.pctChange ?? 0,
      popularityRank: Number.NaN,
    },
    dailyCandles,
    turnoverRate: toNumber(dailyBasic?.turnover_rate),
    risk,
    hasLatestDaily,
  });

  return {
    evaluation,
    item: buildItem({
      stock,
      dailyCandles,
      dailyBasic,
      evaluation,
      latestTradeDate,
      updatedAt,
      provider,
    }),
  };
};

const sortByCategoryAndScore = (left, right) => {
  const rankDiff = CATEGORY_RANK[left.category] - CATEGORY_RANK[right.category];
  if (rankDiff !== 0) return rankDiff;
  return (right.score || 0) - (left.score || 0);
};

const selectDisplayItems = (buckets) => {
  const maxQualified = Number(process.env.DAILY_SCAN_MAX_QUALIFIED || 80);
  const maxWatch = Number(process.env.DAILY_SCAN_MAX_WATCH || 160);
  const maxTechnicalFail = Number(process.env.DAILY_SCAN_MAX_TECHNICAL_FAIL || 30);
  const maxRed = Number(process.env.DAILY_SCAN_MAX_RED || 30);

  return [
    ...buckets.qualified.sort(sortByCategoryAndScore).slice(0, maxQualified),
    ...buckets.watch.sort(sortByCategoryAndScore).slice(0, maxWatch),
    ...buckets.technicalFail.sort(sortByCategoryAndScore).slice(0, maxTechnicalFail),
    ...buckets.red.sort(sortByCategoryAndScore).slice(0, maxRed),
  ];
};

const buildStatusFromLatest = (latest) => ({
  source: latest.source,
  provider: latest.provider,
  generatedAt: nowIso(),
  scanId: latest.scanId,
  tradeDate: latest.tradeDate,
  latestTradeDate: latest.latestTradeDate,
  createdAt: latest.createdAt,
  updatedAt: latest.updatedAt,
  expiresAt: latest.expiresAt,
  cacheState: latest.cacheState,
  scanType: latest.scanType,
  todayScanned: latest.todayScanned,
  failureReason: latest.failureReason,
  nextExpectedScanTime: latest.nextExpectedScanTime,
  counts: latest.counts,
  warnings: latest.warnings,
  errors: latest.errors,
});

const writeJsonOutputs = (latest) => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(LATEST_FILE, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(STATUS_FILE, `${JSON.stringify(buildStatusFromLatest(latest), null, 2)}\n`, 'utf8');
};

const createFailedJson = (error) => {
  const updatedAt = nowIso();
  const code = error?.code || 'provider_error';
  const message = error?.message || String(error || 'Unknown provider error.');

  return {
    source: 'real',
    provider: PROVIDER,
    scanId: `failed-${Date.now()}`,
    tradeDate: null,
    latestTradeDate: null,
    createdAt: updatedAt,
    updatedAt,
    expiresAt: null,
    cacheState: 'failed',
    scanType: 'failed',
    todayScanned: false,
    failureReason: message,
    nextExpectedScanTime: '15:45 Asia/Shanghai on the next scheduled trading weekday',
    counts: normalizeCounts(),
    items: [],
    warnings: [RISK_WARNING, 'Failed scan overwrote the previous JSON; no stale ready data is reused.'],
    missingFields: buildMissingFields(),
    errors: [code, message].filter(Boolean),
  };
};

const runDailyScan = async () => {
  const createdAt = nowIso();
  const warnings = [RISK_WARNING];
  const tradeDates = await fetchTradeDates(warnings);
  const latestTradeDate = tradeDates[tradeDates.length - 1];
  const tradeDate = dashTradeDate(latestTradeDate);
  const [stockRows, dailyRows] = await Promise.all([
    fetchStockBasic(),
    fetchDailyRowsByTradeDates(tradeDates),
  ]);

  if (!stockRows.length) {
    throw new ProviderError('provider_no_stock_basic', 'Tushare stock_basic returned no stocks.');
  }
  if (!dailyRows.length) {
    throw new ProviderError('provider_no_daily_data', 'Tushare daily returned no daily bars.');
  }

  let dailyBasicRows = [];
  try {
    dailyBasicRows = await fetchDailyBasic(latestTradeDate);
  } catch (error) {
    warnings.push(
      `daily_basic failed; turnoverRate is degraded to 0: ${error.code || error.message || error}`,
    );
  }

  const dailyMap = buildDailyMap(dailyRows);
  const dailyBasicMap = buildDailyBasicMap(dailyBasicRows);
  const counts = createCounts();
  const buckets = {
    qualified: [],
    watch: [],
    technicalFail: [],
    red: [],
  };
  let universeCount = 0;
  let scannedCount = 0;
  let excludedNonMainBoardCount = 0;

  stockRows.forEach((stock) => {
    const tsCode = String(stock.ts_code || '').toUpperCase();
    if (!isMainBoardTsCode(tsCode)) {
      excludedNonMainBoardCount += 1;
      return;
    }

    universeCount += 1;
    const dailyCandles = dailyMap.get(tsCode) || [];
    const { evaluation, item } = classifyAndBuildItem({
      stock,
      dailyCandles,
      dailyBasic: dailyBasicMap.get(tsCode),
      latestTradeDate,
      updatedAt: createdAt,
    });

    updateCounts(counts, evaluation);
    buckets[evaluation.category].push(item);
    scannedCount += 1;
  });

  const items = selectDisplayItems(buckets);
  const expiresAt = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();

  warnings.push(
    `Scan scope: Shanghai/Shenzhen main-board common stocks only; universe=${universeCount}; scanned=${scannedCount}; excludedNonMainBoard=${excludedNonMainBoardCount}.`,
  );
  warnings.push(
    `Items are display candidates capped by category; counts are from the scanned universe. displayItems=${items.length}.`,
  );
  warnings.push('mock-real is not used and no Mock/Manual data is read.');

  return {
    source: 'real',
    provider: PROVIDER,
    scanId: `tushare-actions-${latestTradeDate}-${Date.now()}`,
    tradeDate,
    latestTradeDate: tradeDate,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    cacheState: 'ready',
    scanType: 'daily-full-market',
    todayScanned: true,
    failureReason: null,
    nextExpectedScanTime: '15:45 Asia/Shanghai on the next scheduled trading weekday',
    counts,
    items,
    warnings,
    missingFields: buildMissingFields(),
    errors: [],
  };
};

const runPublicEastmoneyScan = async (tushareError) => {
  const createdAt = nowIso();
  const warnings = [
    RISK_WARNING,
    `Tushare scan failed before public fallback: ${tushareError?.code || 'provider_error'} ${
      tushareError?.message || tushareError || ''
    }`.trim(),
  ];
  const spotRows = await fetchEastmoneySpotRows();
  const { mainBoardCount, ordinaryMainBoardCount, selectedRows } = selectPublicScanRows(
    spotRows,
    warnings,
  );

  if (selectedRows.length === 0) {
    throw new ProviderError(
      'public_no_selected_symbols',
      'Public Eastmoney fallback found no selected main-board symbols for daily-bar verification.',
    );
  }

  const scanned = await mapWithConcurrency(
    selectedRows,
    PUBLIC_HISTORY_CONCURRENCY,
    async (row) => {
      const candles = await fetchEastmoneyDailyCandles(row.spot.code);
      return { ...row, dailyCandles: candles };
    },
  );
  const latestTradeDate = scanned
    .flatMap((row) => row.dailyCandles.map((item) => item.tradeDate).filter(Boolean))
    .sort()
    .at(-1);

  if (!latestTradeDate) {
    throw new ProviderError(
      'public_no_daily_data',
      'Public Eastmoney fallback returned no daily candles for selected main-board symbols.',
    );
  }

  const counts = createCounts();
  const buckets = {
    qualified: [],
    watch: [],
    technicalFail: [],
    red: [],
  };
  let scannedDailyCount = 0;

  scanned.forEach((row) => {
    const latest = row.dailyCandles[row.dailyCandles.length - 1] || null;
    const dailyBasic = {
      turnover_rate: latest?.turnoverRate ?? row.dailyBasic.turnover_rate ?? 0,
    };
    const { evaluation, item } = classifyAndBuildItem({
      stock: row.stock,
      dailyCandles: row.dailyCandles,
      dailyBasic,
      latestTradeDate,
      updatedAt: createdAt,
      provider: PUBLIC_PROVIDER,
    });
    updateCounts(counts, evaluation);
    buckets[evaluation.category].push(item);
    scannedDailyCount += 1;
  });

  const items = selectDisplayItems(buckets);
  const tradeDate = dashTradeDate(latestTradeDate);
  const expiresAt = new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString();

  warnings.push(
    `Public Eastmoney fallback daily bars scanned=${scannedDailyCount}; displayItems=${items.length}; latestTradeDate=${tradeDate}.`,
  );
  warnings.push('cacheState=partial by design; this must not be displayed as daily-full-market.');
  warnings.push('mock-real is not used and no Mock/Manual data is read.');

  return {
    source: 'real',
    provider: PUBLIC_PROVIDER,
    scanId: `eastmoney-public-${latestTradeDate}-${Date.now()}`,
    tradeDate,
    latestTradeDate: tradeDate,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    cacheState: 'partial',
    scanType: 'partial',
    todayScanned: true,
    failureReason: null,
    nextExpectedScanTime: '15:45 Asia/Shanghai on the next scheduled trading weekday',
    counts,
    items,
    warnings,
    missingFields: [
      ...buildMissingFields(),
      {
        field: 'fullMarketDailyBars',
        reason:
          'Public fallback verifies a selected candidate subset from full spot quotes; it is not a full-market daily-bar scan.',
        severity: 'warning',
        action: 'Display as partial and do not claim daily-full-market coverage.',
      },
      {
        field: 'providerSLA',
        reason: 'Eastmoney public endpoints are unofficial and may throttle or change without notice.',
        severity: 'warning',
        action: 'If unavailable, write failed JSON and keep counts/items empty.',
      },
    ],
    errors: [],
    scanMeta: {
      spotUniverse: spotRows.length,
      mainBoardCount,
      ordinaryMainBoardCount,
      selectedForDailyBars: selectedRows.length,
      scannedDailyCount,
    },
  };
};

const main = async () => {
  try {
    const latest = await runDailyScan();
    writeJsonOutputs(latest);
    console.log(
      `daily-scan ready: tradeDate=${latest.tradeDate}, items=${latest.items.length}, counts=${JSON.stringify(
        latest.counts,
      )}`,
    );
  } catch (error) {
    try {
      const fallback = await runPublicEastmoneyScan(error);
      writeJsonOutputs(fallback);
      console.log(
        `public fallback partial: tradeDate=${fallback.tradeDate}, items=${fallback.items.length}, counts=${JSON.stringify(
          fallback.counts,
        )}`,
      );
    } catch (fallbackError) {
      const failed = createFailedJson(
        new ProviderError(
          fallbackError?.code || 'provider_error',
          `Tushare failed: ${error?.message || error}; public fallback failed: ${
            fallbackError?.message || fallbackError
          }`,
        ),
      );
      writeJsonOutputs(failed);
      console.error(`daily-scan failed: ${failed.errors.join(' | ')}`);
    }
  }
};

main();

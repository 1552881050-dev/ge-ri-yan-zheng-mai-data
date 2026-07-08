const fs = require('fs');
const path = require('path');

const PROVIDER = 'tushare-github-actions';
const TUSHARE_ENDPOINT = process.env.TUSHARE_ENDPOINT || 'https://api.tushare.pro';
const TUSHARE_TOKEN = String(process.env.TUSHARE_TOKEN || '').trim();
const REQUEST_DELAY_MS = Number(process.env.TUSHARE_REQUEST_DELAY_MS || 120);
const LOOKBACK_OPEN_DAYS = Number(process.env.TUSHARE_LOOKBACK_OPEN_DAYS || 90);
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

const createFieldSource = ({ field, sourceType, updatedAt, confidence = 'provider', notes = '' }) => ({
  field,
  provider: PROVIDER,
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

const buildItem = ({ stock, dailyCandles, dailyBasic, evaluation, latestTradeDate, updatedAt }) => {
  const tsCode = String(stock.ts_code || '').toUpperCase();
  const { code, market } = splitTsCode(tsCode);
  const latest = dailyCandles[dailyCandles.length - 1] || null;
  const turnoverRate = round(toNumber(dailyBasic?.turnover_rate), 4);
  const risk = buildRisk(stock, latest?.tradeDate === latestTradeDate);

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
        sourceType: 'tushare.stock_basic',
        updatedAt,
        notes: 'Stock list, listing status, name and industry.',
      }),
      dailyCandles: createFieldSource({
        field: 'dailyCandles',
        sourceType: 'tushare.daily',
        updatedAt,
        notes: latestTradeDate,
      }),
      close: createFieldSource({
        field: 'close',
        sourceType: 'tushare.daily',
        updatedAt,
        notes: latestTradeDate,
      }),
      turnoverRate: createFieldSource({
        field: 'turnoverRate',
        sourceType: dailyBasic ? 'tushare.daily_basic' : 'missing',
        updatedAt,
        confidence: dailyBasic ? 'provider' : 'missing',
        notes: dailyBasic ? latestTradeDate : 'daily_basic missing; turnoverRate degraded to 0.',
      }),
      riskFlags: createFieldSource({
        field: 'riskFlags',
        sourceType: 'tushare.stock_basic',
        updatedAt,
        confidence: 'partial',
        notes: 'ST/delisting risk uses stock_basic name/list_status only.',
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

const classifyAndBuildItem = ({ stock, dailyCandles, dailyBasic, latestTradeDate, updatedAt }) => {
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
    const failed = createFailedJson(error);
    writeJsonOutputs(failed);
    console.error(`daily-scan failed: ${failed.errors.join(' | ')}`);
  }
};

main();

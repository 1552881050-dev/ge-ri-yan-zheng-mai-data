const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.resolve(__dirname, '..', 'docs');
const OUTPUT_FILE = path.join(DOCS_DIR, 'source-status.json');

const TUSHARE_ENDPOINT = process.env.TUSHARE_ENDPOINT || 'https://api.tushare.pro';
const TUSHARE_TOKEN = String(process.env.TUSHARE_TOKEN || '').trim();
const EASTMONEY_SPOT_PAGE_SIZE = Number(process.env.EASTMONEY_SPOT_PAGE_SIZE || 100);
const EASTMONEY_SPOT_MAX_PAGES = Number(process.env.EASTMONEY_SPOT_MAX_PAGES || 80);

const EASTMONEY_SPOT_HOSTS = [
  'https://push2.eastmoney.com/api/qt/clist/get',
  'https://82.push2.eastmoney.com/api/qt/clist/get',
  'https://33.push2.eastmoney.com/api/qt/clist/get',
];

const EASTMONEY_KLINE_HOSTS = [
  'https://push2his.eastmoney.com/api/qt/stock/kline/get',
  'https://push2.eastmoney.com/api/qt/stock/kline/get',
];

const REQUIRED_FIELDS = [
  'mainBoardUniverse',
  'nonStFilter',
  'pctChangeAndPrice',
  'thsPopularityTop200',
  'peTtmNonLoss',
  'hardRiskFlags',
  'dailyK',
  'weeklyK',
  'volumeBreakoutInputs',
  'macdInputs',
  'kdjInputs',
];

class ProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
  }
}

const nowIso = () => new Date().toISOString();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const safeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const compactError = (error) =>
  [error?.code, error?.message || String(error)].filter(Boolean).join(' ');

const requestText = async (url, { timeoutMs = 25000, retries = 2 } = {}) => {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          Referer: 'https://quote.eastmoney.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ProbeError('http_error', `HTTP ${response.status}: ${text.slice(0, 120)}`);
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(800 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
};

const parseJsonMaybeCallback = (text) => {
  const clean = String(text || '').trim().replace(/^[^(]+\(/, '').replace(/\);?$/, '');
  return JSON.parse(clean);
};

const requestEastmoneyJson = async (hosts, params, options = {}) => {
  const errors = [];
  for (const host of hosts) {
    const url = new URL(host);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    try {
      const text = await requestText(url, options);
      return { host, payload: parseJsonMaybeCallback(text) };
    } catch (error) {
      errors.push(`${host}: ${compactError(error)}`);
    }
  }
  throw new ProbeError('all_hosts_failed', errors.join(' | '));
};

const secidForCode = (code) => `${String(code).startsWith('6') ? 1 : 0}.${code}`;

const isMainBoardCode = (code) => /^(600|601|603|605|000|001|002)/.test(String(code || ''));

const hasStName = (name) => {
  const value = String(name || '').toUpperCase();
  return value.includes('ST') || value.includes('*ST') || value.includes('\u9000');
};

const fetchSpotProbe = async () => {
  const fields = [
    'f12',
    'f13',
    'f14',
    'f2',
    'f3',
    'f5',
    'f6',
    'f8',
    'f9',
    'f10',
    'f15',
    'f16',
    'f17',
    'f18',
    'f20',
    'f21',
    'f23',
    'f24',
    'f25',
    'f115',
    'f116',
    'f117',
    'f162',
    'f167',
  ].join(',');
  const rows = [];
  const seenCodes = new Set();
  let lastHost = null;
  let providerTotal = null;
  let pagesFetched = 0;

  for (let page = 1; page <= EASTMONEY_SPOT_MAX_PAGES; page += 1) {
    const { host, payload } = await requestEastmoneyJson(EASTMONEY_SPOT_HOSTS, {
      pn: page,
      pz: EASTMONEY_SPOT_PAGE_SIZE,
      po: 1,
      np: 1,
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: 2,
      invt: 2,
      fid: 'f3',
      fs: 'm:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80',
      fields,
    });
    lastHost = host;
    pagesFetched += 1;
    providerTotal = safeNumber(payload?.data?.total) ?? providerTotal;
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
    throw new ProbeError('eastmoney_spot_empty', 'Eastmoney spot returned no rows.');
  }
  const mainBoardRows = rows.filter((row) => isMainBoardCode(row.f12));
  const ordinaryMainBoardRows = mainBoardRows.filter((row) => !hasStName(row.f14));
  const pricePctRows = ordinaryMainBoardRows.filter(
    (row) =>
      safeNumber(row.f2) !== null &&
      safeNumber(row.f3) !== null &&
      safeNumber(row.f2) < 30 &&
      safeNumber(row.f3) >= 2 &&
      safeNumber(row.f3) <= 5,
  );
  const peCandidateFields = ['f9', 'f115', 'f162'].filter((field) =>
    rows.some((row) => safeNumber(row[field]) !== null),
  );

  return {
    provider: 'eastmoney-public-spot',
    status: 'ready',
    host: lastHost,
    totalRows: rows.length,
    providerTotal,
    pagesFetched,
    pageSize: EASTMONEY_SPOT_PAGE_SIZE,
    mainBoardSampleCount: mainBoardRows.length,
    ordinaryMainBoardSampleCount: ordinaryMainBoardRows.length,
    pricePctSampleCount: pricePctRows.length,
    peCandidateFields,
    sampleRows: rows.slice(0, 5).map((row) => ({
      code: row.f12,
      name: row.f14,
      price: safeNumber(row.f2),
      pctChange: safeNumber(row.f3),
      turnoverRate: safeNumber(row.f8),
      peCandidates: {
        f9: safeNumber(row.f9),
        f115: safeNumber(row.f115),
        f162: safeNumber(row.f162),
      },
    })),
  };
};

const parseKline = (line) => {
  const [
    date,
    open,
    close,
    high,
    low,
    volume,
    amount,
    amplitude,
    pctChange,
    change,
    turnoverRate,
  ] = String(line).split(',');
  return {
    date,
    open: safeNumber(open),
    close: safeNumber(close),
    high: safeNumber(high),
    low: safeNumber(low),
    volume: safeNumber(volume),
    amount: safeNumber(amount),
    amplitude: safeNumber(amplitude),
    pctChange: safeNumber(pctChange),
    change: safeNumber(change),
    turnoverRate: safeNumber(turnoverRate),
  };
};

const fetchKlineProbe = async (code, klt) => {
  const { host, payload } = await requestEastmoneyJson(
    EASTMONEY_KLINE_HOSTS,
    {
      secid: secidForCode(code),
      fields1: 'f1,f2,f3,f4,f5,f6',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
      klt,
      fqt: 1,
      beg: '20240101',
      end: '20500101',
    },
    { retries: 3, timeoutMs: 30000 },
  );
  const klines = payload?.data?.klines;
  if (!Array.isArray(klines) || klines.length === 0) {
    throw new ProbeError('eastmoney_kline_empty', `No kline rows for ${code} klt=${klt}.`);
  }
  return {
    provider: klt === '102' ? 'eastmoney-public-weekly-kline' : 'eastmoney-public-daily-kline',
    status: 'ready',
    host,
    code,
    name: payload?.data?.name,
    klt,
    count: klines.length,
    latest: parseKline(klines[klines.length - 1]),
  };
};

const requestTushare = async (apiName, params, fields) => {
  if (!TUSHARE_TOKEN) {
    throw new ProbeError('tushare_token_missing', 'TUSHARE_TOKEN is not configured in GitHub Secrets.');
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
    throw new ProbeError('tushare_http_error', `HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new ProbeError('tushare_api_error', payload.msg || `${apiName} failed`);
  }
  const dataFields = payload?.data?.fields || [];
  const items = payload?.data?.items || [];
  return items.map((item) =>
    Object.fromEntries(dataFields.map((field, index) => [field, item[index]])),
  );
};

const fetchThsHotProbe = async () => {
  const rows = await requestTushare(
    'ths_hot',
    { market: '热股', is_new: 'Y' },
    'trade_date,data_type,ts_code,ts_name,rank,pct_change,current_price,concept,hot,rank_time',
  );
  if (!rows.length) {
    throw new ProbeError('ths_hot_empty', 'Tushare ths_hot returned no rows.');
  }
  return {
    provider: 'tushare.ths_hot',
    status: 'ready',
    docs: 'https://tushare.pro/wctapi/documents/320.md',
    count: rows.length,
    top200Count: rows.filter((row) => Number(row.rank) <= 200).length,
    latestRankTime: rows.map((row) => row.rank_time).filter(Boolean).sort().at(-1) || null,
    sampleRows: rows.slice(0, 5).map((row) => ({
      ts_code: row.ts_code,
      ts_name: row.ts_name,
      rank: Number(row.rank),
      pct_change: safeNumber(row.pct_change),
      current_price: safeNumber(row.current_price),
      hot: safeNumber(row.hot),
      rank_time: row.rank_time,
    })),
  };
};

const runProbe = async () => {
  const generatedAt = nowIso();
  const providers = {};
  const blockingIssues = [];

  const capture = async (key, fn) => {
    try {
      providers[key] = await fn();
    } catch (error) {
      providers[key] = {
        provider: key,
        status: 'failed',
        errorCode: error?.code || 'provider_error',
        error: error?.message || String(error),
      };
    }
  };

  await Promise.all([
    capture('eastmoneySpot', fetchSpotProbe),
    capture('eastmoneyDailyK', () => fetchKlineProbe('600179', '101')),
    capture('eastmoneyWeeklyK', () => fetchKlineProbe('600179', '102')),
    capture('thsHot', fetchThsHotProbe),
  ]);

  const hasSpot = providers.eastmoneySpot?.status === 'ready';
  const hasFullSpotCoverage =
    hasSpot && Number(providers.eastmoneySpot.totalRows || 0) >= 4000;
  const hasDaily = providers.eastmoneyDailyK?.status === 'ready';
  const hasWeekly = providers.eastmoneyWeeklyK?.status === 'ready';
  const hasThsHot = providers.thsHot?.status === 'ready';
  const hasPeCandidate =
    hasSpot && Array.isArray(providers.eastmoneySpot.peCandidateFields) && providers.eastmoneySpot.peCandidateFields.length > 0;

  const required = {
    mainBoardUniverse: {
      status: hasFullSpotCoverage ? 'ready' : hasSpot ? 'partial' : 'blocked',
      source: 'eastmoney-public-spot',
      notes: hasFullSpotCoverage
        ? 'Paginated Eastmoney spot coverage is sufficient for public A-share universe filtering.'
        : 'Spot probe did not prove full A-share coverage. Do not call this full-market until pagination returns enough rows.',
    },
    nonStFilter: {
      status: hasSpot ? 'partial' : 'blocked',
      source: 'eastmoney-public-spot.name',
      notes: 'ST and delisting are detected from public name text only. Full announcement risk is separate.',
    },
    pctChangeAndPrice: {
      status: hasSpot ? 'ready' : 'blocked',
      source: 'eastmoney-public-spot',
      notes: 'Price < 30 and pctChange 2%-5% can be evaluated from spot quote fields.',
    },
    thsPopularityTop200: {
      status: hasThsHot ? 'ready' : 'blocked',
      source: 'tushare.ths_hot',
      notes: hasThsHot
        ? 'Tushare ths_hot is available; rank <= 200 can be enforced.'
        : 'Tushare ths_hot is required for real THS popularity. Do not fake this from volume or amount.',
    },
    peTtmNonLoss: {
      status: hasPeCandidate ? 'partial' : 'blocked',
      source: 'eastmoney-public-spot',
      notes: hasPeCandidate
        ? `PE candidate fields detected: ${providers.eastmoneySpot.peCandidateFields.join(', ')}. Field口径 must be locked before final filtering.`
        : 'No PE candidate field detected from spot probe.',
    },
    hardRiskFlags: {
      status: 'blocked',
      source: 'missing',
      notes:
        'Non-standard audit, investigation, major litigation, major reduction, performance blow-up and other hard risks need a real announcement/financial-report source. Do not default to safe.',
    },
    dailyK: {
      status: hasDaily ? 'ready' : 'blocked',
      source: 'eastmoney-public-daily-kline',
      notes: 'Daily K supports MA, volume, candle, breakout, MACD and KDJ calculations.',
    },
    weeklyK: {
      status: hasWeekly ? 'ready' : 'blocked',
      source: 'eastmoney-public-weekly-kline',
      notes: 'Weekly K supports weekly moving-average bullish alignment.',
    },
    volumeBreakoutInputs: {
      status: hasDaily ? 'ready' : 'blocked',
      source: 'eastmoney-public-daily-kline',
      notes: 'Daily high/low/open/close/volume can support previous-high, platform and red-candle checks.',
    },
    macdInputs: {
      status: hasDaily ? 'ready' : 'blocked',
      source: 'eastmoney-public-daily-kline',
      notes: 'MACD can be computed from close series; provider does not need to supply MACD directly.',
    },
    kdjInputs: {
      status: hasDaily ? 'ready' : 'blocked',
      source: 'eastmoney-public-daily-kline',
      notes: 'KDJ can be computed from high/low/close series; provider does not need to supply KDJ directly.',
    },
  };

  Object.entries(required).forEach(([field, value]) => {
    if (value.status === 'blocked') {
      blockingIssues.push(`${field}: ${value.notes}`);
    }
  });

  const allRequiredReady = REQUIRED_FIELDS.every((field) => required[field]?.status === 'ready');
  const canStartMvpScanner = [
    required.mainBoardUniverse,
    required.pctChangeAndPrice,
    required.dailyK,
    required.weeklyK,
    required.volumeBreakoutInputs,
    required.macdInputs,
    required.kdjInputs,
  ].every((item) => item.status === 'ready');

  return {
    source: 'real',
    product: 'jubaopen-stock-picker',
    generatedAt,
    readiness: {
      allRequiredReady,
      canStartMvpScanner,
      canClaimFullStrategy: allRequiredReady,
      mustNotFake: [
        'Do not fake THS popularity rank.',
        'Do not fake PE TTM.',
        'Do not default hard-risk fields to safe.',
        'Do not call public partial coverage full-market verified unless coverage is actually proven.',
      ],
    },
    required,
    providers,
    blockingIssues,
  };
};

const main = async () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const status = await runProbe();
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  console.log(
    `source-probe complete: canStartMvpScanner=${status.readiness.canStartMvpScanner}; canClaimFullStrategy=${status.readiness.canClaimFullStrategy}`,
  );
  if (status.blockingIssues.length > 0) {
    console.log(`blockingIssues=${status.blockingIssues.length}`);
  }
};

main().catch((error) => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const failed = {
    source: 'real',
    product: 'jubaopen-stock-picker',
    generatedAt: nowIso(),
    readiness: {
      allRequiredReady: false,
      canStartMvpScanner: false,
      canClaimFullStrategy: false,
      mustNotFake: ['Probe failed; do not reuse old ready state.'],
    },
    required: {},
    providers: {},
    blockingIssues: [error?.message || String(error)],
  };
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(failed, null, 2)}\n`, 'utf8');
  console.error(`source-probe failed: ${error?.message || error}`);
});

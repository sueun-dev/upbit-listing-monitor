#!/usr/bin/env node
"use strict";

const fsPromises = require("fs").promises;
const path = require("path");

const {
  requestBuffer,
  writeJson,
} = require("./updateCrixMaster");

const CANDLES_URL = "https://crix-api.upbit.com/v1/crix/candles/days?code={code}&count={count}";
const PUBLIC_CANDLES_URL = "https://api.upbit.com/v1/candles/days?market={market}&count={count}";
const MAX_CANDLES = 400;
const DEFAULT_LOOKBACK_DAYS = 380;
const DEFAULT_CONCURRENCY = 5;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MASTER = path.join(PROJECT_ROOT, "crix_master.json");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "price_cache.json");

function requestJson(url, options = {}) {
  return requestBuffer(url, options).then((buffer) => JSON.parse(buffer.toString("utf-8")));
}

function utcNow() {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

async function loadMaster(masterPath) {
  try {
    const data = await fsPromises.readFile(masterPath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Master file not found: ${masterPath}`);
    }
    throw error;
  }
}

function parseListingDate(value) {
  return new Date(`${value}T00:00:00Z`);
}

function selectRecentCoins(masterPayload, lookbackDays) {
  const referenceNow = utcNow();
  const threshold = new Date(referenceNow.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const coins = [];

  for (const record of masterPayload) {
    const listingDateStr = record && record.listingDate;
    if (
      record &&
      record.exchange === "UPBIT" &&
      record.quoteCurrencyCode === "KRW" &&
      record.marketState === "ACTIVE" &&
      listingDateStr
    ) {
      let listingDate;
      try {
        listingDate = parseListingDate(listingDateStr);
      } catch (_error) {
        continue;
      }

      if (listingDate <= referenceNow && listingDate >= threshold) {
        coins.push({
          code: record.code,
          pair: record.pair || record.code.split(".", 2).pop().replace("-", "/"),
          koreanName:
            record.koreanName || record.localName || record.baseCurrencyCode || "",
          englishName: record.englishName || "",
          listingDate,
        });
      }
    }
  }

  coins.sort((a, b) => b.listingDate - a.listingDate);
  return coins;
}

async function fetchCrixCandles(code, count = MAX_CANDLES, timeout = 30000) {
  const url = CANDLES_URL.replace("{code}", encodeURIComponent(code)).replace(
    "{count}",
    String(count)
  );
  const buffer = await requestBuffer(url, { timeout });
  const payload = JSON.parse(buffer.toString("utf-8"));
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected response for ${code}`);
  }
  return payload;
}

function convertPublicCandles(payload) {
  const converted = [];
  for (const item of payload) {
    if (!item || typeof item.trade_price === "undefined") {
      continue;
    }

    let candleTime = item.candle_date_time_utc || item.candle_date_time_kst;
    if (!candleTime) {
      continue;
    }

    if (candleTime.endsWith("Z")) {
      candleTime = candleTime.replace("Z", "+00:00");
    } else if (!(candleTime.includes("+") || candleTime.includes("-"))) {
      candleTime = `${candleTime}+00:00`;
    }

    converted.push({
      candleDateTime: candleTime,
      tradePrice: item.trade_price,
    });
  }
  return converted;
}

async function fetchPublicCandles(code, count = MAX_CANDLES, timeout = 30000) {
  const market = code.split(".").pop();
  const url = PUBLIC_CANDLES_URL.replace("{market}", encodeURIComponent(market)).replace(
    "{count}",
    String(count)
  );
  const payload = await requestJson(url, {
    timeout,
    headers: {
      "Accept-Encoding": "",
    },
  });
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected response for public API ${code}`);
  }
  return convertPublicCandles(payload);
}

async function fetchCandles(code, count = MAX_CANDLES, timeout = 30000) {
  try {
    return await fetchCrixCandles(code, count, timeout);
  } catch (error) {
    const tlsErrorCodes = new Set([
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "CERT_HAS_EXPIRED",
    ]);
    if (error && typeof error.code === "string" && tlsErrorCodes.has(error.code)) {
      console.error(
        `[price-cache] SSL issue for ${code}, falling back to api.upbit.com`
      );
      return fetchPublicCandles(code, count, timeout);
    }
    throw error;
  }
}

function parseCandleDatetime(value) {
  return new Date(value.replace("Z", "+00:00"));
}

function buildCoinSnapshot(coin, candles) {
  if (!candles || candles.length === 0) {
    throw new Error("No candle data");
  }

  const chronological = [...candles].reverse();
  const relevant = chronological.filter((candle) => {
    try {
      return parseCandleDatetime(candle.candleDateTime) >= coin.listingDate;
    } catch (_error) {
      return false;
    }
  });

  const reference = relevant.length > 0 ? relevant : chronological;
  const prices = reference
    .map((candle) => Number(candle.tradePrice))
    .filter((price) => Number.isFinite(price));

  if (prices.length === 0) {
    throw new Error("No valid price points");
  }

  const listingPrice = prices[0];
  const currentPrice = prices[prices.length - 1];
  const change = listingPrice
    ? ((currentPrice - listingPrice) / listingPrice) * 100
    : 0;

  return {
    status: "ok",
    code: coin.code,
    pair: coin.pair,
    koreanName: coin.koreanName,
    englishName: coin.englishName,
    listingDate: coin.listingDate.toISOString().slice(0, 10),
    listingPrice,
    currentPrice,
    change,
    prices,
    lastCandleAt: reference[reference.length - 1].candleDateTime,
    points: prices.length,
  };
}

function buildErrorSnapshot(coin, error) {
  return {
    status: "error",
    code: coin.code,
    pair: coin.pair,
    koreanName: coin.koreanName,
    englishName: coin.englishName,
    listingDate: coin.listingDate.toISOString().slice(0, 10),
    error: typeof error === "string" ? error : error.message,
  };
}

async function syncPriceCache(
  masterPath,
  outputPath,
  {
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    concurrency = DEFAULT_CONCURRENCY,
    candleCount = MAX_CANDLES,
  } = {}
) {
  let masterPayload;
  try {
    masterPayload = await loadMaster(masterPath);
  } catch (error) {
    console.error(`[price-cache] ${error.message}`);
    return 1;
  }

  let coins;
  try {
    coins = selectRecentCoins(masterPayload, lookbackDays);
  } catch (error) {
    console.error(`[price-cache] Failed to parse master payload: ${error.message}`);
    return 1;
  }

  if (coins.length === 0) {
    const payload = { generatedAt: utcNow().toISOString(), coins: [] };
    await writeJson(outputPath, payload);
    console.log("[price-cache] No recent coins found. Snapshot cleared.");
    return 0;
  }

  console.log(
    `[price-cache] Preparing ${coins.length} coin(s) within ${lookbackDays} days.`
  );

  const results = [];
  let errors = 0;
  const queue = coins.slice();
  const workerCount = Math.max(1, Number(concurrency) || 1);

  async function worker() {
    while (queue.length > 0) {
      const coin = queue.shift();
      if (!coin) {
        continue;
      }

      try {
        const candles = await fetchCandles(coin.code, candleCount);
        const snapshot = buildCoinSnapshot(coin, candles);
        results.push(snapshot);
        console.log(`[price-cache] ✔ ${coin.code} (${snapshot.points} pts)`);
      } catch (error) {
        errors += 1;
        const snapshot = buildErrorSnapshot(coin, error);
        results.push(snapshot);
        if (error.name === "HTTPError") {
          console.error(
            `[price-cache] ✖ ${coin.code} network error: ${error.statusCode} ${error.statusMessage || ""}`.trim()
          );
        } else {
          console.error(`[price-cache] ✖ ${coin.code} error: ${error.message}`);
        }
      }
    }
  }

  const workers = [];
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  results.sort((a, b) => {
    const aDate = a.listingDate || "";
    const bDate = b.listingDate || "";
    return aDate < bDate ? 1 : aDate > bDate ? -1 : 0;
  });

  const payload = {
    generatedAt: utcNow().toISOString(),
    coins: results,
  };
  await writeJson(outputPath, payload);

  if (errors > 0) {
    console.log(`[price-cache] Completed with ${errors} error(s).`);
    return 2;
  }

  console.log("[price-cache] Snapshot updated successfully.");
  return 0;
}

function parseArgs(argv) {
  const args = {
    master: DEFAULT_MASTER,
    output: DEFAULT_OUTPUT,
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    concurrency: DEFAULT_CONCURRENCY,
    count: MAX_CANDLES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if ((token === "--master") && argv[index + 1]) {
      args.master = path.resolve(argv[index + 1]);
      index += 1;
    } else if ((token === "-o" || token === "--output") && argv[index + 1]) {
      args.output = path.resolve(argv[index + 1]);
      index += 1;
    } else if (token === "--lookback-days" && argv[index + 1]) {
      args.lookbackDays = Number(argv[index + 1]);
      index += 1;
    } else if (token === "--concurrency" && argv[index + 1]) {
      args.concurrency = Number(argv[index + 1]);
      index += 1;
    } else if ((token === "--count" || token === "--candles" || token === "--price-count") && argv[index + 1]) {
      args.count = Number(argv[index + 1]);
      index += 1;
    }
  }

  if (!Number.isFinite(args.lookbackDays)) {
    args.lookbackDays = DEFAULT_LOOKBACK_DAYS;
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    args.concurrency = DEFAULT_CONCURRENCY;
  }
  if (!Number.isFinite(args.count) || args.count < 1) {
    args.count = MAX_CANDLES;
  }

  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const exitCode = await syncPriceCache(
    path.resolve(args.master),
    path.resolve(args.output),
    {
      lookbackDays: args.lookbackDays,
      concurrency: args.concurrency,
      candleCount: Math.min(args.count, MAX_CANDLES),
    }
  );
  return exitCode;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[price-cache] Unexpected error: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  DEFAULT_MASTER,
  DEFAULT_OUTPUT,
  DEFAULT_CONCURRENCY,
  DEFAULT_LOOKBACK_DAYS,
  MAX_CANDLES,
  syncPriceCache,
  selectRecentCoins,
  fetchCandles,
  buildCoinSnapshot,
};

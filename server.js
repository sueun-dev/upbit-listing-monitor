#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const { syncCrixMaster, DEFAULT_OUTPUT: DEFAULT_MASTER_OUTPUT } = require("./scripts/updateCrixMaster");
const {
  syncPriceCache,
  DEFAULT_OUTPUT: DEFAULT_PRICE_OUTPUT,
  DEFAULT_CONCURRENCY,
  DEFAULT_LOOKBACK_DAYS,
  MAX_CANDLES,
} = require("./scripts/updatePriceCache");

const DEFAULT_MASTER_INTERVAL = 2 * 60 * 60; // seconds
const DEFAULT_PRICE_INTERVAL = 10 * 60; // seconds
const DEFAULT_PORT = 8000;
const PROJECT_ROOT = __dirname;
const SNAPSHOT_PATH = path.resolve(DEFAULT_MASTER_OUTPUT || path.join(PROJECT_ROOT, "crix_master.json"));
const PRICE_CACHE_PATH = path.resolve(DEFAULT_PRICE_OUTPUT || path.join(PROJECT_ROOT, "price_cache.json"));

function runMasterUpdate(masterPath) {
  console.log(`Updating listing master (${masterPath})...`);
  return syncCrixMaster(masterPath).then((code) => {
    if (code === 0) {
      console.log("Listing master updated.");
    } else {
      console.warn(`Listing master update exited with code ${code}.`);
    }
    return code;
  });
}

function runPriceUpdate(masterPath, pricePath, options) {
  console.log(`Updating price cache (${pricePath})...`);
  return syncPriceCache(masterPath, pricePath, options).then((code) => {
    if (code === 0) {
      console.log("Price cache updated.");
    } else {
      console.warn(`Price cache update exited with code ${code}.`);
    }
    return code;
  });
}

function scheduleTask(name, func, intervalSeconds) {
  let stopped = false;
  let timer = null;

  const scheduleNext = (delayMs) => {
    if (stopped) {
      return;
    }
    timer = setTimeout(async () => {
      const start = Date.now();
      try {
        await func();
      } catch (error) {
        console.error(`[${name}] error: ${error.message}`);
      }
      const elapsed = Date.now() - start;
      const nextDelay = Math.max(0, intervalSeconds * 1000 - elapsed);
      scheduleNext(nextDelay);
    }, delayMs);
  };

  scheduleNext(intervalSeconds * 1000);

  return {
    cancel() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_TYPES[extension] || "application/octet-stream";
}

async function handleRequest(req, res, rootDirectory) {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return;
  }

  const remoteAddress =
    (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || "";

  let pathname;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    pathname = decodeURIComponent(url.pathname);
  } catch (_error) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  const normalizedPath = path.normalize(path.join(rootDirectory, pathname));
  const relative = path.relative(rootDirectory, normalizedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  let filePath = normalizedPath;
  let stats;
  try {
    stats = await fsPromises.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stats = await fsPromises.stat(filePath);
    }
  } catch (_error) {
    res.statusCode = 404;
    res.end("Not Found");
    console.info(`HTTP ${remoteAddress} - ${method} ${pathname} -> 404`);
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", getContentType(filePath));
  res.setHeader("Content-Length", stats.size);

  res.on("finish", () => {
    console.info(`HTTP ${remoteAddress} - ${method} ${pathname} -> ${res.statusCode}`);
  });

  if (method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", (error) => {
    console.error(`HTTP error serving ${pathname}: ${error.message}`);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

function serve(directory, port, bind) {
  const rootDirectory = path.resolve(directory);
  const server = http.createServer((req, res) => {
    handleRequest(req, res, rootDirectory).catch((error) => {
      console.error(`HTTP error: ${error.message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      } else {
        res.destroy(error);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      console.log(`Serving ${rootDirectory} at http://${bind}:${port} (Ctrl+C to stop)`);
      resolve(server);
    });
  });
}

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    bind: "0.0.0.0",
    masterInterval: DEFAULT_MASTER_INTERVAL,
    priceInterval: DEFAULT_PRICE_INTERVAL,
    directory: PROJECT_ROOT,
    masterOutput: SNAPSHOT_PATH,
    priceOutput: PRICE_CACHE_PATH,
    priceLookback: DEFAULT_LOOKBACK_DAYS,
    priceConcurrency: DEFAULT_CONCURRENCY,
    priceCount: MAX_CANDLES,
    logLevel: "INFO",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    switch (token) {
      case "--port":
        if (value) {
          args.port = Number(value);
          index += 1;
        }
        break;
      case "--bind":
        if (value) {
          args.bind = value;
          index += 1;
        }
        break;
      case "--master-interval":
        if (value) {
          args.masterInterval = Number(value);
          index += 1;
        }
        break;
      case "--price-interval":
        if (value) {
          args.priceInterval = Number(value);
          index += 1;
        }
        break;
      case "--directory":
        if (value) {
          args.directory = value;
          index += 1;
        }
        break;
      case "--output":
      case "--master-output":
        if (value) {
          args.masterOutput = value;
          index += 1;
        }
        break;
      case "--price-output":
        if (value) {
          args.priceOutput = value;
          index += 1;
        }
        break;
      case "--price-lookback":
        if (value) {
          args.priceLookback = Number(value);
          index += 1;
        }
        break;
      case "--price-concurrency":
        if (value) {
          args.priceConcurrency = Number(value);
          index += 1;
        }
        break;
      case "--price-count":
        if (value) {
          args.priceCount = Number(value);
          index += 1;
        }
        break;
      case "--log-level":
        if (value) {
          args.logLevel = value.toUpperCase();
          index += 1;
        }
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(args.port) || args.port <= 0) {
    args.port = DEFAULT_PORT;
  }
  if (!Number.isFinite(args.masterInterval) || args.masterInterval <= 0) {
    args.masterInterval = DEFAULT_MASTER_INTERVAL;
  }
  if (!Number.isFinite(args.priceInterval) || args.priceInterval <= 0) {
    args.priceInterval = DEFAULT_PRICE_INTERVAL;
  }
  if (!Number.isFinite(args.priceLookback) || args.priceLookback <= 0) {
    args.priceLookback = DEFAULT_LOOKBACK_DAYS;
  }
  if (!Number.isFinite(args.priceConcurrency) || args.priceConcurrency < 1) {
    args.priceConcurrency = DEFAULT_CONCURRENCY;
  }
  if (!Number.isFinite(args.priceCount) || args.priceCount < 1) {
    args.priceCount = MAX_CANDLES;
  }

  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const directory = path.resolve(args.directory);
  const masterPath = path.resolve(args.masterOutput);
  const pricePath = path.resolve(args.priceOutput);

  await fsPromises.mkdir(directory, { recursive: true });

  await runMasterUpdate(masterPath);
  await runPriceUpdate(masterPath, pricePath, {
    lookbackDays: args.priceLookback,
    concurrency: args.priceConcurrency,
    candleCount: Math.min(args.priceCount, MAX_CANDLES),
  });

  const masterTask = scheduleTask("master-updater", () => runMasterUpdate(masterPath), args.masterInterval);
  const priceTask = scheduleTask("price-updater", () =>
    runPriceUpdate(masterPath, pricePath, {
      lookbackDays: args.priceLookback,
      concurrency: args.priceConcurrency,
      candleCount: Math.min(args.priceCount, MAX_CANDLES),
    }), args.priceInterval);

  const server = await serve(directory, args.port, args.bind);

  await new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.log("Shutting down server...");
      masterTask.cancel();
      priceTask.cancel();
      server.close(() => resolve());
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
};

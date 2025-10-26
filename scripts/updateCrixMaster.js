#!/usr/bin/env node
"use strict";

const fsPromises = require("fs").promises;
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const CRIX_MASTER_URL = "https://crix-static.upbit.com/v2/crix_master";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "crix_master.json");
const USER_AGENT = "UpbitListingMonitor/1.0 (+https://upbit.com)";

function requestBuffer(url, { headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const options = {
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      const statusCode = res.statusCode || 0;
      if (statusCode >= 400) {
        const error = new Error(`Request failed with status ${statusCode}`);
        error.name = "HTTPError";
        error.statusCode = statusCode;
        error.statusMessage = res.statusMessage;
        res.resume();
        reject(error);
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers["content-encoding"] || "";
        if (encoding.includes("gzip")) {
          zlib.gunzip(buffer, (error, result) => {
            if (error) {
              reject(error);
            } else {
              resolve(result);
            }
          });
        } else if (encoding.includes("deflate")) {
          zlib.inflate(buffer, (error, result) => {
            if (error) {
              reject(error);
            } else {
              resolve(result);
            }
          });
        } else {
          resolve(buffer);
        }
      });
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", (err) => reject(err));
    req.end();
  });
}

async function readRemote(url) {
  const body = await requestBuffer(url);
  return JSON.parse(body.toString("utf-8"));
}

async function readLocal(filePath) {
  try {
    const data = await fsPromises.readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function extractCodes(records) {
  return new Set(
    (records || [])
      .map((record) => (record && record.code ? record.code : null))
      .filter(Boolean)
  );
}

async function writeJson(filePath, payload) {
  const directory = path.dirname(filePath);
  await fsPromises.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fsPromises.writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  await fsPromises.rename(tempPath, filePath);
}

async function syncCrixMaster(outputPath) {
  let remotePayload;
  try {
    remotePayload = await readRemote(CRIX_MASTER_URL);
  } catch (error) {
    const message =
      error.name === "HTTPError"
        ? `[update-crix] HTTP error: ${error.statusCode} ${error.statusMessage || ""}`.trim()
        : `[update-crix] Network error: ${error.message}`;
    console.error(message);
    return 1;
  }

  let localPayload;
  try {
    localPayload = await readLocal(outputPath);
  } catch (error) {
    console.error(`[update-crix] Failed to read local snapshot: ${error.message}`);
    localPayload = [];
  }

  const remoteCodes = extractCodes(remotePayload);
  const localCodes = extractCodes(localPayload);

  const newCodes = Array.from(remoteCodes).filter((code) => !localCodes.has(code)).sort();
  const removedCodes = Array.from(localCodes).filter((code) => !remoteCodes.has(code)).sort();

  if (newCodes.length > 0) {
    console.log(`[update-crix] ${newCodes.length} new listing(s): ${newCodes.join(", ")}`);
  }

  if (removedCodes.length > 0) {
    console.log(`[update-crix] ${removedCodes.length} listing(s) removed upstream: ${removedCodes.join(", ")}`);
  }

  if (JSON.stringify(remotePayload) !== JSON.stringify(localPayload)) {
    await writeJson(outputPath, remotePayload);
    console.log(`[update-crix] Snapshot updated: ${outputPath}`);
  } else {
    console.log("[update-crix] No changes detected.");
  }

  return 0;
}

function parseArgs(argv) {
  const args = { output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if ((token === "-o" || token === "--output") && argv[index + 1]) {
      args.output = path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const exitCode = await syncCrixMaster(path.resolve(args.output));
  return exitCode;
}

if (require.main === module) {
  main().then(
    (code) => process.exitCode = code,
    (error) => {
      console.error(`[update-crix] Unexpected error: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  CRIX_MASTER_URL,
  DEFAULT_OUTPUT,
  USER_AGENT,
  syncCrixMaster,
  readRemote,
  requestBuffer,
};

const STATUS = document.getElementById("status");
const TABLE_BODY = document.getElementById("coin-table");
const CONTROLS = document.getElementById("range-controls");
const HEADER_SORT_BUTTONS = document.querySelectorAll("th.sortable button");

const DATA_URL = "price_cache.json";
const NUMBER_FORMAT = new Intl.NumberFormat("ko-KR");
const PERCENT_FORMAT = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const SORT_ICONS = { asc: "▲", desc: "▼", none: "↕" };
const DEFAULT_SORT_DIRECTION = {
  name: "asc",
  listingDate: "desc",
  listingPrice: "desc",
  currentPrice: "desc",
  change: "desc",
};

let priceCache = null;
let allCoins = [];
let currentRows = [];
let currentMonths = 1;
let sortKey = "listingDate";
let sortDirection = "desc";
let rowsReady = false;

function setStatus(text) {
  STATUS.textContent = text ?? "";
}

function subtractMonths(base, months) {
  const result = new Date(base);
  result.setMonth(result.getMonth() - months);
  return result;
}

function sampleSeries(series, maxPoints = 40) {
  if (!Array.isArray(series) || series.length <= maxPoints) {
    return series;
  }
  const step = (series.length - 1) / (maxPoints - 1);
  const sampled = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round(i * step);
    sampled.push(series[index]);
  }
  return sampled;
}

function renderSparkline(prices) {
  if (!prices || prices.length < 2) {
    return '<div class="empty">데이터 없음</div>';
  }
  const sampled = sampleSeries(prices);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const width = 100;
  const height = 40;
  const range = max - min || 1;
  const step = sampled.length > 1 ? width / (sampled.length - 1) : 0;
  const points = sampled.map((price, index) => {
    const isLast = index === sampled.length - 1;
    const x = isLast ? width : index * step;
    const y = height - ((price - min) / range) * height;
    return { x, y };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const latest = points[points.length - 1];
  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${path}" vector-effect="non-scaling-stroke"></path>
      <circle cx="${latest.x.toFixed(2)}" cy="${latest.y.toFixed(2)}" r="3" />
    </svg>
  `;
}

function getSortableValue(row, key) {
  if (!row) {
    return null;
  }
  if (row.status === "error" && key !== "name" && key !== "listingDate") {
    return null;
  }
  switch (key) {
    case "name":
      return row.koreanName || row.pair || row.englishName || "";
    case "listingDate":
      return row.listingDate || "";
    case "listingPrice":
      return Number.isFinite(row.listingPrice) ? row.listingPrice : null;
    case "currentPrice":
      return Number.isFinite(row.currentPrice) ? row.currentPrice : null;
    case "change":
      return Number.isFinite(row.change) ? row.change : null;
    default:
      return null;
  }
}

function sortRows(rows) {
  const copy = rows.slice();
  copy.sort((a, b) => {
    if (!a && !b) {
      return 0;
    }
    if (!a) {
      return 1;
    }
    if (!b) {
      return -1;
    }
    if (a.status === "error" && b.status !== "error") {
      return 1;
    }
    if (a.status !== "error" && b.status === "error") {
      return -1;
    }

    const valueA = getSortableValue(a, sortKey);
    const valueB = getSortableValue(b, sortKey);

    if (valueA == null && valueB == null) {
      return 0;
    }
    if (valueA == null) {
      return 1;
    }
    if (valueB == null) {
      return -1;
    }

    let comparison;
    if (typeof valueA === "string" || typeof valueB === "string") {
      comparison = String(valueA).localeCompare(String(valueB), "ko", { sensitivity: "base" });
    } else {
      comparison = Number(valueA) - Number(valueB);
    }

    if (comparison === 0) {
      comparison = String(a.listingDate).localeCompare(String(b.listingDate));
    }

    if (sortDirection === "desc") {
      comparison *= -1;
    }

    return comparison;
  });

  return copy;
}

function applySortAndRender() {
  if (!rowsReady) {
    return;
  }
  const sorted = sortRows(currentRows);
  renderTableRows(sorted);
}

function updateSortIndicators() {
  HEADER_SORT_BUTTONS.forEach((button) => {
    const key = button.dataset.sortKey;
    const th = button.closest("th");
    let ariaSort = "none";
    let icon = SORT_ICONS.none;

    if (key === sortKey) {
      ariaSort = sortDirection === "asc" ? "ascending" : "descending";
      icon = sortDirection === "asc" ? SORT_ICONS.asc : SORT_ICONS.desc;
    }

    if (th) {
      th.setAttribute("aria-sort", ariaSort);
    }
    button.setAttribute("aria-sort", ariaSort);
    const iconElement = button.querySelector(".sort-icon");
    if (iconElement) {
      iconElement.textContent = icon;
    }
  });
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value >= 1000) {
    return NUMBER_FORMAT.format(Math.round(value));
  }
  if (value >= 1) {
    return value.toFixed(2);
  }
  if (value >= 0.01) {
    return value.toFixed(4);
  }
  return value.toPrecision(4);
}

function renderTableRows(rows) {
  const validRows = rows.filter(Boolean);
  if (!validRows.length) {
    TABLE_BODY.innerHTML = `<tr><td colspan="6" class="empty">선택한 기간에 해당하는 신규 상장 코인이 없습니다.</td></tr>`;
    return;
  }

  const markup = validRows
    .map((row) => {
      if (row.status === "error") {
        return `
          <tr>
            <td class="coin-cell">
              <span class="coin-name">${row.koreanName} (${row.pair})</span>
              <span class="coin-meta">${row.englishName}</span>
            </td>
            <td>${row.listingDate}</td>
            <td colspan="4" class="empty">가격 데이터를 불러오지 못했습니다. (${row.error})</td>
          </tr>
        `;
      }

      const trendClass = row.change >= 0 ? "rise" : "fall";
      const changeIcon = row.change >= 0 ? "▲" : "▼";
      return `
        <tr class="${trendClass}">
          <td class="coin-cell">
            <span class="coin-name">${row.koreanName} (${row.pair})</span>
            <span class="coin-meta">${row.englishName}</span>
          </td>
          <td>${row.listingDate}</td>
          <td class="price">${formatPrice(row.listingPrice)} KRW</td>
          <td class="price">${formatPrice(row.currentPrice)} KRW</td>
          <td>
            <span class="price-change">
              <span>${changeIcon} ${PERCENT_FORMAT.format(row.change)}%</span>
            </span>
          </td>
          <td class="sparkline">${renderSparkline(row.prices)}</td>
        </tr>
      `;
    })
    .join("");
  TABLE_BODY.innerHTML = markup;
}

function filterCoinsByMonths(months) {
  const now = new Date();
  const threshold = subtractMonths(now, months);
  return allCoins.filter((coin) => {
    const listDate = new Date(`${coin.listingDate}T00:00:00Z`);
    return listDate >= threshold && listDate <= now;
  });
}

async function hydrateTable(months) {
  currentMonths = months;
  const selected = filterCoinsByMonths(months);
  setStatus(`총 ${selected.length}개 코인 확인 중...`);
  TABLE_BODY.innerHTML = `<tr><td colspan="6" class="empty">데이터를 불러오는 중입니다...</td></tr>`;

  currentRows = selected;
  rowsReady = true;

  const message = selected.length
    ? `최근 ${months}개월 내 상장한 ${selected.length}개 코인`
    : "해당 기간 내 상장한 코인이 없습니다.";
  const updatedAtText = priceCache?.generatedAt ? ` · 업데이트: ${priceCache.generatedAt}` : "";
  setStatus(`${message}${updatedAtText}`);
  updateSortIndicators();
  applySortAndRender();
}

async function bootstrap() {
  try {
    setStatus("가격 캐시 로딩 중...");
    const response = await fetch(DATA_URL, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`price_cache.json 로딩 실패 (HTTP ${response.status})`);
    }
    priceCache = await response.json();
    allCoins = Array.isArray(priceCache.coins) ? priceCache.coins : [];
    await hydrateTable(currentMonths);
  } catch (error) {
    setStatus(error.message);
    TABLE_BODY.innerHTML = `<tr><td colspan="6" class="empty">데이터를 불러오지 못했습니다. 브라우저 콘솔을 확인하세요.</td></tr>`;
    console.error(error);
  }
}

CONTROLS.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-months]");
  if (!button) {
    return;
  }
  const months = Number(button.dataset.months);
  if (months === currentMonths) {
    return;
  }
  document.querySelectorAll("#range-controls button").forEach((node) => node.classList.remove("active"));
  button.classList.add("active");
  hydrateTable(months);
});

HEADER_SORT_BUTTONS.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sortKey;
    if (!key) {
      return;
    }
    if (sortKey === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDirection = DEFAULT_SORT_DIRECTION[key] || "desc";
    }
    updateSortIndicators();
    applySortAndRender();
  });
});

updateSortIndicators();
bootstrap();

"use strict";

// ── DOM refs ────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const elBaseFee       = $("#base-fee");
const elTrend         = $("#trend");
const elBadge         = $("#congestion-badge");
const elErrorBanner   = $("#error-banner");
const elSetupBanner   = $("#setup-banner");
const elDashboard     = $("#dashboard");
const elLastUpdated   = $("#last-updated");
const elBtnRefresh    = $("#btn-refresh");
const elBtnAdvanced   = $("#btn-advanced");
const elAdvancedPanel = $("#advanced-panel");
const elBtnOptions    = $("#btn-open-options");

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";

// ── State ───────────────────────────────────────────────────────────
let rpcUrl       = DEFAULT_RPC;
let refreshTimer = null;
let gasData      = null; // last computed result
let lastFetchTime = null;
let agoTimer      = null;

// ── Helpers ─────────────────────────────────────────────────────────
function weiToGwei(hexOrBigInt) {
  const wei = typeof hexOrBigInt === "string"
    ? BigInt(hexOrBigInt)
    : BigInt(hexOrBigInt);
  // Return gwei as a float (number). Fine for display precision.
  return Number(wei) / 1e9;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function gwei(n) {
  n = Number(n);
  if (n === 0) return "0.000";
  if (n >= 0.001) return n.toFixed(3);     // 35.200, 0.055
  if (n >= 0.00001) return n.toFixed(5);   // 0.00050
  return n.toFixed(7);                      // 0.0000032
}

function updateBadge(gweiNum) {
  let text;
  if (gweiNum >= 100)  text = Math.round(gweiNum).toString();
  else if (gweiNum >= 10) text = gweiNum.toFixed(1);
  else text = gweiNum.toFixed(3);

  let color;
  if (gweiNum >= 50)      color = "#dc2626";
  else if (gweiNum >= 20) color = "#f59e0b";
  else if (gweiNum >= 5)  color = "#3b82f6";
  else                    color = "#22c55e";

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function showError(msg) {
  elErrorBanner.textContent = msg;
  elErrorBanner.classList.remove("hidden");
}

function clearError() {
  elErrorBanner.classList.add("hidden");
  elErrorBanner.textContent = "";
}

// ── RPC call ────────────────────────────────────────────────────────
async function callRpc(method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

// ── Fee history parsing ─────────────────────────────────────────────
function parseFeeHistory(raw) {
  // raw.baseFeePerGas: hex[] (length blockCount + 1)
  // raw.reward: hex[][] (per block, per percentile)
  // raw.gasUsedRatio: float[]

  if (!raw || !raw.baseFeePerGas || !raw.reward || !raw.gasUsedRatio) {
    throw new Error("Malformed eth_feeHistory response");
  }

  const baseFees    = raw.baseFeePerGas.map(weiToGwei);
  const gasUsed     = raw.gasUsedRatio;
  const rewardsByPc = [[], [], [], [], []]; // p10, p25, p50, p75, p90

  for (const blockRewards of raw.reward) {
    if (!blockRewards || blockRewards.length < 5) continue;
    for (let i = 0; i < 5; i++) {
      rewardsByPc[i].push(weiToGwei(blockRewards[i]));
    }
  }

  return { baseFees, gasUsed, rewardsByPc };
}

// ── Core computation ────────────────────────────────────────────────
function compute(parsed) {
  const { baseFees, gasUsed, rewardsByPc } = parsed;

  // (a) Current base fee = last element of baseFeePerGas
  const currentBaseFee = baseFees[baseFees.length - 1];

  // (b) Trend: avg of last 5 vs previous 5 base fees
  //     baseFees has 21 entries (blockCount+1), indices 0..20
  //     "last 5 blocks" = indices 16..20, "previous 5" = 11..15
  const len = baseFees.length;
  const recent5   = baseFees.slice(Math.max(0, len - 5));
  const previous5 = baseFees.slice(Math.max(0, len - 10), Math.max(0, len - 5));

  const avgRecent   = recent5.reduce((a, b) => a + b, 0) / recent5.length;
  const avgPrevious = previous5.length
    ? previous5.reduce((a, b) => a + b, 0) / previous5.length
    : avgRecent;

  const pctChange = avgPrevious > 0
    ? ((avgRecent - avgPrevious) / avgPrevious) * 100
    : 0;

  let trend;
  if (pctChange > 5)       trend = "rising";
  else if (pctChange < -5) trend = "falling";
  else                     trend = "flat";

  // (c) Tip bands (medians across 20 blocks)
  const p10Med = median(rewardsByPc[0]);
  const p25Med = median(rewardsByPc[1]); // cheapTip
  const p50Med = median(rewardsByPc[2]); // normalTip
  const p75Med = median(rewardsByPc[3]); // fastTip
  const p90Med = median(rewardsByPc[4]); // urgentTip

  // (e) Congestion — compute before recommendations so we can use it
  const last10 = gasUsed.slice(-10);
  const fullness = last10.reduce((a, b) => a + b, 0) / last10.length;
  const dispersion = p90Med - p50Med;

  let congestion;
  if (fullness > 0.95 || dispersion > 5 || (trend === "rising" && pctChange > 15)) {
    congestion = "CONGESTED";
  } else if (fullness >= 0.85) {
    congestion = "CHOPPY";
  } else {
    congestion = "FAVORABLE";
  }

  // (d) Inclusion recommendations
  const nextBlockTip = congestion === "CONGESTED" ? p90Med : p75Med;
  const midTip       = p50Med;
  const bargainTip   = p25Med;

  // Suggested maxFeePerGas = 2 * currentBaseFee + chosenTip
  const makeRow = (tip) => ({
    tip:    round(tip, 6),
    maxFee: round(2 * currentBaseFee + tip, 6),
  });

  return {
    currentBaseFee: round(currentBaseFee, 6),
    baseFees,
    trend,
    pctChange: round(pctChange, 1),
    congestion,
    fullness:   round(fullness, 4),
    dispersion: round(dispersion, 6),
    tips: { p10: round(p10Med, 6), p25: round(p25Med, 6), p50: round(p50Med, 6), p75: round(p75Med, 6), p90: round(p90Med, 6) },
    rows: {
      next:    makeRow(nextBlockTip),
      mid:     makeRow(midTip),
      bargain: makeRow(bargainTip),
    },
  };
}

// ── Render ───────────────────────────────────────────────────────────
function render(data) {
  gasData = data;

  // Base fee
  elBaseFee.textContent = gwei(data.currentBaseFee);

  // Trend sparkline
  const colorMap = { rising: "#f87171", flat: "#a1a1aa", falling: "#4ade80" };
  const stroke = colorMap[data.trend] || "#a1a1aa";
  const fees = data.baseFees;
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  const range = max - min || 1;
  const w = 120, h = 36, pad = 2;
  const points = fees.map((v, i) => {
    const x = pad + (i / (fees.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const fillPts = [
    `${pad},${h}`,
    ...points,
    `${w - pad},${h}`,
  ].join(" ");
  elTrend.innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" class="sparkline">` +
    `<polygon points="${fillPts}" fill="${stroke}" fill-opacity="0.15"/>` +
    `<polyline points="${points.join(" ")}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${points[points.length - 1].split(",")[0]}" cy="${points[points.length - 1].split(",")[1]}" r="3" fill="${stroke}"/>` +
    `</svg>`;
  elTrend.className = "stat-chart";

  // Congestion badge
  elBadge.textContent = data.congestion;
  elBadge.className = "stat-badge badge-" + data.congestion.toLowerCase();

  // Tier rows
  for (const [key, row] of Object.entries(data.rows)) {
    const el = document.getElementById(`gwei-${key}`);
    if (el) el.textContent = gwei(row.maxFee);
  }

  // Advanced
  $("#adv-fullness").textContent   = (data.fullness * 100).toFixed(1) + "%";
  $("#adv-dispersion").textContent = gwei(data.dispersion) + " gwei";
  $("#adv-p10").textContent        = gwei(data.tips.p10) + " gwei";
  $("#adv-p25").textContent        = gwei(data.tips.p25) + " gwei";
  $("#adv-p50").textContent        = gwei(data.tips.p50) + " gwei";
  $("#adv-p75").textContent        = gwei(data.tips.p75) + " gwei";
  $("#adv-p90").textContent        = gwei(data.tips.p90) + " gwei";

  // Timestamp
  lastFetchTime = Date.now();
  updateTimestamp();
}

function updateTimestamp() {
  if (!lastFetchTime) return;
  const ago = Math.round((Date.now() - lastFetchTime) / 1000);
  const time = new Date(lastFetchTime).toLocaleTimeString();
  elLastUpdated.textContent = `${time} (${ago}s ago)`;
}

// ── Main fetch cycle ────────────────────────────────────────────────
async function refresh() {
  clearError();
  elBtnRefresh.classList.add("spinning");

  try {
    const raw = await callRpc("eth_feeHistory", [
      "0xa",        // 10 blocks (Cloudflare free-tier max)
      "latest",
      [10, 25, 50, 75, 90],
    ]);

    const parsed  = parseFeeHistory(raw);
    const data    = compute(parsed);
    render(data);
    updateBadge(data.currentBaseFee);

    elDashboard.classList.remove("hidden");
  } catch (err) {
    const msg = err.name === "AbortError"
      ? "Request timed out (10 s). Check your RPC URL."
      : `Error: ${err.message}`;
    showError(msg);
  } finally {
    elBtnRefresh.classList.remove("spinning");
  }
}

// ── Init ────────────────────────────────────────────────────────────
async function init() {
  // Wire up buttons
  elBtnRefresh.addEventListener("click", refresh);

  elBtnAdvanced.addEventListener("click", () => {
    const show = elAdvancedPanel.classList.toggle("hidden");
    elBtnAdvanced.classList.toggle("active", !show);
  });
  // toggle starts hidden, so first click removes hidden -> show=false, active=true. Correct.

  elBtnOptions.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  elBaseFee.addEventListener("click", () => {
    const text = elBaseFee.textContent;
    if (!text || text === "—") return;
    navigator.clipboard.writeText(text).then(() => {
      const orig = elBaseFee.textContent;
      elBaseFee.textContent = "\u2713";
      setTimeout(() => { elBaseFee.textContent = orig; }, 800);
    });
  });

  // Load RPC URL (fall back to public default)
  const stored = await chrome.storage.local.get("rpcUrl");
  rpcUrl = (stored.rpcUrl || "").trim() || DEFAULT_RPC;

  if (!rpcUrl.startsWith("https://")) {
    showError("RPC URL must start with https://. Update it in Settings.");
    return;
  }

  // Initial fetch + auto-refresh
  await refresh();
  refreshTimer = setInterval(refresh, 30000);
  agoTimer = setInterval(updateTimestamp, 1000);
}

init();

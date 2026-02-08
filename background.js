"use strict";

const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";
const ALARM_NAME = "gas-trax-refresh";

// ── Badge formatting ────────────────────────────────────────────────
function badgeText(gweiNum) {
  if (gweiNum >= 100)  return Math.round(gweiNum).toString();
  if (gweiNum >= 10)   return gweiNum.toFixed(1);
  return gweiNum.toFixed(3);
}

function badgeColor(gweiNum) {
  if (gweiNum >= 50)  return "#dc2626"; // red — expensive
  if (gweiNum >= 20)  return "#f59e0b"; // amber
  if (gweiNum >= 5)   return "#3b82f6"; // blue — moderate
  return "#22c55e";                      // green — cheap
}

// ── Fetch base fee and update badge ─────────────────────────────────
async function updateBadge() {
  let rpcUrl = DEFAULT_RPC;
  try {
    const stored = await chrome.storage.local.get("rpcUrl");
    rpcUrl = (stored.rpcUrl || "").trim() || DEFAULT_RPC;
  } catch {}

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_feeHistory",
        params: ["0x1", "latest", []],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const json = await res.json();

    if (json.error) throw new Error(json.error.message);
    if (!json.result || !json.result.baseFeePerGas) throw new Error("bad response");

    const baseFees = json.result.baseFeePerGas;
    const latestWei = BigInt(baseFees[baseFees.length - 1]);
    const gweiNum = Number(latestWei) / 1e9;

    await chrome.action.setBadgeText({ text: badgeText(gweiNum) });
    await chrome.action.setBadgeBackgroundColor({ color: badgeColor(gweiNum) });
  } catch {
    await chrome.action.setBadgeText({ text: "..." });
    await chrome.action.setBadgeBackgroundColor({ color: "#71717a" });
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 }); // every 30s
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) updateBadge();
});

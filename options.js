"use strict";

const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";

const elInput  = document.getElementById("rpc-url");
const elSave   = document.getElementById("btn-save");
const elReset  = document.getElementById("btn-reset");
const elStatus = document.getElementById("status");

function flash(msg, ok) {
  elStatus.textContent = msg;
  elStatus.className = ok ? "status-ok" : "status-error";
  setTimeout(() => { elStatus.textContent = ""; }, 3000);
}

// Load saved URL on open (show default as placeholder)
chrome.storage.local.get("rpcUrl", (data) => {
  elInput.value = data.rpcUrl || "";
  elInput.placeholder = DEFAULT_RPC;
});

// Save
elSave.addEventListener("click", () => {
  const url = elInput.value.trim();

  if (!url) {
    flash("URL cannot be empty.", false);
    return;
  }

  if (!url.startsWith("https://")) {
    flash("URL must start with https://", false);
    return;
  }

  try {
    new URL(url); // basic parse check
  } catch {
    flash("Invalid URL format.", false);
    return;
  }

  chrome.storage.local.set({ rpcUrl: url }, () => {
    flash("Saved!", true);
  });
});

// Reset to default
elReset.addEventListener("click", () => {
  elInput.value = "";
  chrome.storage.local.remove("rpcUrl", () => {
    flash("Reset to default (" + DEFAULT_RPC + ")", true);
  });
});

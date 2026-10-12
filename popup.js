"use strict";

const checkbox = document.getElementById("enabled");
const state = document.getElementById("state");
const error = document.getElementById("error");

let confirmedEnabled = true;
let initialized = false;
let saving = false;
let storageVersion = 0;

function readEnabled(value) {
  return typeof value === "boolean" ? value : true;
}

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

function render() {
  checkbox.checked = confirmedEnabled;
  checkbox.disabled = !initialized || saving;
  state.textContent = saving ? "저장 중…" : confirmedEnabled ? "켜짐" : "꺼짐";
  state.dataset.enabled = String(confirmedEnabled);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !Object.hasOwn(changes, "enabled")) {
    return;
  }

  storageVersion += 1;
  confirmedEnabled = readEnabled(changes.enabled.newValue);
  if (initialized) {
    render();
  }
});

checkbox.addEventListener("change", async () => {
  if (!initialized || saving) {
    return;
  }

  const requestedEnabled = checkbox.checked;
  const versionBeforeSave = storageVersion;
  saving = true;
  checkbox.disabled = true;
  state.textContent = "저장 중…";
  showError("");

  try {
    await chrome.storage.local.set({ enabled: requestedEnabled });
    // A storage event may already contain a newer setting from another popup.
    if (storageVersion === versionBeforeSave) {
      confirmedEnabled = requestedEnabled;
    }
  } catch {
    showError("설정을 저장하지 못했습니다. 다시 시도해 주세요.");
  } finally {
    saving = false;
    render();
  }
});

async function initialize() {
  const versionBeforeLoad = storageVersion;

  try {
    const settings = await chrome.storage.local.get("enabled");
    if (storageVersion === versionBeforeLoad) {
      confirmedEnabled = readEnabled(settings.enabled);
    }
    initialized = true;
    render();
  } catch {
    checkbox.disabled = true;
    state.textContent = "설정 확인 불가";
    showError("설정을 불러오지 못했습니다. 팝업을 닫았다가 다시 열어 주세요.");
  }
}

initialize();

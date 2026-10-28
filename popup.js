"use strict";

const checkbox = document.getElementById("enabled");
const state = document.getElementById("state");
const maxReloadsInput = document.getElementById("max-reloads");
const reloadState = document.getElementById("reload-state");
const error = document.getElementById("error");

const DEFAULT_MAX_RELOADS = 3;
let confirmedEnabled = true;
let confirmedMaxReloads = DEFAULT_MAX_RELOADS;
let initialized = false;
let savingField = null;
const storageVersions = { enabled: 0, maxReloads: 0 };

function readEnabled(value) {
  return typeof value === "boolean" ? value : true;
}

function validMaxReloads(value) {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}

function readMaxReloads(value) {
  return validMaxReloads(value) ? value : DEFAULT_MAX_RELOADS;
}

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

function render({ keepReloadDraft = false } = {}) {
  checkbox.checked = confirmedEnabled;
  checkbox.disabled = !initialized || savingField !== null;
  maxReloadsInput.disabled = !initialized || savingField !== null;
  if (!keepReloadDraft) {
    maxReloadsInput.value = String(confirmedMaxReloads);
    maxReloadsInput.removeAttribute("aria-invalid");
  }
  state.textContent = savingField === "enabled" ? "저장 중…" : confirmedEnabled ? "켜짐" : "꺼짐";
  state.dataset.enabled = String(confirmedEnabled);
  reloadState.textContent = savingField === "maxReloads" ? "저장 중…" : "자동 저장";
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" ||
      (!Object.hasOwn(changes, "enabled") && !Object.hasOwn(changes, "maxReloads"))) {
    return;
  }

  if (Object.hasOwn(changes, "enabled")) {
    storageVersions.enabled += 1;
    confirmedEnabled = readEnabled(changes.enabled.newValue);
  }
  if (Object.hasOwn(changes, "maxReloads")) {
    storageVersions.maxReloads += 1;
    confirmedMaxReloads = readMaxReloads(changes.maxReloads.newValue);
  }
  if (initialized) {
    render({ keepReloadDraft: !Object.hasOwn(changes, "maxReloads") &&
      document.activeElement === maxReloadsInput });
  }
});

async function saveSetting(key, requestedValue) {
  const versionBeforeSave = storageVersions[key];
  savingField = key;
  checkbox.disabled = true;
  maxReloadsInput.disabled = true;
  if (key === "enabled") state.textContent = "저장 중…";
  else reloadState.textContent = "저장 중…";
  showError("");

  try {
    await chrome.storage.local.set({ [key]: requestedValue });
    // A storage event may already contain a newer setting from another popup.
    if (storageVersions[key] === versionBeforeSave) {
      if (key === "enabled") confirmedEnabled = requestedValue;
      else confirmedMaxReloads = requestedValue;
    }
  } catch {
    showError("설정을 저장하지 못했습니다. 다시 시도해 주세요.");
  } finally {
    savingField = null;
    render();
  }
}

checkbox.addEventListener("change", async () => {
  if (!initialized || savingField !== null) return;
  await saveSetting("enabled", checkbox.checked);
});

maxReloadsInput.addEventListener("input", () => {
  maxReloadsInput.removeAttribute("aria-invalid");
  showError("");
});

maxReloadsInput.addEventListener("change", async () => {
  if (!initialized || savingField !== null) return;
  const requestedMaxReloads = Number(maxReloadsInput.value);
  if (!validMaxReloads(requestedMaxReloads)) {
    maxReloadsInput.setAttribute("aria-invalid", "true");
    showError("새로고침 횟수는 1~10 사이의 정수로 입력해 주세요.");
    return;
  }
  await saveSetting("maxReloads", requestedMaxReloads);
});

async function initialize() {
  const versionsBeforeLoad = { ...storageVersions };

  try {
    const settings = await chrome.storage.local.get(["enabled", "maxReloads"]);
    if (storageVersions.enabled === versionsBeforeLoad.enabled) {
      confirmedEnabled = readEnabled(settings.enabled);
    }
    if (storageVersions.maxReloads === versionsBeforeLoad.maxReloads) {
      confirmedMaxReloads = readMaxReloads(settings.maxReloads);
    }
    initialized = true;
    render();
  } catch {
    checkbox.disabled = true;
    maxReloadsInput.disabled = true;
    state.textContent = "설정 확인 불가";
    reloadState.textContent = "설정 확인 불가";
    showError("설정을 불러오지 못했습니다. 팝업을 닫았다가 다시 열어 주세요.");
  }
}

initialize();

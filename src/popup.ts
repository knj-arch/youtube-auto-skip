type SettingKey = "enabled" | "maxReloads";
type SettingUpdate = { key: "enabled"; value: boolean } | { key: "maxReloads"; value: number };
type BrowserFamily = "Opera" | "Edge" | "Chrome" | "Firefox" | "Unknown";

function requiredElement<K extends keyof HTMLElementTagNameMap>(id: string, tagName: K): HTMLElementTagNameMap[K] {
  const element = document.getElementById(id);
  if (!element || element.tagName.toLowerCase() !== tagName) {
    throw new Error(`Required popup element is missing or has the wrong tag: ${id}`);
  }
  // IDs and tags are fixed in popup.html and checked above before this narrowing.
  return element as HTMLElementTagNameMap[K];
}

const checkbox = requiredElement("enabled", "input");
const state = requiredElement("state", "span");
const maxReloadsInput = requiredElement("max-reloads", "input");
const reloadState = requiredElement("reload-state", "span");
const error = requiredElement("error", "p");
const extensionVersion = chrome.runtime.getManifest().version;
requiredElement("version", "p").textContent = `버전 ${extensionVersion}`;

const DEFAULT_MAX_RELOADS = 3;
let confirmedEnabled = true;
let confirmedMaxReloads = DEFAULT_MAX_RELOADS;
let initialized = false;
let savingField: SettingKey | null = null;
const storageVersions: Record<SettingKey, number> = { enabled: 0, maxReloads: 0 };

function readEnabled(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

function validMaxReloads(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}

function readMaxReloads(value: unknown): number {
  return validMaxReloads(value) ? value : DEFAULT_MAX_RELOADS;
}

function showError(message: string): void {
  error.textContent = message;
  error.hidden = !message;
}

function render({ keepReloadDraft = false }: { keepReloadDraft?: boolean } = {}): void {
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
  if (areaName !== "local") return;
  const enabledChange = Object.hasOwn(changes, "enabled") ? changes["enabled"] : undefined;
  const limitChange = Object.hasOwn(changes, "maxReloads") ? changes["maxReloads"] : undefined;
  if (!enabledChange && !limitChange) return;

  if (enabledChange) {
    storageVersions.enabled += 1;
    confirmedEnabled = readEnabled(enabledChange.newValue);
  }
  if (limitChange) {
    storageVersions.maxReloads += 1;
    confirmedMaxReloads = readMaxReloads(limitChange.newValue);
  }
  if (initialized) {
    render({ keepReloadDraft: !limitChange && document.activeElement === maxReloadsInput });
  }
});

async function saveSetting(update: SettingUpdate): Promise<void> {
  const versionBeforeSave = storageVersions[update.key];
  savingField = update.key;
  checkbox.disabled = true;
  maxReloadsInput.disabled = true;
  if (update.key === "enabled") state.textContent = "저장 중…";
  else reloadState.textContent = "저장 중…";
  showError("");

  try {
    await chrome.storage.local.set({ [update.key]: update.value });
    // A storage event may already contain a newer setting from another popup.
    if (storageVersions[update.key] === versionBeforeSave) {
      if (update.key === "enabled") confirmedEnabled = update.value;
      else confirmedMaxReloads = update.value;
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
  await saveSetting({ key: "enabled", value: checkbox.checked });
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
  await saveSetting({ key: "maxReloads", value: requestedMaxReloads });
});

async function initialize(): Promise<void> {
  const versionsBeforeLoad = { ...storageVersions };

  try {
    const stored: unknown = await chrome.storage.local.get(["enabled", "maxReloads"]);
    if (!diagnosticObject(stored)) throw new Error("Popup settings unavailable");
    if (storageVersions.enabled === versionsBeforeLoad.enabled) {
      confirmedEnabled = readEnabled(stored["enabled"]);
    }
    if (storageVersions.maxReloads === versionsBeforeLoad.maxReloads) {
      confirmedMaxReloads = readMaxReloads(stored["maxReloads"]);
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

void initialize();

const diagnosticCheck = requiredElement("diagnostic-check", "button");
const diagnosticCopy = requiredElement("diagnostic-copy", "button");
const diagnosticStatus = requiredElement("diagnostic-status", "p");
const diagnosticResult = requiredElement("diagnostic-result", "div");
const diagnosticReport = requiredElement("diagnostic-report", "textarea");
const diagnosticCopyStatus = requiredElement("diagnostic-copy-status", "p");
const DIAGNOSTIC_TIMEOUT_MS = 5000;
const diagnosticReasons: ReadonlySet<string> = new Set([
  "no-active-tab", "no-content-script", "timeout", "unsupported-page", "unsupported",
  "disabled", "inactive", "document-changed", "reload-state-unavailable", "target-unavailable",
  "reload-limit", "retry-later", "busy", "debugger-unavailable", "cancelled", "cleanup-failed",
  "ad-not-showing", "failed", "invalid-request", "invalid-response", "tab-unavailable", "unavailable",
  "ok", "no-response", "message-failed"
]);
const diagnosticOperations: ReadonlySet<string> = new Set(["ad-reload-state", "reload-ad", "skip-ad", "ad-resume-complete"]);
let diagnosticInFlight = false;
let diagnosticJson = "";

function diagnosticObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnosticBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function diagnosticNumber(value: unknown, integer = false): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= 86400000 && (!integer || Number.isInteger(value)) ? value : null;
}

function diagnosticVersion(value: unknown): string | null {
  return typeof value === "string" && value.length <= 32 && /^\d+(?:\.\d+){1,3}$/.test(value) ? value : null;
}

function diagnosticReason(value: unknown): string | null {
  return value === undefined || value === null ? null :
    typeof value === "string" && diagnosticReasons.has(value) ? value : "unknown";
}

function diagnosticBrowser(): { family: BrowserFamily; version: string | null } {
  const userAgent = navigator.userAgent || "";
  const patterns: ReadonlyArray<readonly [BrowserFamily, RegExp]> = [
    ["Opera", /OPR\/([\d.]+)/], ["Edge", /Edg\/([\d.]+)/],
    ["Chrome", /Chrome\/([\d.]+)/], ["Firefox", /Firefox\/([\d.]+)/]
  ];
  for (const [family, expression] of patterns) {
    const match = expression.exec(userAgent);
    if (match) return { family, version: diagnosticVersion(match[1]) };
  }
  return { family: "Unknown", version: null };
}

function diagnosticAction(value: unknown) {
  if (!diagnosticObject(value)) return null;
  return {
    operation: typeof value["operation"] === "string" && diagnosticOperations.has(value["operation"]) ?
      value["operation"] : "unknown",
    ok: diagnosticBoolean(value["ok"]), reason: diagnosticReason(value["reason"]),
    reloadCount: diagnosticNumber(value["reloadCount"], true),
    elapsedMs: diagnosticNumber(value["elapsedMs"]), ageMs: diagnosticNumber(value["ageMs"])
  };
}

function diagnosticVisibility(value: unknown): "visible" | "hidden" | "prerender" | "unknown" {
  return value === "visible" || value === "hidden" || value === "prerender" ? value : "unknown";
}

function sanitizeDiagnostics(reply: unknown) {
  const report = { version: diagnosticVersion(extensionVersion), browser: diagnosticBrowser() };
  if (!diagnosticObject(reply) || typeof reply["ok"] !== "boolean") {
    return { ...report, ok: false as const, reason: "invalid-response" };
  }
  if (!reply["ok"]) return { ...report, ok: false as const, reason: diagnosticReason(reply["reason"]) || "unavailable" };
  const page = reply["page"];
  const content = reply["content"];
  if (!diagnosticObject(page) || !diagnosticObject(content) || typeof content["connected"] !== "boolean") {
    return { ...report, ok: false as const, reason: "invalid-response" };
  }
  const contentState: Record<string, unknown> = diagnosticObject(content["state"]) ? content["state"] : {};
  const foreground = diagnosticObject(content["lastForeground"]) ? content["lastForeground"] : null;
  return {
    ...report, ok: true as const, workerVersion: diagnosticVersion(reply["version"]),
    enabled: diagnosticBoolean(reply["enabled"]), maxReloads: validMaxReloads(reply["maxReloads"]) ? reply["maxReloads"] : null,
    page: {
      supported: diagnosticBoolean(page["supported"]), active: diagnosticBoolean(page["active"]),
      windowFocused: diagnosticBoolean(page["windowFocused"]), loading: diagnosticBoolean(page["loading"]),
      discarded: diagnosticBoolean(page["discarded"]), frozen: diagnosticBoolean(page["frozen"])
    },
    content: content["connected"] !== true ? {
      connected: false as const, reason: diagnosticReason(content["reason"]) || "invalid-response"
    } : {
      connected: true as const, build: diagnosticVersion(content["build"]), supported: diagnosticBoolean(content["supported"]),
      enabled: diagnosticBoolean(content["enabled"]), visibility: diagnosticVisibility(content["visibility"]),
      focused: diagnosticBoolean(content["focused"]), players: diagnosticNumber(content["players"], true),
      adPlayers: diagnosticNumber(content["adPlayers"], true), skipButtons: diagnosticNumber(content["skipButtons"], true),
      eligibleSkipButtons: diagnosticNumber(content["eligibleSkipButtons"], true),
      state: {
        ready: diagnosticBoolean(contentState["ready"]), reloadCount: diagnosticNumber(contentState["reloadCount"], true),
        refreshUnavailable: diagnosticBoolean(contentState["refreshUnavailable"]),
        reloading: diagnosticBoolean(contentState["reloading"]), nextReloadMs: diagnosticNumber(contentState["nextReloadMs"])
      },
      lastResult: diagnosticAction(content["lastResult"]),
      lastForeground: foreground ? {
        ageMs: diagnosticNumber(foreground["ageMs"]), adPlayers: diagnosticNumber(foreground["adPlayers"], true),
        focused: diagnosticBoolean(foreground["focused"])
      } : null
    },
    lastAction: diagnosticAction(reply["lastAction"])
  };
}

type DiagnosticAction = NonNullable<ReturnType<typeof diagnosticAction>>;
type RecentDiagnosticAction = DiagnosticAction & { ageMs: number };
type DiagnosticReport = ReturnType<typeof sanitizeDiagnostics>;

function recentDiagnosticAction(value: DiagnosticAction | null): value is RecentDiagnosticAction {
  return value !== null && value.ageMs !== null && value.ageMs <= 60000;
}

function positive(value: number | null): value is number {
  return value !== null && value > 0;
}

function describeDiagnostics(report: DiagnosticReport): string {
  if (!report.ok) {
    if (["unsupported-page", "unsupported"].includes(report.reason)) return "유튜브 영상 페이지에서 확인해 주세요.";
    if (report.reason === "no-active-tab") return "유튜브 영상 탭을 열고 다시 확인해 주세요.";
    if (report.reason === "timeout") return "상태 확인 시간이 초과됐어요. 다시 확인해 주세요.";
    return "상태를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.";
  }
  const { page, content } = report;
  if (page.supported === false || (content.connected && content.supported === false)) return "유튜브 영상 페이지에서 확인해 주세요.";
  if (report.enabled === false) return "자동 건너뛰기가 꺼져 있어요.";
  const latest = [report.lastAction, content.connected ? content.lastResult : null]
    .filter(recentDiagnosticAction).sort((a, b) => a.ageMs - b.ageMs)[0];
  if (latest?.ok === false && latest.reason === "timeout") return content.connected && positive(content.adPlayers) ?
    "광고를 감지했지만 시간 초과로 중단됨 — 다시 확인해 주세요." :
    "최근 자동 처리가 시간 초과로 중단됐어요. 다시 확인해 주세요.";
  if (!content.connected && page.loading === true) {
    return "유튜브 연결 대기 중 — 페이지를 불러오는 중이면 잠시 후 다시 확인해 주세요.";
  }
  if (!content.connected) return content.reason === "timeout" ?
    "유튜브 연결 시간이 초과됐어요 — 영상 페이지를 새로고침한 뒤 다시 확인해 주세요." :
    "유튜브 연결 안 됨 — 영상 페이지를 새로고침한 뒤 다시 확인해 주세요.";
  if (content.enabled === false) return "영상 페이지의 자동 처리가 꺼져 있어요. 새로고침한 뒤 다시 확인해 주세요.";
  if (page.discarded === true || page.frozen === true) return "영상 탭이 일시 중지돼 있어요. 영상 탭을 연 뒤 다시 확인해 주세요.";
  if (content.players === null || content.adPlayers === null) return "상태 일부를 확인하지 못했어요. 다시 확인해 주세요.";
  if (content.state.refreshUnavailable === true && content.state.ready !== true) {
    return "새로고침 상태를 읽지 못했어요. 잠시 후 다시 확인해 주세요.";
  }
  if (content.state.refreshUnavailable === true) return "새로고침을 진행하지 못했어요. 결과를 복사해 주세요.";
  if (content.state.reloading === true) return "광고를 감지해 새로고침하는 중이에요.";
  if (content.adPlayers > 0 && report.maxReloads !== null && content.state.reloadCount !== null &&
      content.state.reloadCount >= report.maxReloads) return positive(content.eligibleSkipButtons) ?
    "건너뛰기 버튼 감지됨 — 팝업을 닫으면 자동 처리돼요." :
    "새로고침 한도 도달 — 건너뛰기 버튼을 기다리고 있어요.";
  const foreground = content.lastForeground;
  const recentlyForeground = foreground?.focused === true && foreground.ageMs !== null && foreground.ageMs <= 10000;
  // Opening this popup can make content.focused false; that alone is not a failure.
  if ((page.active === false || page.windowFocused === false) && !recentlyForeground) {
    return "유튜브 영상 탭을 보고 있을 때 자동으로 동작해요.";
  }
  if (content.adPlayers > 0) return positive(content.state.nextReloadMs) ?
    "광고 감지됨 — 다음 새로고침을 기다리고 있어요." : "광고 감지됨 — 영상을 보는 동안 자동으로 처리해요.";
  if (content.players === 0) return page.loading === true ?
    "영상 플레이어 연결 대기 중 — 페이지를 불러오는 중이면 잠시 후 다시 확인해 주세요." :
    "영상 플레이어 연결 대기 중 — 페이지를 새로고침한 뒤 다시 확인해 주세요.";
  return "광고 감지 대기 중";
}

diagnosticCheck.addEventListener("click", async () => {
  if (diagnosticInFlight) return;
  diagnosticInFlight = true;
  diagnosticCheck.disabled = true;
  diagnosticCopy.disabled = true;
  diagnosticResult.hidden = true;
  diagnosticStatus.textContent = "상태 확인 중…";
  diagnosticCopyStatus.textContent = "";
  diagnosticJson = "";
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = {};
  try {
    const reply: unknown = await Promise.race([
      (async (): Promise<unknown> => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) {
          return { ok: false, reason: "no-active-tab" };
        }
        const response: unknown = await chrome.runtime.sendMessage({ type: "automation-diagnostics", tabId });
        return response;
      })(),
      new Promise<never>((_resolve, reject) => { timeoutId = setTimeout(() => reject(timeout), DIAGNOSTIC_TIMEOUT_MS); })
    ]);
    const report = sanitizeDiagnostics(reply);
    diagnosticJson = JSON.stringify(report, null, 2);
    diagnosticStatus.textContent = describeDiagnostics(report);
  } catch (failure: unknown) {
    const report = sanitizeDiagnostics({ ok: false, reason: failure === timeout ? "timeout" : "unavailable" });
    diagnosticJson = JSON.stringify(report, null, 2);
    diagnosticStatus.textContent = describeDiagnostics(report);
  } finally {
    clearTimeout(timeoutId);
    diagnosticReport.value = diagnosticJson;
    diagnosticResult.hidden = false;
    diagnosticCheck.disabled = false;
    diagnosticCopy.disabled = !diagnosticJson;
    diagnosticInFlight = false;
  }
});

diagnosticCopy.addEventListener("click", async () => {
  if (!diagnosticJson || diagnosticInFlight) return;
  try {
    await navigator.clipboard.writeText(diagnosticJson);
    diagnosticCopyStatus.textContent = "복사했어요.";
  } catch {
    diagnosticReport.value = diagnosticJson;
    diagnosticReport.focus();
    diagnosticReport.select();
    diagnosticCopyStatus.textContent = "선택된 결과를 Ctrl+C로 복사해 주세요.";
  }
});

export {};

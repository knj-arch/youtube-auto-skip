"use strict";

type OperationKind = "skip-ad" | "reload-ad";
type RequestKind = OperationKind | "ad-reload-state" | "ad-resume-complete";
type StopReason = "disabled" | "timeout" | "inactive" | "document-changed" |
  "ad-not-showing" | "reload-state-unavailable" | "reload-limit" |
  "target-unavailable" | "debugger-unavailable" | "cancelled";

interface ContentRequest {
  type: RequestKind;
  url: string;
  resumeTime?: unknown;
}

interface ContentSender extends chrome.runtime.MessageSender {
  frameId: 0;
  documentId: string;
  url: string;
  tab: chrome.tabs.Tab & { id: number };
}

interface ReloadReservation {
  videoId: string;
  sourceDocumentId: string;
  reloadCount: number;
  lastReloadAt: number;
}

interface ReloadRecord extends ReloadReservation, Record<string, unknown> {
  resumeTime?: unknown;
  resumeExpiresAt?: unknown;
  resumeDeliveredTo?: unknown;
}

interface Job {
  tabId: number;
  kind: OperationKind;
  videoId: string | null;
  windowId: number;
  documentId: string;
  url: string;
  startedAt: number;
  deadline: number;
  attached: boolean;
  pressed: boolean;
  reason?: StopReason;
  frameId?: string;
  loaderId?: string;
  ownDetach?: boolean;
  cleanupFailed?: boolean;
  cleanupPromise?: Promise<void>;
  diagnosticStale?: boolean;
  reloading?: boolean;
  reloadDispatched?: boolean;
  reloadCount?: number;
  reloadReservation?: ReloadReservation;
  previousReloadRecord?: ReloadRecord;
}

interface OperationReply {
  ok: boolean;
  reason?: StopReason | "failed" | "cleanup-failed" | "retry-later";
  reloading?: boolean;
  reloadCount?: number;
  retryAfterMs?: number;
}

interface ReloadStateSuccess {
  ok: true;
  reloaded: boolean;
  reloadCount: number;
  retryAfterMs: number;
  resumeTime?: number;
}

interface StateFailure {
  ok: false;
  reason: "reload-state-unavailable";
}

interface Settings {
  enabled: unknown;
  maxReloads: unknown;
}

interface LastAction {
  operation: OperationKind;
  ok: boolean;
  reason: string;
  reloadCount?: number;
  elapsedMs: number;
  at: number;
  documentId: string;
}

interface ContentConnected extends Record<string, unknown> {
  connected: true;
}

type ContentDiagnostics = ContentConnected | {
  connected: false;
  reason: "no-content-script" | "timeout" | "unsupported-page";
};

interface Diagnostics {
  ok: true;
  version: string;
  enabled: boolean;
  maxReloads: number;
  page: {
    supported: boolean | null;
    active: boolean;
    windowFocused: boolean;
    loading: boolean;
    discarded: boolean;
    frozen: boolean;
  };
  content: ContentDiagnostics;
  lastAction?: Omit<LastAction, "documentId" | "at"> & { ageMs: number };
}

interface SkipTarget {
  x: number;
  y: number;
  href: string;
}

const OPERATION_TIMEOUT_MS = 2000;
const RELOAD_OPERATION_TIMEOUT_MS = 10000;
const ATTEMPT_COOLDOWN_MS = 1500;
const RELOAD_INTERVAL_MS = 3000;
const RESUME_LIFETIME_MS = 60000;
const jobs = new Map<number, Job>();
const blockedDocuments = new Map<number, string>();
const lastAttempts = new Map<number, number>();
const reloadStateQueues = new Map<number, Promise<unknown>>();
const lastActions = new Map<number, LastAction>();
let automationPaused = false;

// This fixed expression returns only the current skip-button coordinates.
// Callers cannot supply JavaScript, CDP commands, selectors, or coordinates.
// Keep this function self-contained: CDP executes its serialized source.
function findSkipTarget(): SkipTarget | null {
  if (self !== top || location.origin !== "https://www.youtube.com" ||
      location.pathname !== "/watch" || document.visibilityState !== "visible") return null;
  const selector = [
    "button.ytp-skip-ad-button", "button.ytp-ad-skip-button-modern", "button.ytp-ad-skip-button",
    '[role="button"].ytp-skip-ad-button', '[role="button"].ytp-ad-skip-button-modern',
    '[role="button"].ytp-ad-skip-button'
  ].join(",");
  for (const player of document.querySelectorAll(".html5-video-player.ad-showing, .html5-video-player.ad-interrupting")) {
    for (const button of player.querySelectorAll(selector)) {
      if (!button.isConnected || button.closest(".html5-video-player") !== player ||
          button.matches(":disabled") ||
          button.closest('[hidden], [inert], [aria-disabled="true"], [aria-hidden="true"]')) continue;
      const style = getComputedStyle(button);
      if (!button.getClientRects().length || style.visibility !== "visible" ||
          style.pointerEvents === "none") continue;
      let hidden = false;
      for (let ancestor: Element | null = button; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (ancestorStyle.display === "none" || ancestorStyle.contentVisibility === "hidden" ||
            Number(ancestorStyle.opacity) === 0) hidden = true;
      }
      if (hidden) continue;
      const bounds = button.getBoundingClientRect();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (bounds.width <= 0 || bounds.height <= 0 || x < 0 || y < 0 ||
          x >= innerWidth || y >= innerHeight || !hit ||
          (hit !== button && !button.contains(hit))) continue;
      return { x, y, href: location.href };
    }
  }
  return null;
}
const TARGET_EXPRESSION = "(" + findSkipTarget.toString() + ")()";

class StopOperation extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isYoutubeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.href === value && url.origin === "https://www.youtube.com" &&
      !url.username && !url.password;
  } catch { return false; }
}

function isWatchUrl(value: unknown): value is string {
  return isYoutubeUrl(value) && new URL(value).pathname === "/watch";
}

function watchVideoId(value: unknown): string | null {
  if (!isWatchUrl(value)) return null;
  const ids = new URL(value).searchParams.getAll("v");
  const id = ids[0];
  return ids.length === 1 && typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function permittedRequest(message: unknown): message is ContentRequest {
  return isRecord(message) &&
    (message.type === "skip-ad" || message.type === "reload-ad" ||
      message.type === "ad-reload-state" || message.type === "ad-resume-complete") &&
    isWatchUrl(message.url) &&
    (message.type === "skip-ad" || watchVideoId(message.url) !== null);
}

function permittedSender(sender: chrome.runtime.MessageSender): sender is ContentSender {
  return sender.id === chrome.runtime.id && sender.frameId === 0 &&
    typeof sender.documentId === "string" && sender.documentId.length > 0 &&
    sender.documentId.length <= 128 &&
    (!sender.documentLifecycle || sender.documentLifecycle === "active") &&
    isInteger(sender.tab?.id) && sender.tab.id >= 0 &&
    isInteger(sender.tab.windowId) && sender.tab.windowId >= 0 &&
    isYoutubeUrl(sender.url);
}

async function readSettings(): Promise<Settings> {
  const settings: unknown = await chrome.storage.local.get({ enabled: true, maxReloads: 3 });
  if (!isRecord(settings)) throw new StopOperation("reload-state-unavailable");
  return { enabled: settings.enabled, maxReloads: settings.maxReloads };
}

function ensureRunning(job: Job): void {
  if (job.reason) throw new StopOperation(job.reason);
  if (automationPaused) throw new StopOperation("disabled");
  if (Date.now() >= job.deadline) throw new StopOperation("timeout");
}

async function step<T>(job: Job, action: () => Promise<T>): Promise<T> {
  ensureRunning(job);
  const result = await action();
  ensureRunning(job);
  return result;
}

function command(job: Job, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return step(job, () => chrome.debugger.sendCommand({ tabId: job.tabId }, method, params));
}

async function pauseAutomation(): Promise<void> {
  automationPaused = true;
  for (const job of jobs.values()) stop(job, "disabled");
  // Store only the user's on/off preference; no URLs or viewing records.
  await chrome.storage.local.set({ enabled: false }).catch(() => {});
}

function stop(job: Job, reason: StopReason): void {
  job.reason ||= reason;
  void cleanup(job);
}

async function cleanup(job: Job): Promise<void> {
  if (!job.attached) return;
  if (job.cleanupPromise) return job.cleanupPromise;
  job.cleanupPromise = (async () => {
    if (job.pressed) {
      // Cancel an interrupted press without clicking whatever replaced the page.
      await chrome.debugger.sendCommand({ tabId: job.tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: -1, y: -1, button: "left", buttons: 0, clickCount: 1
      }).catch(() => {});
      job.pressed = false;
    }
    job.ownDetach = true;
    try {
      await chrome.debugger.detach({ tabId: job.tabId });
    } catch {
      // A removed tab or a delivered onDetach event means the target is gone.
      // Otherwise retry once, without attaching to or inspecting another tab.
      const tabExists = await chrome.tabs.get(job.tabId).then(() => true, () => false);
      if (tabExists && job.attached) {
        await chrome.debugger.detach({ tabId: job.tabId }).catch(() => {
          if (job.attached) job.cleanupFailed = true;
        });
      }
    }
    job.attached = false;
    if (job.cleanupFailed) await pauseAutomation();
  })();
  return job.cleanupPromise;
}

async function checkDocumentAndForeground(job: Job, requireAd = false): Promise<Settings> {
  const [settings, tab, windowInfo, confirmation] = await step(job, () => Promise.all([
    readSettings(),
    chrome.tabs.get(job.tabId),
    chrome.windows.get(job.windowId),
    chrome.tabs.sendMessage<Record<string, unknown>, unknown>(job.tabId, {
      type: "confirm-skip-document", url: job.url, ...(requireAd ? { requireAd: true } : {})
    },
      { documentId: job.documentId, frameId: 0 })
  ]));
  if (settings.enabled === false) throw new StopOperation("disabled");
  if (!tab.active || tab.windowId !== job.windowId || !windowInfo.focused ||
      tab.discarded || tab.frozen) throw new StopOperation("inactive");
  // Subresources can keep an already valid, visible document "loading".
  // The pinned document reply, URLs and navigation events determine validity.
  // tabs.get may omit URL without the broad tabs permission. CDP below always
  // checks the actual URL; if Chrome exposes tab URLs, also check them here.
  if ((tab.url !== undefined && tab.url !== job.url) ||
      (tab.pendingUrl !== undefined && tab.pendingUrl !== job.url) ||
      !isRecord(confirmation) || !confirmation.ok || confirmation.url !== job.url) {
    throw new StopOperation("document-changed");
  }
  if (requireAd && confirmation.adShowing !== true) throw new StopOperation("ad-not-showing");
  return settings;
}

function maxReloads(value: unknown): number {
  return isFiniteNumber(value) ? Math.min(10, Math.max(1, Math.trunc(value))) : 3;
}

function recordAction(job: Job, reply: OperationReply): void {
  if (job.diagnosticStale) return;
  // One in-memory result per open tab, with no URL, title or viewing history.
  lastActions.set(job.tabId, { operation: job.kind, ok: reply.ok === true,
    reason: reply.ok === true ? "ok" : reply.reason || "failed",
    ...(isInteger(reply.reloadCount) ? { reloadCount: reply.reloadCount } : {}),
    elapsedMs: Math.max(0, Date.now() - job.startedAt), at: Date.now(), documentId: job.documentId });
}

async function contentDiagnostics(tabId: number): Promise<ContentDiagnostics> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage<Record<string, unknown>, unknown>(
        tabId, { type: "automation-content-status" }, { frameId: 0 })
        .then((reply): ContentDiagnostics => isRecord(reply) && reply.connected === true ?
          { ...reply, connected: true } : { connected: false, reason: "no-content-script" },
        (): ContentDiagnostics => ({ connected: false, reason: "no-content-script" })),
      new Promise<ContentDiagnostics>(resolve => {
        timer = setTimeout(() => resolve({ connected: false, reason: "timeout" }), 1500);
      })
    ]);
  } finally { clearTimeout(timer); }
}

async function collectDiagnostics(tabId: number): Promise<Diagnostics> {
  const [tab, settings] = await Promise.all([chrome.tabs.get(tabId), readSettings()]);
  const supported = typeof tab.url === "string" ? watchVideoId(tab.url) !== null : null;
  const [windowInfo, content] = await Promise.all([
    chrome.windows.get(tab.windowId),
    supported === false ? Promise.resolve<ContentDiagnostics>({ connected: false, reason: "unsupported-page" }) :
      contentDiagnostics(tabId)
  ]);
  const result: Diagnostics = { ok: true, version: chrome.runtime.getManifest().version,
    enabled: settings.enabled !== false, maxReloads: maxReloads(settings.maxReloads),
    page: { supported, active: tab.active === true, windowFocused: windowInfo.focused === true,
      loading: tab.status === "loading", discarded: tab.discarded === true, frozen: tab.frozen === true }, content };
  const last = lastActions.get(tabId);
  if (last) {
    const { documentId, at, ...publicResult } = last;
    result.lastAction = { ...publicResult, ageMs: Math.max(0, Date.now() - at) };
  }
  return result;
}

function reloadStateKey(tabId: number): string {
  return "ad-reload:" + tabId;
}

function withReloadState<T>(tabId: number, action: () => Promise<T>): Promise<T> {
  // Keep each tab's read/consume/write operations ordered, including tab removal.
  const previous = reloadStateQueues.get(tabId) || Promise.resolve();
  const operation = previous.catch(() => {}).then(action);
  reloadStateQueues.set(tabId, operation);
  const finish = () => {
    if (reloadStateQueues.get(tabId) === operation) reloadStateQueues.delete(tabId);
  };
  operation.then(finish, finish);
  return operation;
}

function isReloadRecord(record: unknown): record is ReloadRecord {
  return isRecord(record) && typeof record.videoId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(record.videoId) &&
    isInteger(record.reloadCount) && record.reloadCount >= 1 &&
    isFiniteNumber(record.lastReloadAt) && record.lastReloadAt >= 0 &&
    typeof record.sourceDocumentId === "string" && record.sourceDocumentId.length > 0 &&
    record.sourceDocumentId.length <= 128;
}

async function readReloadRecord(tabId: number): Promise<ReloadRecord | undefined> {
  const key = reloadStateKey(tabId);
  const result: unknown = await chrome.storage.session.get(key);
  if (!isRecord(result)) throw new StopOperation("reload-state-unavailable");
  const record = result[key];
  if (record === undefined) return undefined;
  if (!isReloadRecord(record)) throw new StopOperation("reload-state-unavailable");
  return record;
}

function retryAfter(record: ReloadRecord | undefined): number {
  return record ? Math.max(0, RELOAD_INTERVAL_MS - (Date.now() - record.lastReloadAt)) : 0;
}

function validResume(record: ReloadRecord | undefined): record is ReloadRecord & {
  resumeTime: number;
  resumeExpiresAt: number;
} {
  return record !== undefined && isFiniteNumber(record.resumeTime) && record.resumeTime > 0 &&
    isFiniteNumber(record.resumeExpiresAt) && Date.now() < record.resumeExpiresAt;
}

function withoutResume(record: ReloadRecord): ReloadRecord {
  const cleaned = { ...record };
  delete cleaned.resumeTime;
  delete cleaned.resumeExpiresAt;
  delete cleaned.resumeDeliveredTo;
  return cleaned;
}

async function reloadState(message: ContentRequest, sender: ContentSender): Promise<ReloadStateSuccess | StateFailure> {
  try {
    return await withReloadState(sender.tab.id, async (): Promise<ReloadStateSuccess> => {
      const record = await readReloadRecord(sender.tab.id);
      if (!record || record.videoId !== watchVideoId(message.url)) {
        return { ok: true, reloaded: false, reloadCount: 0, retryAfterMs: 0 };
      }
      const result: ReloadStateSuccess = {
        ok: true, reloaded: true, reloadCount: record.reloadCount, retryAfterMs: retryAfter(record)
      };
      if (record.resumeTime === undefined && record.resumeExpiresAt === undefined) return result;
      if (validResume(record) && (record.sourceDocumentId === sender.documentId ||
          record.resumeDeliveredTo === sender.documentId)) return result;
      try {
        if (validResume(record)) {
          // Deliver once per document, but retain the position through ad reloads.
          const delivered: ReloadRecord = { ...record, resumeDeliveredTo: sender.documentId };
          await chrome.storage.session.set({ [reloadStateKey(sender.tab.id)]: delivered });
          if (validResume(record)) result.resumeTime = record.resumeTime;
          else await chrome.storage.session.set({ [reloadStateKey(sender.tab.id)]: withoutResume(delivered) });
        } else {
          await chrome.storage.session.set({ [reloadStateKey(sender.tab.id)]: withoutResume(record) });
        }
      } catch {
        // Keep the reload guard and skip best-effort restoration on write failure.
      }
      return result;
    });
  } catch {
    return { ok: false, reason: "reload-state-unavailable" };
  }
}

async function resumeComplete(message: ContentRequest, sender: ContentSender): Promise<{
  ok: true;
  cleared: boolean;
} | StateFailure> {
  try {
    return await withReloadState(sender.tab.id, async () => {
      const record = await readReloadRecord(sender.tab.id);
      if (!record || record.videoId !== watchVideoId(message.url) || record.resumeDeliveredTo !== sender.documentId) {
        return { ok: true, cleared: false };
      }
      await chrome.storage.session.set({ [reloadStateKey(sender.tab.id)]: withoutResume(record) });
      return { ok: true, cleared: true };
    });
  } catch {
    return { ok: false, reason: "reload-state-unavailable" };
  }
}

function matchesReservation(record: ReloadRecord | undefined, reservation: ReloadReservation | undefined): boolean {
  return record !== undefined && reservation !== undefined && record.videoId === reservation.videoId &&
    record.sourceDocumentId === reservation.sourceDocumentId &&
    record.reloadCount === reservation.reloadCount && record.lastReloadAt === reservation.lastReloadAt;
}

async function rollbackReloadReservation(job: Job): Promise<void> {
  if (job.reloadDispatched || !job.reloadReservation) return;
  try {
    await withReloadState(job.tabId, async () => {
      const record = await readReloadRecord(job.tabId);
      if (!matchesReservation(record, job.reloadReservation)) {
        job.reloadCount = record && record.videoId === job.videoId ? record.reloadCount : 0;
        return;
      }
      if (job.previousReloadRecord) {
        // Never resurrect a position already acknowledged or replaced meanwhile.
        const restored = withoutResume(job.previousReloadRecord);
        await chrome.storage.session.set({ [reloadStateKey(job.tabId)]: restored });
        job.reloadCount = restored.videoId === job.videoId ? restored.reloadCount : 0;
      } else {
        await chrome.storage.session.remove(reloadStateKey(job.tabId));
        job.reloadCount = 0;
      }
    });
  } catch {
    // An unconfirmed rollback keeps the positively saved count as consumed.
  }
}

async function discardResume(job: Job): Promise<void> {
  if (!job.reloadReservation) return;
  try {
    await withReloadState(job.tabId, async () => {
      const record = await readReloadRecord(job.tabId);
      if (!record || !matchesReservation(record, job.reloadReservation) ||
          (record.resumeTime === undefined && record.resumeExpiresAt === undefined)) return;
      await chrome.storage.session.set({ [reloadStateKey(job.tabId)]: withoutResume(record) });
    });
  } catch {
    // Even if cleanup fails, reloadState never returns an expired position.
  }
}

async function reloadAd(job: Job, resumeTime: unknown): Promise<OperationReply> {
  const timer = setTimeout(() => stop(job, "timeout"), RELOAD_OPERATION_TIMEOUT_MS);
  try {
    const settings = await checkDocumentAndForeground(job, true);
    const reservation = await step(job, () => withReloadState(job.tabId, async (): Promise<OperationReply> => {
      let record: ReloadRecord | undefined;
      try {
        record = await readReloadRecord(job.tabId);
        ensureRunning(job);
        const previous = record ? { ...record } : undefined;
        if (record?.videoId !== job.videoId) record = undefined;
        const count = record?.reloadCount || 0;
        job.reloadCount = count;
        if (count >= maxReloads(settings.maxReloads)) {
          return { ok: false, reason: "reload-limit", reloadCount: count };
        }
        const retryAfterMs = retryAfter(record);
        if (retryAfterMs > 0) return { ok: false, reason: "retry-later", retryAfterMs, reloadCount: count };
        if (job.videoId === null) throw new StopOperation("reload-state-unavailable");
        const next: ReloadRecord = { videoId: job.videoId, sourceDocumentId: job.documentId,
          reloadCount: count + 1, lastReloadAt: Date.now() };
        const position = isFiniteNumber(resumeTime) && resumeTime > 0 ? resumeTime :
          validResume(record) ? record.resumeTime : undefined;
        if (position !== undefined) {
          next.resumeTime = position;
          next.resumeExpiresAt = Date.now() + RESUME_LIFETIME_MS;
        }
        // Persist before navigation so a new worker/document cannot reload again.
        // Until the write acknowledges success its resulting count is unknown.
        delete job.reloadCount;
        await chrome.storage.session.set({ [reloadStateKey(job.tabId)]: next });
        job.previousReloadRecord = previous;
        job.reloadReservation = {
          videoId: next.videoId, sourceDocumentId: next.sourceDocumentId,
          reloadCount: next.reloadCount, lastReloadAt: next.lastReloadAt,
        };
        job.reloadCount = next.reloadCount;
      } catch (error) {
        if (error instanceof StopOperation) throw error;
        throw new StopOperation("reload-state-unavailable");
      }
      return { ok: true };
    }));
    if (!reservation.ok) return reservation;
    // Saving the guard is asynchronous: verify the live ad, preference and focus again.
    const latestSettings = await checkDocumentAndForeground(job, true);
    if (job.reloadCount !== undefined && job.reloadCount > maxReloads(latestSettings.maxReloads)) {
      throw new StopOperation("reload-limit");
    }
    ensureRunning(job);
    job.reloading = true;
    job.reloadDispatched = true;
    await chrome.tabs.reload(job.tabId);
    return { ok: true, reloading: true, reloadCount: job.reloadCount };
  } catch (error) {
    await rollbackReloadReservation(job);
    await discardResume(job);
    return { ok: false, reason: error instanceof StopOperation ? error.reason : "failed",
      retryAfterMs: RELOAD_INTERVAL_MS,
      ...(isInteger(job.reloadCount) ? { reloadCount: job.reloadCount } : {}) };
  } finally {
    clearTimeout(timer);
    if (jobs.get(job.tabId) === job) jobs.delete(job.tabId);
  }
}

async function checkFrame(job: Job): Promise<void> {
  const result = await command(job, "Page.getFrameTree");
  const frameTree = isRecord(result) && isRecord(result.frameTree) ? result.frameTree : undefined;
  const frame = frameTree && isRecord(frameTree.frame) ? frameTree.frame : undefined;
  if (!frame || frame.url !== job.url || !isWatchUrl(frame.url) ||
      typeof frame.id !== "string" || !frame.id || typeof frame.loaderId !== "string" || !frame.loaderId ||
      (job.frameId && (job.frameId !== frame.id || job.loaderId !== frame.loaderId))) {
    throw new StopOperation("document-changed");
  }
  job.frameId = frame.id;
  job.loaderId = frame.loaderId;
}

async function currentTarget(job: Job): Promise<SkipTarget> {
  const result = await command(job, "Runtime.evaluate", {
    expression: TARGET_EXPRESSION, returnByValue: true
  });
  const evaluation = isRecord(result) && isRecord(result.result) ? result.result : undefined;
  const target = evaluation && isRecord(evaluation.value) ? evaluation.value : undefined;
  if (!isRecord(result) || result.exceptionDetails || !target || target.href !== job.url ||
      !isFiniteNumber(target.x) || !isFiniteNumber(target.y)) {
    throw new StopOperation("target-unavailable");
  }
  return { x: target.x, y: target.y, href: job.url };
}

async function skip(job: Job): Promise<OperationReply> {
  let response: OperationReply;
  const timer = setTimeout(() => stop(job, "timeout"), OPERATION_TIMEOUT_MS);
  try {
    await checkDocumentAndForeground(job);
    ensureRunning(job);
    try {
      await chrome.debugger.attach({ tabId: job.tabId }, "1.3");
      job.attached = true;
    } catch {
      blockedDocuments.set(job.tabId, job.documentId);
      await pauseAutomation();
      throw new StopOperation("debugger-unavailable");
    }
    ensureRunning(job);
    await command(job, "Page.enable");
    await checkFrame(job);
    let target = await currentTarget(job);
    await command(job, "Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
    // Hover may change layout. Recheck the live document, preference, focus,
    // frame/loader, ad state, visibility, and hit target immediately before down.
    await checkDocumentAndForeground(job);
    await checkFrame(job);
    target = await currentTarget(job);
    ensureRunning(job);
    job.pressed = true;
    await command(job, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: target.x, y: target.y, button: "left", buttons: 1, clickCount: 1
    });
    await command(job, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1
    });
    job.pressed = false;
    response = { ok: true };
  } catch (error) {
    response = { ok: false, reason: error instanceof StopOperation ? error.reason : "failed" };
  } finally {
    clearTimeout(timer);
    await cleanup(job);
    if (jobs.get(job.tabId) === job) jobs.delete(job.tabId);
  }
  return job.cleanupFailed ? { ok: false, reason: "cleanup-failed" } : response;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (isRecord(message) && message.type === "automation-diagnostics") {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html") ||
        !isInteger(message.tabId) || message.tabId < 0) return false;
    collectDiagnostics(message.tabId).then(respond, () => respond({ ok: false, reason: "unavailable" }));
    return true;
  }
  if (!permittedRequest(message) || !permittedSender(sender)) return false;
  if (message.type === "ad-reload-state") {
    if (lastActions.get(sender.tab.id)?.documentId !== sender.documentId) lastActions.delete(sender.tab.id);
    const pendingJob = jobs.get(sender.tab.id);
    if (pendingJob) {
      if (pendingJob.documentId !== sender.documentId) pendingJob.diagnosticStale = true;
      // A reservation may still be rolled back. Do not let another document
      // cache that provisional count as an exhausted, final budget.
      respond({ ok: false, reason: "busy" });
      return false;
    }
    reloadState(message, sender).then(respond, () => respond({ ok: false, reason: "reload-state-unavailable" }));
    return true;
  }
  if (message.type === "ad-resume-complete") {
    resumeComplete(message, sender).then(respond, () => respond({ ok: false, reason: "reload-state-unavailable" }));
    return true;
  }
  const tabId = sender.tab.id;
  const now = Date.now();
  if (automationPaused || blockedDocuments.get(tabId) === sender.documentId) {
    respond({ ok: false, reason: "disabled" });
    return false;
  }
  if (jobs.has(tabId) || (message.type === "skip-ad" &&
      now - (lastAttempts.get(tabId) ?? -Infinity) < ATTEMPT_COOLDOWN_MS)) {
    respond({ ok: false, reason: "busy" });
    return false;
  }
  const operationTimeout = message.type === "reload-ad" ? RELOAD_OPERATION_TIMEOUT_MS : OPERATION_TIMEOUT_MS;
  const job: Job = { tabId, kind: message.type, videoId: watchVideoId(message.url),
    windowId: sender.tab.windowId, documentId: sender.documentId,
    url: message.url, startedAt: now, deadline: now + operationTimeout, attached: false, pressed: false };
  lastAttempts.set(tabId, now);
  jobs.set(tabId, job);
  const operation = message.type === "reload-ad" ? reloadAd(job, message.resumeTime) : skip(job);
  operation.then(reply => { recordAction(job, reply); respond(reply); }, () => {
    const reply: OperationReply = { ok: false, reason: "failed" };
    recordAction(job, reply);
    respond(reply);
  });
  return true;
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const job = source.tabId !== undefined ? jobs.get(source.tabId) : undefined;
  if (!job) return;
  job.attached = false;
  if (job.ownDetach) return;
  stop(job, "cancelled");
  if (reason === "canceled_by_user") {
    blockedDocuments.set(job.tabId, job.documentId);
    void pauseAutomation();
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const job = source.tabId !== undefined ? jobs.get(source.tabId) : undefined;
  if (!job || source.sessionId) return;
  const frame = params && isRecord(params.frame) ? params.frame : undefined;
  if ((method === "Page.frameNavigated" && !frame?.parentId) ||
      (method === "Page.frameStartedLoading" && params?.frameId === job.frameId) ||
      (method === "Page.frameDetached" && params?.frameId === job.frameId) ||
      (method === "Page.navigatedWithinDocument" && params?.frameId === job.frameId && params?.url !== job.url)) {
    stop(job, "document-changed");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  const enabled = changes.enabled;
  if (area !== "local" || !enabled) return;
  const newValue: unknown = enabled.newValue;
  if (newValue === false) {
    automationPaused = true;
    for (const job of jobs.values()) stop(job, "disabled");
  } else {
    automationPaused = false;
    blockedDocuments.clear();
    lastAttempts.clear();
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) lastActions.delete(tabId);
  const job = jobs.get(tabId);
  if (job && (change.url || change.status === "loading")) job.diagnosticStale = true;
  const ownReload = job?.kind === "reload-ad" && job.reloading &&
    (!change.url || change.url === job.url);
  if (job && ((!ownReload && change.status === "loading") || (change.url && change.url !== job.url))) {
    stop(job, "document-changed");
  }
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const job of jobs.values()) {
    if (job.windowId === windowId && job.tabId !== tabId) stop(job, "inactive");
  }
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  for (const job of jobs.values()) {
    if (job.windowId !== windowId) stop(job, "inactive");
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  lastActions.delete(tabId);
  const job = jobs.get(tabId);
  if (job) job.diagnosticStale = true;
  if (job) stop(job, "document-changed");
  blockedDocuments.delete(tabId);
  lastAttempts.delete(tabId);
  void withReloadState(tabId, () => chrome.storage.session.remove(reloadStateKey(tabId))).catch(() => {});
});

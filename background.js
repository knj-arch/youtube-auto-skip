"use strict";

const OPERATION_TIMEOUT_MS = 2000;
const ATTEMPT_COOLDOWN_MS = 1500;
const jobs = new Map();
const blockedDocuments = new Map();
const lastAttempts = new Map();
let automationPaused = false;

// This fixed expression returns only the current skip-button coordinates.
// Callers cannot supply JavaScript, CDP commands, selectors, or coordinates.
function findSkipTarget() {
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
      for (let ancestor = button; ancestor; ancestor = ancestor.parentElement) {
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
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function isYoutubeUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.href === value && url.origin === "https://www.youtube.com" &&
      !url.username && !url.password;
  } catch { return false; }
}

function isWatchUrl(value) {
  return isYoutubeUrl(value) && new URL(value).pathname === "/watch";
}

function permittedRequest(message, sender) {
  return message?.type === "skip-ad" && isWatchUrl(message.url) &&
    sender.id === chrome.runtime.id && sender.frameId === 0 &&
    typeof sender.documentId === "string" && sender.documentId.length > 0 &&
    sender.documentId.length <= 128 &&
    (!sender.documentLifecycle || sender.documentLifecycle === "active") &&
    Number.isInteger(sender.tab?.id) && sender.tab.id >= 0 &&
    Number.isInteger(sender.tab.windowId) && sender.tab.windowId >= 0 &&
    isYoutubeUrl(sender.url);
}

function ensureRunning(job) {
  if (job.reason) throw new StopOperation(job.reason);
  if (automationPaused) throw new StopOperation("disabled");
  if (Date.now() >= job.deadline) throw new StopOperation("timeout");
}

async function step(job, action) {
  ensureRunning(job);
  const result = await action();
  ensureRunning(job);
  return result;
}

function command(job, method, params = {}) {
  return step(job, () => chrome.debugger.sendCommand({ tabId: job.tabId }, method, params));
}

async function pauseAutomation() {
  automationPaused = true;
  for (const job of jobs.values()) stop(job, "disabled");
  // Store only the user's on/off preference; no URLs or viewing records.
  await chrome.storage.local.set({ enabled: false }).catch(() => {});
}

function stop(job, reason) {
  job.reason ||= reason;
  void cleanup(job);
}

async function cleanup(job) {
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

async function checkDocumentAndForeground(job) {
  const [settings, tab, windowInfo, confirmation] = await step(job, () => Promise.all([
    chrome.storage.local.get({ enabled: true }),
    chrome.tabs.get(job.tabId),
    chrome.windows.get(job.windowId),
    chrome.tabs.sendMessage(job.tabId, { type: "confirm-skip-document", url: job.url },
      { documentId: job.documentId, frameId: 0 })
  ]));
  if (settings.enabled === false) throw new StopOperation("disabled");
  if (!tab.active || tab.windowId !== job.windowId || !windowInfo.focused ||
      tab.discarded || tab.frozen || tab.status === "loading") throw new StopOperation("inactive");
  // tabs.get may omit URL without the broad tabs permission. CDP below always
  // checks the actual URL; if Chrome exposes tab URLs, also check them here.
  if ((tab.url !== undefined && tab.url !== job.url) ||
      (tab.pendingUrl !== undefined && tab.pendingUrl !== job.url) ||
      !confirmation?.ok || confirmation.url !== job.url) throw new StopOperation("document-changed");
}

async function checkFrame(job) {
  const result = await command(job, "Page.getFrameTree");
  const frame = result.frameTree?.frame;
  if (!frame || frame.url !== job.url || !isWatchUrl(frame.url) ||
      !frame.id || !frame.loaderId ||
      (job.frameId && (job.frameId !== frame.id || job.loaderId !== frame.loaderId))) {
    throw new StopOperation("document-changed");
  }
  job.frameId = frame.id;
  job.loaderId = frame.loaderId;
}

async function currentTarget(job) {
  const result = await command(job, "Runtime.evaluate", {
    expression: TARGET_EXPRESSION, returnByValue: true
  });
  const target = result.result?.value;
  if (result.exceptionDetails || !target || target.href !== job.url ||
      !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new StopOperation("target-unavailable");
  }
  return target;
}

async function skip(job) {
  let response;
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

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!permittedRequest(message, sender)) return false;
  const tabId = sender.tab.id;
  const now = Date.now();
  if (automationPaused || blockedDocuments.get(tabId) === sender.documentId) {
    respond({ ok: false, reason: "disabled" });
    return false;
  }
  if (jobs.has(tabId) || now - (lastAttempts.get(tabId) ?? -Infinity) < ATTEMPT_COOLDOWN_MS) {
    respond({ ok: false, reason: "busy" });
    return false;
  }
  const job = { tabId, windowId: sender.tab.windowId, documentId: sender.documentId,
    url: message.url, deadline: now + OPERATION_TIMEOUT_MS, attached: false, pressed: false };
  lastAttempts.set(tabId, now);
  jobs.set(tabId, job);
  skip(job).then(respond, () => respond({ ok: false, reason: "failed" }));
  return true;
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const job = jobs.get(source.tabId);
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
  const job = jobs.get(source.tabId);
  if (!job || source.sessionId) return;
  if ((method === "Page.frameNavigated" && !params.frame?.parentId) ||
      (method === "Page.frameStartedLoading" && params.frameId === job.frameId) ||
      (method === "Page.frameDetached" && params.frameId === job.frameId) ||
      (method === "Page.navigatedWithinDocument" && params.frameId === job.frameId && params.url !== job.url)) {
    stop(job, "document-changed");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  if (changes.enabled.newValue === false) {
    automationPaused = true;
    for (const job of jobs.values()) stop(job, "disabled");
  } else {
    automationPaused = false;
    blockedDocuments.clear();
    lastAttempts.clear();
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  const job = jobs.get(tabId);
  if (job && (change.status === "loading" || (change.url && change.url !== job.url))) {
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
  const job = jobs.get(tabId);
  if (job) stop(job, "document-changed");
  blockedDocuments.delete(tabId);
  lastAttempts.delete(tabId);
});

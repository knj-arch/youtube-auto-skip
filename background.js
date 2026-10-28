// Generated from src/*.ts by npm run build. Edit the TypeScript source.
"use strict";
(() => {
  // src/background.ts
  var OPERATION_TIMEOUT_MS = 2e3;
  var RELOAD_OPERATION_TIMEOUT_MS = 1e4;
  var ATTEMPT_COOLDOWN_MS = 1500;
  var RELOAD_INTERVAL_MS = 3e3;
  var RESUME_LIFETIME_MS = 6e4;
  var jobs = /* @__PURE__ */ new Map();
  var blockedDocuments = /* @__PURE__ */ new Map();
  var lastAttempts = /* @__PURE__ */ new Map();
  var reloadStateQueues = /* @__PURE__ */ new Map();
  var lastActions = /* @__PURE__ */ new Map();
  var automationPaused = false;
  function findSkipTarget() {
    if (self !== top || location.origin !== "https://www.youtube.com" || location.pathname !== "/watch" || document.visibilityState !== "visible") return null;
    const selector = [
      "button.ytp-skip-ad-button",
      "button.ytp-ad-skip-button-modern",
      "button.ytp-ad-skip-button",
      '[role="button"].ytp-skip-ad-button',
      '[role="button"].ytp-ad-skip-button-modern',
      '[role="button"].ytp-ad-skip-button'
    ].join(",");
    for (const player of document.querySelectorAll(".html5-video-player.ad-showing, .html5-video-player.ad-interrupting")) {
      for (const button of player.querySelectorAll(selector)) {
        if (!button.isConnected || button.closest(".html5-video-player") !== player || button.matches(":disabled") || button.closest('[hidden], [inert], [aria-disabled="true"], [aria-hidden="true"]')) continue;
        const style = getComputedStyle(button);
        if (!button.getClientRects().length || style.visibility !== "visible" || style.pointerEvents === "none") continue;
        let hidden = false;
        for (let ancestor = button; ancestor; ancestor = ancestor.parentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (ancestorStyle.display === "none" || ancestorStyle.contentVisibility === "hidden" || Number(ancestorStyle.opacity) === 0) hidden = true;
        }
        if (hidden) continue;
        const bounds = button.getBoundingClientRect();
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (bounds.width <= 0 || bounds.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !hit || hit !== button && !button.contains(hit)) continue;
        return { x, y, href: location.href };
      }
    }
    return null;
  }
  var TARGET_EXPRESSION = "(" + findSkipTarget.toString() + ")()";
  var StopOperation = class extends Error {
    constructor(reason) {
      super(reason);
      this.reason = reason;
    }
    reason;
  };
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }
  function isInteger(value) {
    return typeof value === "number" && Number.isInteger(value);
  }
  function isYoutubeUrl(value) {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.href === value && url.origin === "https://www.youtube.com" && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  function isWatchUrl(value) {
    return isYoutubeUrl(value) && new URL(value).pathname === "/watch";
  }
  function watchVideoId(value) {
    if (!isWatchUrl(value)) return null;
    const ids = new URL(value).searchParams.getAll("v");
    const id = ids[0];
    return ids.length === 1 && typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  }
  function permittedRequest(message) {
    return isRecord(message) && (message.type === "skip-ad" || message.type === "reload-ad" || message.type === "ad-reload-state" || message.type === "ad-resume-complete") && isWatchUrl(message.url) && (message.type === "skip-ad" || watchVideoId(message.url) !== null);
  }
  function permittedSender(sender) {
    return sender.id === chrome.runtime.id && sender.frameId === 0 && typeof sender.documentId === "string" && sender.documentId.length > 0 && sender.documentId.length <= 128 && (!sender.documentLifecycle || sender.documentLifecycle === "active") && isInteger(sender.tab?.id) && sender.tab.id >= 0 && isInteger(sender.tab.windowId) && sender.tab.windowId >= 0 && isYoutubeUrl(sender.url);
  }
  async function readSettings() {
    const settings = await chrome.storage.local.get({ enabled: true, maxReloads: 3 });
    if (!isRecord(settings)) throw new StopOperation("reload-state-unavailable");
    return { enabled: settings.enabled, maxReloads: settings.maxReloads };
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
    await chrome.storage.local.set({ enabled: false }).catch(() => {
    });
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
        await chrome.debugger.sendCommand({ tabId: job.tabId }, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: -1,
          y: -1,
          button: "left",
          buttons: 0,
          clickCount: 1
        }).catch(() => {
        });
        job.pressed = false;
      }
      job.ownDetach = true;
      try {
        await chrome.debugger.detach({ tabId: job.tabId });
      } catch {
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
  async function checkDocumentAndForeground(job, requireAd = false) {
    const [settings, tab, windowInfo, confirmation] = await step(job, () => Promise.all([
      readSettings(),
      chrome.tabs.get(job.tabId),
      chrome.windows.get(job.windowId),
      chrome.tabs.sendMessage(
        job.tabId,
        {
          type: "confirm-skip-document",
          url: job.url,
          ...requireAd ? { requireAd: true } : {}
        },
        { documentId: job.documentId, frameId: 0 }
      )
    ]));
    if (settings.enabled === false) throw new StopOperation("disabled");
    if (!tab.active || tab.windowId !== job.windowId || !windowInfo.focused || tab.discarded || tab.frozen) throw new StopOperation("inactive");
    if (tab.url !== void 0 && tab.url !== job.url || tab.pendingUrl !== void 0 && tab.pendingUrl !== job.url || !isRecord(confirmation) || !confirmation.ok || confirmation.url !== job.url) {
      throw new StopOperation("document-changed");
    }
    if (requireAd && confirmation.adShowing !== true) throw new StopOperation("ad-not-showing");
    return settings;
  }
  function maxReloads(value) {
    return isFiniteNumber(value) ? Math.min(10, Math.max(1, Math.trunc(value))) : 3;
  }
  function recordAction(job, reply) {
    if (job.diagnosticStale) return;
    lastActions.set(job.tabId, {
      operation: job.kind,
      ok: reply.ok === true,
      reason: reply.ok === true ? "ok" : reply.reason || "failed",
      ...isInteger(reply.reloadCount) ? { reloadCount: reply.reloadCount } : {},
      elapsedMs: Math.max(0, Date.now() - job.startedAt),
      at: Date.now(),
      documentId: job.documentId
    });
  }
  async function contentDiagnostics(tabId) {
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(
          tabId,
          { type: "automation-content-status" },
          { frameId: 0 }
        ).then(
          (reply) => isRecord(reply) && reply.connected === true ? { ...reply, connected: true } : { connected: false, reason: "no-content-script" },
          () => ({ connected: false, reason: "no-content-script" })
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ connected: false, reason: "timeout" }), 1500);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function collectDiagnostics(tabId) {
    const [tab, settings] = await Promise.all([chrome.tabs.get(tabId), readSettings()]);
    const supported = typeof tab.url === "string" ? watchVideoId(tab.url) !== null : null;
    const [windowInfo, content] = await Promise.all([
      chrome.windows.get(tab.windowId),
      supported === false ? Promise.resolve({ connected: false, reason: "unsupported-page" }) : contentDiagnostics(tabId)
    ]);
    const result = {
      ok: true,
      version: chrome.runtime.getManifest().version,
      enabled: settings.enabled !== false,
      maxReloads: maxReloads(settings.maxReloads),
      page: {
        supported,
        active: tab.active === true,
        windowFocused: windowInfo.focused === true,
        loading: tab.status === "loading",
        discarded: tab.discarded === true,
        frozen: tab.frozen === true
      },
      content
    };
    const last = lastActions.get(tabId);
    if (last) {
      const { documentId, at, ...publicResult } = last;
      result.lastAction = { ...publicResult, ageMs: Math.max(0, Date.now() - at) };
    }
    return result;
  }
  function reloadStateKey(tabId) {
    return "ad-reload:" + tabId;
  }
  function withReloadState(tabId, action) {
    const previous = reloadStateQueues.get(tabId) || Promise.resolve();
    const operation = previous.catch(() => {
    }).then(action);
    reloadStateQueues.set(tabId, operation);
    const finish = () => {
      if (reloadStateQueues.get(tabId) === operation) reloadStateQueues.delete(tabId);
    };
    operation.then(finish, finish);
    return operation;
  }
  function isReloadRecord(record) {
    return isRecord(record) && typeof record.videoId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(record.videoId) && isInteger(record.reloadCount) && record.reloadCount >= 1 && isFiniteNumber(record.lastReloadAt) && record.lastReloadAt >= 0 && typeof record.sourceDocumentId === "string" && record.sourceDocumentId.length > 0 && record.sourceDocumentId.length <= 128;
  }
  async function readReloadRecord(tabId) {
    const key = reloadStateKey(tabId);
    const result = await chrome.storage.session.get(key);
    if (!isRecord(result)) throw new StopOperation("reload-state-unavailable");
    const record = result[key];
    if (record === void 0) return void 0;
    if (!isReloadRecord(record)) throw new StopOperation("reload-state-unavailable");
    return record;
  }
  function retryAfter(record) {
    return record ? Math.max(0, RELOAD_INTERVAL_MS - (Date.now() - record.lastReloadAt)) : 0;
  }
  function validResume(record) {
    return record !== void 0 && isFiniteNumber(record.resumeTime) && record.resumeTime > 0 && isFiniteNumber(record.resumeExpiresAt) && Date.now() < record.resumeExpiresAt;
  }
  function withoutResume(record) {
    const cleaned = { ...record };
    delete cleaned.resumeTime;
    delete cleaned.resumeExpiresAt;
    delete cleaned.resumeDeliveredTo;
    return cleaned;
  }
  async function reloadState(message, sender) {
    try {
      return await withReloadState(sender.tab.id, async () => {
        const record = await readReloadRecord(sender.tab.id);
        if (!record || record.videoId !== watchVideoId(message.url)) {
          return { ok: true, reloaded: false, reloadCount: 0, retryAfterMs: 0 };
        }
        const result = {
          ok: true,
          reloaded: true,
          reloadCount: record.reloadCount,
          retryAfterMs: retryAfter(record)
        };
        if (record.resumeTime === void 0 && record.resumeExpiresAt === void 0) return result;
        if (validResume(record) && (record.sourceDocumentId === sender.documentId || record.resumeDeliveredTo === sender.documentId)) return result;
        try {
          if (validResume(record)) {
            const delivered = { ...record, resumeDeliveredTo: sender.documentId };
            await chrome.storage.session.set({ [reloadStateKey(sender.tab.id)]: delivered });
            if (validResume(record)) result.resumeTime = record.resumeTime;
            else await chrome.storage.session.set({ [reloadStateKey(sender.tab.id)]: withoutResume(delivered) });
          } else {
            await chrome.storage.session.set({ [reloadStateKey(sender.tab.id)]: withoutResume(record) });
          }
        } catch {
        }
        return result;
      });
    } catch {
      return { ok: false, reason: "reload-state-unavailable" };
    }
  }
  async function resumeComplete(message, sender) {
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
  function matchesReservation(record, reservation) {
    return record !== void 0 && reservation !== void 0 && record.videoId === reservation.videoId && record.sourceDocumentId === reservation.sourceDocumentId && record.reloadCount === reservation.reloadCount && record.lastReloadAt === reservation.lastReloadAt;
  }
  async function rollbackReloadReservation(job) {
    if (job.reloadDispatched || !job.reloadReservation) return;
    try {
      await withReloadState(job.tabId, async () => {
        const record = await readReloadRecord(job.tabId);
        if (!matchesReservation(record, job.reloadReservation)) {
          job.reloadCount = record && record.videoId === job.videoId ? record.reloadCount : 0;
          return;
        }
        if (job.previousReloadRecord) {
          const restored = withoutResume(job.previousReloadRecord);
          await chrome.storage.session.set({ [reloadStateKey(job.tabId)]: restored });
          job.reloadCount = restored.videoId === job.videoId ? restored.reloadCount : 0;
        } else {
          await chrome.storage.session.remove(reloadStateKey(job.tabId));
          job.reloadCount = 0;
        }
      });
    } catch {
    }
  }
  async function discardResume(job) {
    if (!job.reloadReservation) return;
    try {
      await withReloadState(job.tabId, async () => {
        const record = await readReloadRecord(job.tabId);
        if (!record || !matchesReservation(record, job.reloadReservation) || record.resumeTime === void 0 && record.resumeExpiresAt === void 0) return;
        await chrome.storage.session.set({ [reloadStateKey(job.tabId)]: withoutResume(record) });
      });
    } catch {
    }
  }
  async function reloadAd(job, resumeTime) {
    const timer = setTimeout(() => stop(job, "timeout"), RELOAD_OPERATION_TIMEOUT_MS);
    try {
      const settings = await checkDocumentAndForeground(job, true);
      const reservation = await step(job, () => withReloadState(job.tabId, async () => {
        let record;
        try {
          record = await readReloadRecord(job.tabId);
          ensureRunning(job);
          const previous = record ? { ...record } : void 0;
          if (record?.videoId !== job.videoId) record = void 0;
          const count = record?.reloadCount || 0;
          job.reloadCount = count;
          if (count >= maxReloads(settings.maxReloads)) {
            return { ok: false, reason: "reload-limit", reloadCount: count };
          }
          const retryAfterMs = retryAfter(record);
          if (retryAfterMs > 0) return { ok: false, reason: "retry-later", retryAfterMs, reloadCount: count };
          if (job.videoId === null) throw new StopOperation("reload-state-unavailable");
          const next = {
            videoId: job.videoId,
            sourceDocumentId: job.documentId,
            reloadCount: count + 1,
            lastReloadAt: Date.now()
          };
          const position = isFiniteNumber(resumeTime) && resumeTime > 0 ? resumeTime : validResume(record) ? record.resumeTime : void 0;
          if (position !== void 0) {
            next.resumeTime = position;
            next.resumeExpiresAt = Date.now() + RESUME_LIFETIME_MS;
          }
          delete job.reloadCount;
          await chrome.storage.session.set({ [reloadStateKey(job.tabId)]: next });
          job.previousReloadRecord = previous;
          job.reloadReservation = {
            videoId: next.videoId,
            sourceDocumentId: next.sourceDocumentId,
            reloadCount: next.reloadCount,
            lastReloadAt: next.lastReloadAt
          };
          job.reloadCount = next.reloadCount;
        } catch (error) {
          if (error instanceof StopOperation) throw error;
          throw new StopOperation("reload-state-unavailable");
        }
        return { ok: true };
      }));
      if (!reservation.ok) return reservation;
      const latestSettings = await checkDocumentAndForeground(job, true);
      if (job.reloadCount !== void 0 && job.reloadCount > maxReloads(latestSettings.maxReloads)) {
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
      return {
        ok: false,
        reason: error instanceof StopOperation ? error.reason : "failed",
        retryAfterMs: RELOAD_INTERVAL_MS,
        ...isInteger(job.reloadCount) ? { reloadCount: job.reloadCount } : {}
      };
    } finally {
      clearTimeout(timer);
      if (jobs.get(job.tabId) === job) jobs.delete(job.tabId);
    }
  }
  async function checkFrame(job) {
    const result = await command(job, "Page.getFrameTree");
    const frameTree = isRecord(result) && isRecord(result.frameTree) ? result.frameTree : void 0;
    const frame = frameTree && isRecord(frameTree.frame) ? frameTree.frame : void 0;
    if (!frame || frame.url !== job.url || !isWatchUrl(frame.url) || typeof frame.id !== "string" || !frame.id || typeof frame.loaderId !== "string" || !frame.loaderId || job.frameId && (job.frameId !== frame.id || job.loaderId !== frame.loaderId)) {
      throw new StopOperation("document-changed");
    }
    job.frameId = frame.id;
    job.loaderId = frame.loaderId;
  }
  async function currentTarget(job) {
    const result = await command(job, "Runtime.evaluate", {
      expression: TARGET_EXPRESSION,
      returnByValue: true
    });
    const evaluation = isRecord(result) && isRecord(result.result) ? result.result : void 0;
    const target = evaluation && isRecord(evaluation.value) ? evaluation.value : void 0;
    if (!isRecord(result) || result.exceptionDetails || !target || target.href !== job.url || !isFiniteNumber(target.x) || !isFiniteNumber(target.y)) {
      throw new StopOperation("target-unavailable");
    }
    return { x: target.x, y: target.y, href: job.url };
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
      await checkDocumentAndForeground(job);
      await checkFrame(job);
      target = await currentTarget(job);
      ensureRunning(job);
      job.pressed = true;
      await command(job, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: target.x,
        y: target.y,
        button: "left",
        buttons: 1,
        clickCount: 1
      });
      await command(job, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: target.x,
        y: target.y,
        button: "left",
        buttons: 0,
        clickCount: 1
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
    if (isRecord(message) && message.type === "automation-diagnostics") {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html") || !isInteger(message.tabId) || message.tabId < 0) return false;
      collectDiagnostics(message.tabId).then(respond, () => respond({ ok: false, reason: "unavailable" }));
      return true;
    }
    if (!permittedRequest(message) || !permittedSender(sender)) return false;
    if (message.type === "ad-reload-state") {
      if (lastActions.get(sender.tab.id)?.documentId !== sender.documentId) lastActions.delete(sender.tab.id);
      const pendingJob = jobs.get(sender.tab.id);
      if (pendingJob) {
        if (pendingJob.documentId !== sender.documentId) pendingJob.diagnosticStale = true;
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
    if (jobs.has(tabId) || message.type === "skip-ad" && now - (lastAttempts.get(tabId) ?? -Infinity) < ATTEMPT_COOLDOWN_MS) {
      respond({ ok: false, reason: "busy" });
      return false;
    }
    const operationTimeout = message.type === "reload-ad" ? RELOAD_OPERATION_TIMEOUT_MS : OPERATION_TIMEOUT_MS;
    const job = {
      tabId,
      kind: message.type,
      videoId: watchVideoId(message.url),
      windowId: sender.tab.windowId,
      documentId: sender.documentId,
      url: message.url,
      startedAt: now,
      deadline: now + operationTimeout,
      attached: false,
      pressed: false
    };
    lastAttempts.set(tabId, now);
    jobs.set(tabId, job);
    const operation = message.type === "reload-ad" ? reloadAd(job, message.resumeTime) : skip(job);
    operation.then((reply) => {
      recordAction(job, reply);
      respond(reply);
    }, () => {
      const reply = { ok: false, reason: "failed" };
      recordAction(job, reply);
      respond(reply);
    });
    return true;
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    const job = source.tabId !== void 0 ? jobs.get(source.tabId) : void 0;
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
    const job = source.tabId !== void 0 ? jobs.get(source.tabId) : void 0;
    if (!job || source.sessionId) return;
    const frame = params && isRecord(params.frame) ? params.frame : void 0;
    if (method === "Page.frameNavigated" && !frame?.parentId || method === "Page.frameStartedLoading" && params?.frameId === job.frameId || method === "Page.frameDetached" && params?.frameId === job.frameId || method === "Page.navigatedWithinDocument" && params?.frameId === job.frameId && params?.url !== job.url) {
      stop(job, "document-changed");
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const enabled = changes.enabled;
    if (area !== "local" || !enabled) return;
    const newValue = enabled.newValue;
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
    const ownReload = job?.kind === "reload-ad" && job.reloading && (!change.url || change.url === job.url);
    if (job && (!ownReload && change.status === "loading" || change.url && change.url !== job.url)) {
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
    void withReloadState(tabId, () => chrome.storage.session.remove(reloadStateKey(tabId))).catch(() => {
    });
  });
})();

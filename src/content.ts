(() => {
  "use strict";

  type Operation = "ad-reload-state" | "reload-ad" | "skip-ad";
  interface ActionResult { operation: Operation; ok: boolean; reason: string; at: number }
  interface VideoState {
    id: string;
    ready: boolean;
    reloadCount: number;
    refreshUnavailable: boolean;
    reloading: boolean;
    stateReadInFlight: boolean;
    nextStateReadAt: number;
    lastMainTime: number;
    nextReloadAttempt: number;
    resumeTime?: number;
    resumeDeadline?: number;
    mainReadySince?: number;
    lastResult?: ActionResult;
    lastForeground?: { at: number; adPlayers: number };
  }
  interface ContentDiagnostics {
    connected: true; build: string; supported: boolean; enabled: boolean;
    visibility: DocumentVisibilityState; focused: boolean;
    players: number; adPlayers: number; skipButtons: number; eligibleSkipButtons: number;
    state: Pick<VideoState, "ready" | "reloadCount" | "refreshUnavailable" | "reloading"> &
      { nextReloadMs: number } | null;
    lastResult?: Omit<ActionResult, "at"> & { ageMs: number };
    lastForeground?: { focused: true; adPlayers: number; ageMs: number };
  }
  function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  }
  function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }
  function isPositiveNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }

  const PLAYER_SELECTOR = ".html5-video-player";
  const SKIP_SELECTOR = [
    "button.ytp-skip-ad-button",
    "button.ytp-ad-skip-button-modern",
    "button.ytp-ad-skip-button",
    '[role="button"].ytp-skip-ad-button',
    '[role="button"].ytp-ad-skip-button-modern',
    '[role="button"].ytp-ad-skip-button'
  ].join(",");
  const CLICK_COOLDOWN_MS = 1500;
  const RELOAD_INTERVAL_MS = 3000;
  const STATE_READ_RETRY_MS = 3000;
  const MAIN_VIDEO_SETTLE_MS = 500;
  const RESUME_TIMEOUT_MS = 15000;
  const VISUAL_EVENTS = ["transitionstart", "transitionend", "animationstart", "animationend"];
  const SCRIPT_VERSION = chrome.runtime.getManifest().version;
  const RESULT_REASONS = new Set(["ok", "timeout", "failed", "busy", "inactive", "disabled",
    "document-changed", "ad-not-showing", "reload-state-unavailable", "retry-later", "reload-limit",
    "debugger-unavailable", "target-unavailable", "cleanup-failed", "cancelled", "no-response", "message-failed"]);
  const players = new Map<Element, MutationObserver>();
  const videos = new Map<HTMLVideoElement, (event: Event) => void>();
  const lastClicks = new WeakMap<Element, number>();
  let enabled = false;
  let intervalId: number | undefined;
  let scanQueued = false;
  let reconcileQueued = false;
  let animationFrame: number | undefined;
  let discoveryObserver: MutationObserver | undefined;
  let lifecycle = 0;
  let storageRevision = 0;
  let reloadLimitRevision = 0;
  let maxReloads = 3;
  let requestInFlight: { state: VideoState } | undefined;
  let videoState: VideoState | undefined;
  // YouTube reuses its video element during SPA navigation. An old element's
  // currentTime must not become the new video's resume point before metadata.
  let mediaVideoId = watchVideoId();

  function normalizeReloadLimit(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ?
      Math.min(10, Math.max(1, Math.floor(value))) : 3;
  }

  chrome.runtime.onMessage.addListener((value: unknown, sender, respond) => {
    const message = record(value);
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "automation-content-status") {
      respond(diagnosticSnapshot());
      return;
    }
    if (message?.type !== "confirm-skip-document") return;
    const adShowing = Boolean(document.querySelector(
      ".html5-video-player.ad-showing, .html5-video-player.ad-interrupting"
    ));
    respond({
      ok: enabled && location.href === message.url && document.visibilityState === "visible" &&
        document.hasFocus() && (!message.requireAd || adShowing),
      url: location.href,
      adShowing
    });
  });

  function watchVideoId() {
    try {
      const url = new URL(location.href);
      const id = url.searchParams.get("v");
      return url.origin === "https://www.youtube.com" && url.pathname === "/watch" &&
        id && id.length <= 128 ? id : undefined;
    } catch { return undefined; }
  }

  function isCurrent(state: VideoState) {
    return enabled && videoState === state && watchVideoId() === state.id;
  }

  function recordResult(state: VideoState, operation: Operation, value: unknown, fallback = "no-response") {
    if (!isCurrent(state)) return;
    const reply = record(value);
    const reason = reply.ok === true ? "ok" : typeof reply.reason === "string" && RESULT_REASONS.has(reply.reason)
      ? reply.reason : fallback;
    state.lastResult = { operation, ok: reply?.ok === true, reason, at: Date.now() };
  }

  function diagnosticSnapshot() {
    const current = videoState?.id === watchVideoId() ? videoState : undefined;
    const currentPlayers = Array.from(document.querySelectorAll(PLAYER_SELECTOR));
    const candidates = currentPlayers.flatMap(player => Array.from(player.querySelectorAll(SKIP_SELECTOR)));
    const result: ContentDiagnostics = { connected: true, build: SCRIPT_VERSION, supported: Boolean(watchVideoId()), enabled,
      visibility: document.visibilityState, focused: document.hasFocus(), players: currentPlayers.length,
      adPlayers: currentPlayers.filter(player => player.matches(".ad-showing, .ad-interrupting")).length,
      skipButtons: candidates.length,
      eligibleSkipButtons: candidates.filter(button => canClick(button, button.closest(PLAYER_SELECTOR))).length,
      state: current ? { ready: current.ready, reloadCount: current.reloadCount,
        refreshUnavailable: current.refreshUnavailable, reloading: current.reloading,
        nextReloadMs: Math.max(0, current.nextReloadAttempt - Date.now()) } : null };
    if (current?.lastResult) {
      const { operation, ok, reason, at } = current.lastResult;
      result.lastResult = { operation, ok, reason, ageMs: Math.max(0, Date.now() - at) };
    }
    if (current?.lastForeground) result.lastForeground = { focused: true,
      adPlayers: current.lastForeground.adPlayers, ageMs: Math.max(0, Date.now() - current.lastForeground.at) };
    return result;
  }

  function recoverReloadState(state: VideoState) {
    // A failed response does not tell us whether the worker reserved an attempt
    // or already dispatched a reload. Re-read the persisted guard before retrying.
    state.ready = false;
    state.refreshUnavailable = true;
    state.reloading = false;
    state.nextStateReadAt = Date.now() + STATE_READ_RETRY_MS;
    state.nextReloadAttempt = Math.max(state.nextReloadAttempt, state.nextStateReadAt);
  }

  function readReloadState(state: VideoState | undefined) {
    if (!state || !isCurrent(state) || state.ready || state.stateReadInFlight ||
        document.visibilityState !== "visible" || !document.hasFocus() ||
        Date.now() < state.nextStateReadAt) return;
    state.stateReadInFlight = true;
    state.nextStateReadAt = Date.now() + STATE_READ_RETRY_MS;
    let request: Promise<unknown>;
    try {
      request = chrome.runtime.sendMessage({ type: "ad-reload-state", url: location.href });
    } catch {
      state.stateReadInFlight = false;
      state.ready = false;
      state.refreshUnavailable = true;
      recordResult(state, "ad-reload-state", undefined, "message-failed");
      scheduleScan();
      return;
    }
    Promise.resolve(request).then(value => {
      const reply = record(value);
      if (!isCurrent(state)) return;
      // Refresh only with a known, persisted attempt count.
      state.refreshUnavailable = reply.ok !== true || !isCount(reply.reloadCount);
      state.ready = !state.refreshUnavailable;
      recordResult(state, "ad-reload-state", reply);
      if (!state.ready || !isCount(reply.reloadCount)) return;
      state.reloadCount = reply.reloadCount;
      if (isPositiveNumber(reply.retryAfterMs)) {
        state.nextReloadAttempt = Date.now() + reply.retryAfterMs;
      }
      if (reply.ok === true && reply.reloaded === true && isPositiveNumber(reply.resumeTime)) {
        state.resumeTime = reply.resumeTime;
      }
    }).catch(() => {
      if (!isCurrent(state)) return;
      state.ready = false;
      state.refreshUnavailable = true;
      recordResult(state, "ad-reload-state", undefined, "message-failed");
    }).finally(() => {
      state.stateReadInFlight = false;
      if (isCurrent(state)) scheduleScan();
    });
  }

  function syncVideoState() {
    const id = watchVideoId();
    if (videoState && videoState.id === id) {
      readReloadState(videoState);
      return videoState;
    }
    videoState = undefined;
    if (!id) return;
    const state: VideoState = { id, ready: false, reloadCount: 0, refreshUnavailable: false, reloading: false,
      stateReadInFlight: false, nextStateReadAt: 0, lastMainTime: 0, nextReloadAttempt: 0 };
    videoState = state;
    readReloadState(state);
    return state;
  }

  function completeResume(state: VideoState) {
    state.resumeTime = undefined;
    // The worker keeps the count while discarding only this document's
    // delivered playback position. A late acknowledgment cannot erase a newer retry.
    chrome.runtime.sendMessage({ type: "ad-resume-complete", url: location.href }).catch(() => {});
  }

  function inspectMainVideo(player: Element, state: VideoState | undefined) {
    if (!state || !isCurrent(state) || !player.isConnected) return;
    if (player.matches(".ad-showing, .ad-interrupting")) {
      state.mainReadySince = undefined;
      state.resumeDeadline = undefined;
      return;
    }
    if (mediaVideoId !== state.id) return;
    const video = player.querySelector<HTMLVideoElement>("video.html5-main-video") || player.querySelector("video");
    // Do not seek live streams or media whose duration is not known yet.
    if (!video || video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) return;
    if (state.resumeTime !== undefined) {
      state.resumeDeadline ??= Date.now() + RESUME_TIMEOUT_MS;
      if (Date.now() > state.resumeDeadline) {
        completeResume(state);
      } else {
        state.mainReadySince ??= Date.now();
        if (Date.now() - state.mainReadySince < MAIN_VIDEO_SETTLE_MS ||
            document.visibilityState !== "visible" || !document.hasFocus() || video.seeking ||
            state.resumeTime > video.duration) return;
        const target = Math.min(state.resumeTime, Math.max(0, video.duration - 0.25));
        try {
          // Respect a later position already restored by YouTube itself.
          if (video.currentTime + 1 < target) video.currentTime = target;
          completeResume(state);
        } catch { return; }
      }
    }
    if (Number.isFinite(video.currentTime) && video.currentTime >= 0 &&
        video.currentTime <= video.duration) state.lastMainTime = video.currentTime;
  }

  function requestReload(state: VideoState) {
    const request = { state };
    requestInFlight = request;
    state.nextReloadAttempt = Date.now() + RELOAD_INTERVAL_MS;
    const message = { type: "reload-ad", url: location.href,
      resumeTime: state.lastMainTime > 0 ? state.lastMainTime : state.resumeTime };
    Promise.resolve().then(() => chrome.runtime.sendMessage<unknown>(message)).then(value => {
      const reply = record(value);
      if (!isCurrent(state)) return;
      recordResult(state, "reload-ad", reply);
      if (isCount(reply.reloadCount)) state.reloadCount = reply.reloadCount;
      if (reply.ok === true) {
        state.reloading = reply.reloading === true;
      } else if (reply?.reason === "retry-later") {
        if (isPositiveNumber(reply.retryAfterMs)) {
          state.nextReloadAttempt = Date.now() + reply.retryAfterMs;
        }
      } else if (reply?.reason === "reload-limit") {
        // The worker reads the preference again before every reload.
        state.reloadCount = Math.max(state.reloadCount, maxReloads);
      } else {
        recoverReloadState(state);
      }
    }).catch(() => {
      if (isCurrent(state)) {
        recordResult(state, "reload-ad", undefined, "message-failed");
        recoverReloadState(state);
      }
    }).finally(() => {
      if (requestInFlight === request) requestInFlight = undefined;
      scheduleScan();
    });
  }

  function canClick(button: Element, player: Element | null) {
    if (!button.isConnected || button.closest(PLAYER_SELECTOR) !== player) {
      return false;
    }
    if (button.matches(":disabled") ||
        button.closest('[hidden], [inert], [aria-disabled="true"], [aria-hidden="true"]')) {
      return false;
    }
    if (button.getClientRects().length === 0) {
      return false;
    }

    const buttonStyle = getComputedStyle(button);
    if (buttonStyle.visibility !== "visible" || buttonStyle.pointerEvents === "none") {
      return false;
    }

    // Check ancestors too: the skip button can exist inside a hidden countdown.
    for (let element: Element | null = button; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.contentVisibility === "hidden" ||
          Number(style.opacity) === 0) {
        return false;
      }
    }
    const bounds = button.getBoundingClientRect();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    const hit = document.elementFromPoint(x, y);
    return bounds.width > 0 && bounds.height > 0 &&
      x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
      hit !== null && (hit === button || button.contains(hit));
  }

  function scanPlayers() {
    if (!enabled || requestInFlight || document.visibilityState !== "visible" ||
        !document.hasFocus() || location.pathname !== "/watch") return;

    // Reloading/removing an extension invalidates its old content scripts.
    try {
      if (!chrome.runtime.id) {
        stop();
        return;
      }
    } catch {
      stop();
      return;
    }

    const state = syncVideoState();
    if (state) state.lastForeground = { at: Date.now(),
      adPlayers: [...players.keys()].filter(player => player.isConnected &&
        player.matches(".ad-showing, .ad-interrupting")).length };
    if (!state || state.reloading || (!state.ready && !state.refreshUnavailable)) return;

    for (const player of players.keys()) {
      if (!player.isConnected) continue;
      inspectMainVideo(player, state);
      if (!player.matches(".ad-showing, .ad-interrupting")) continue;

      // Retry while the user's persisted budget remains. After the limit,
      // wait for an eligible skip button instead of refreshing indefinitely.
      if (state.ready && !state.refreshUnavailable && state.reloadCount < maxReloads) {
        if (Date.now() >= state.nextReloadAttempt) requestReload(state);
        return;
      }

      for (const button of player.querySelectorAll(SKIP_SELECTOR)) {
        if (!canClick(button, player)) continue;
        const now = Date.now();
        const lastClick = lastClicks.get(button);
        if (lastClick !== undefined && now - lastClick < CLICK_COOLDOWN_MS) continue;
        lastClicks.set(button, now);
        const request = { state };
        requestInFlight = request;
        chrome.runtime.sendMessage({ type: "skip-ad", url: location.href })
          .then(reply => recordResult(state, "skip-ad", reply))
          .catch(() => recordResult(state, "skip-ad", undefined, "message-failed"))
          .finally(() => {
            if (requestInFlight === request) requestInFlight = undefined;
          });
        // The worker validates the current button again before browser input.
        return;
      }
    }
  }

  function scheduleScan() {
    if (!enabled || scanQueued) return;
    scanQueued = true;
    const generation = lifecycle;
    // MutationObserver already batches DOM changes. Run once after that batch
    // without an additional fixed 80ms delay or a repeating fast poll.
    queueMicrotask(() => {
      if (generation !== lifecycle) return;
      scanQueued = false;
      scanPlayers();
    });
  }

  function scheduleReconcile() {
    if (!enabled || reconcileQueued) return;
    reconcileQueued = true;
    const generation = lifecycle;
    queueMicrotask(() => {
      if (generation !== lifecycle) return;
      reconcileQueued = false;
      reconcilePlayers();
    });
  }

  function containsElement(node: Node, selector: string) {
    if (node.nodeType !== 1) return false;
    const element = node as Element; // nodeType 1 is an Element, including across realms.
    return element.matches(selector) || element.querySelector(selector) !== null;
  }

  function discoverPlayers(records: MutationRecord[]) {
    if (!enabled || !watchVideoId() || document.visibilityState !== "visible" || !document.hasFocus()) return;
    if ([...players.keys()].some(player => !player.isConnected)) {
      scheduleReconcile();
      return;
    }
    for (const mutation of records) {
      const target = mutation.target.nodeType === 1 ? mutation.target as Element : null;
      const owner = target?.closest(PLAYER_SELECTOR);
      // Changes inside registered players have their own narrow observer.
      if (owner && players.has(owner)) continue;
      if (owner || [...mutation.addedNodes].some(node => containsElement(node, PLAYER_SELECTOR))) {
        scheduleReconcile();
        return;
      }
    }
  }

  function affectsAdControls(mutation: MutationRecord, player: Element) {
    // Player class changes include both ad entry and return to the main video.
    if (mutation.type === "attributes" && mutation.target === player && mutation.attributeName === "class") return true;
    if (!player.matches(".ad-showing, .ad-interrupting")) return false;
    if (mutation.target.nodeType === 1) {
      const target = mutation.target as Element;
      if (target === player || target.closest(SKIP_SELECTOR) || target.querySelector(SKIP_SELECTOR)) return true;
    }
    return mutation.type === "childList" && [...mutation.addedNodes, ...mutation.removedNodes]
      .some(node => containsElement(node, SKIP_SELECTOR));
  }

  function isElementTarget(target: EventTarget | null): target is Element {
    return target !== null && "nodeType" in target && target.nodeType === 1;
  }

  function onVisualTransition(event: Event) {
    if (!enabled || document.visibilityState !== "visible" || !document.hasFocus() ||
        !isElementTarget(event.target)) return;
    const target = event.target;
    const player = target.closest(PLAYER_SELECTOR);
    if (!player || !players.has(player) || !player.matches(".ad-showing, .ad-interrupting") ||
        (target !== player && !target.closest(SKIP_SELECTOR) && !target.querySelector(SKIP_SELECTOR))) return;
    scheduleScan();
    if (animationFrame !== undefined) return;
    const generation = lifecycle;
    // A newly started opacity transition can still be exactly zero in the
    // mutation microtask. Recheck once on the next rendered frame, not in a loop.
    animationFrame = requestAnimationFrame(() => {
      if (generation !== lifecycle) return;
      animationFrame = undefined;
      scheduleScan();
    });
  }

  function reconcilePlayers() {
    if (!enabled) return;
    const state = syncVideoState();
    const currentPlayers = new Set(document.querySelectorAll(PLAYER_SELECTOR));
    for (const [player, observer] of players) {
      if (!currentPlayers.has(player)) {
        observer.disconnect();
        players.delete(player);
      }
    }
    for (const player of currentPlayers) {
      if (players.has(player)) continue;
      const observer = new MutationObserver(records => {
        // Attach position listeners immediately when YouTube swaps the media
        // element, rather than waiting for the fallback reconciliation tick.
        if (records.some(record => record.type === "childList" &&
            [...record.addedNodes, ...record.removedNodes].some(node => containsElement(node, "video")))) {
          scheduleReconcile();
        }
        // Progress bars and captions mutate continuously. They must not turn
        // event-driven detection into a full scan on every animation frame.
        if (records.some(record => affectsAdControls(record, player))) scheduleScan();
      });
      observer.observe(player, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "class", "style", "disabled", "aria-disabled", "aria-hidden", "hidden", "inert"
        ]
      });
      players.set(player, observer);
    }
    const currentVideos = new Set<HTMLVideoElement>();
    for (const player of currentPlayers) {
      inspectMainVideo(player, state);
      const video = player.querySelector<HTMLVideoElement>("video.html5-main-video") || player.querySelector("video");
      if (!video) continue;
      currentVideos.add(video);
      if (videos.has(video)) continue;
      const sample = (event: Event) => {
        const current = syncVideoState();
        if (event.type === "loadedmetadata" && current &&
            !player.matches(".ad-showing, .ad-interrupting")) mediaVideoId = current.id;
        inspectMainVideo(player, current);
      };
      for (const type of ["timeupdate", "loadedmetadata", "seeked"]) video.addEventListener(type, sample);
      videos.set(video, sample);
    }
    for (const [video, sample] of videos) {
      if (currentVideos.has(video)) continue;
      for (const type of ["timeupdate", "loadedmetadata", "seeked"]) video.removeEventListener(type, sample);
      videos.delete(video);
    }
    // This also catches CSS transitions and players replaced during navigation.
    scheduleScan();
  }

  function stop() {
    enabled = false;
    lifecycle += 1;
    clearInterval(intervalId);
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
    for (const type of VISUAL_EVENTS) document.removeEventListener(type, onVisualTransition, true);
    discoveryObserver?.disconnect();
    discoveryObserver = undefined;
    intervalId = undefined;
    scanQueued = false;
    reconcileQueued = false;
    requestInFlight = undefined;
    videoState = undefined;
    for (const observer of players.values()) observer.disconnect();
    players.clear();
    for (const [video, sample] of videos) {
      for (const type of ["timeupdate", "loadedmetadata", "seeked"]) video.removeEventListener(type, sample);
    }
    videos.clear();
  }

  function setEnabled(value: boolean) {
    stop();
    enabled = value;
    if (!enabled) return;
    for (const type of VISUAL_EVENTS) document.addEventListener(type, onVisualTransition, true);
    discoveryObserver = new MutationObserver(discoverPlayers);
    discoveryObserver.observe(document, { childList: true, subtree: true });
    reconcilePlayers();
    intervalId = setInterval(reconcilePlayers, 1000);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.maxReloads) {
      reloadLimitRevision += 1;
      maxReloads = normalizeReloadLimit(changes.maxReloads.newValue);
      scheduleScan();
    }
    if (changes.enabled) {
      storageRevision += 1;
      setEnabled(changes.enabled.newValue !== false);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconcilePlayers();
  });
  document.addEventListener("yt-navigate-finish", reconcilePlayers);
  window.addEventListener("focus", reconcilePlayers);

  const initialRevision = storageRevision;
  const initialLimitRevision = reloadLimitRevision;
  chrome.storage.local.get({ enabled: true, maxReloads: 3 }).then((settings) => {
    if (reloadLimitRevision === initialLimitRevision) maxReloads = normalizeReloadLimit(settings.maxReloads);
    if (storageRevision === initialRevision) setEnabled(settings.enabled !== false);
  }).catch(() => {
    // Leave automation off if the saved preference cannot be read.
    if (storageRevision === initialRevision) stop();
  });
})();

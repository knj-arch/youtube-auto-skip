(() => {
  "use strict";

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
  const MAIN_VIDEO_SETTLE_MS = 500;
  const RESUME_TIMEOUT_MS = 15000;
  const players = new Map();
  const videos = new Map();
  const lastClicks = new WeakMap();
  let enabled = false;
  let intervalId;
  let scanTimeout;
  let storageRevision = 0;
  let reloadLimitRevision = 0;
  let maxReloads = 3;
  let requestInFlight;
  let videoState;
  // YouTube reuses its video element during SPA navigation. An old element's
  // currentTime must not become the new video's resume point before metadata.
  let mediaVideoId = watchVideoId();

  function normalizeReloadLimit(value) {
    return typeof value === "number" && Number.isFinite(value) ?
      Math.min(10, Math.max(1, Math.floor(value))) : 3;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "confirm-skip-document") return;
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

  function isCurrent(state) {
    return enabled && videoState === state && watchVideoId() === state.id;
  }

  function syncVideoState() {
    const id = watchVideoId();
    if (videoState?.id === id) return videoState;
    videoState = undefined;
    if (!id) return;
    const state = { id, ready: false, reloadCount: 0, refreshUnavailable: false, reloading: false,
      lastMainTime: 0, nextReloadAttempt: 0 };
    videoState = state;
    chrome.runtime.sendMessage({ type: "ad-reload-state", url: location.href }).then(reply => {
      if (!isCurrent(state)) return;
      // Refresh only with a known, persisted attempt count.
      state.refreshUnavailable = reply?.ok !== true || !Number.isInteger(reply.reloadCount) ||
        reply.reloadCount < 0;
      if (!state.refreshUnavailable) state.reloadCount = reply.reloadCount;
      if (Number.isFinite(reply?.retryAfterMs) && reply.retryAfterMs > 0) {
        state.nextReloadAttempt = Date.now() + reply.retryAfterMs;
      }
      if (reply?.ok && reply.reloaded && Number.isFinite(reply.resumeTime) && reply.resumeTime > 0) {
        state.resumeTime = reply.resumeTime;
      }
      state.ready = true;
      scheduleScan();
    }).catch(() => {
      if (!isCurrent(state)) return;
      state.refreshUnavailable = true;
      state.ready = true;
      scheduleScan();
    });
    return state;
  }

  function completeResume(state) {
    state.resumeTime = undefined;
    // The worker keeps the count while discarding only this document's
    // delivered playback position. A late acknowledgment cannot erase a newer retry.
    chrome.runtime.sendMessage({ type: "ad-resume-complete", url: location.href }).catch(() => {});
  }

  function inspectMainVideo(player, state) {
    if (!state || !isCurrent(state) || !player.isConnected) return;
    if (player.matches(".ad-showing, .ad-interrupting")) {
      state.mainReadySince = undefined;
      state.resumeDeadline = undefined;
      return;
    }
    if (mediaVideoId !== state.id) return;
    const video = player.querySelector("video.html5-main-video") || player.querySelector("video");
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

  function requestReload(state) {
    const request = { state };
    requestInFlight = request;
    state.nextReloadAttempt = Date.now() + RELOAD_INTERVAL_MS;
    chrome.runtime.sendMessage({ type: "reload-ad", url: location.href,
      resumeTime: state.lastMainTime > 0 ? state.lastMainTime : state.resumeTime }).then(reply => {
      if (!isCurrent(state)) return;
      if (Number.isInteger(reply?.reloadCount) && reply.reloadCount >= 0) state.reloadCount = reply.reloadCount;
      if (reply?.ok) {
        state.reloading = reply.reloading === true;
      } else if (reply?.reason === "retry-later") {
        if (Number.isFinite(reply.retryAfterMs) && reply.retryAfterMs > 0) {
          state.nextReloadAttempt = Date.now() + reply.retryAfterMs;
        }
      } else if (reply?.reason === "reload-limit") {
        // The worker reads the preference again before every reload.
        state.reloadCount = Math.max(state.reloadCount, maxReloads);
      } else if (!["busy", "inactive", "disabled", "document-changed"].includes(reply?.reason)) {
        state.refreshUnavailable = true;
      }
    }).catch(() => {
      // A reload can close the old message channel. The new document reads
      // the guard from the worker; this document must not keep refreshing.
      if (isCurrent(state)) state.refreshUnavailable = true;
    }).finally(() => {
      if (requestInFlight === request) requestInFlight = undefined;
      scheduleScan();
    });
  }

  function canClick(button, player) {
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
    for (let element = button; element; element = element.parentElement) {
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
    scanTimeout = undefined;
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
    if (!state?.ready || state.reloading) return;

    for (const player of players.keys()) {
      if (!player.isConnected) continue;
      inspectMainVideo(player, state);
      if (!player.matches(".ad-showing, .ad-interrupting")) continue;

      // Retry while the user's persisted budget remains. After the limit,
      // wait for an eligible skip button instead of refreshing indefinitely.
      if (!state.refreshUnavailable && state.reloadCount < maxReloads) {
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
          .catch(() => {})
          .finally(() => {
            if (requestInFlight === request) requestInFlight = undefined;
          });
        // The worker validates the current button again before browser input.
        return;
      }
    }
  }

  function scheduleScan() {
    if (enabled && scanTimeout === undefined) {
      scanTimeout = setTimeout(scanPlayers, 80);
    }
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
      const observer = new MutationObserver(scheduleScan);
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
    const currentVideos = new Set();
    for (const player of currentPlayers) {
      inspectMainVideo(player, state);
      const video = player.querySelector("video.html5-main-video") || player.querySelector("video");
      if (!video) continue;
      currentVideos.add(video);
      if (videos.has(video)) continue;
      const sample = event => {
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
    clearInterval(intervalId);
    clearTimeout(scanTimeout);
    intervalId = undefined;
    scanTimeout = undefined;
    requestInFlight = undefined;
    videoState = undefined;
    for (const observer of players.values()) observer.disconnect();
    players.clear();
    for (const [video, sample] of videos) {
      for (const type of ["timeupdate", "loadedmetadata", "seeked"]) video.removeEventListener(type, sample);
    }
    videos.clear();
  }

  function setEnabled(value) {
    stop();
    enabled = value;
    if (!enabled) return;
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

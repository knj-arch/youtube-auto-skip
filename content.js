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
  const players = new Map();
  const lastClicks = new WeakMap();
  let enabled = false;
  let intervalId;
  let scanTimeout;
  let storageRevision = 0;
  let requestInFlight = false;

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "confirm-skip-document") return;
    respond({
      ok: enabled && location.href === message.url && document.visibilityState === "visible",
      url: location.href
    });
  });

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
        location.pathname !== "/watch") return;

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

    for (const player of players.keys()) {
      if (!player.isConnected ||
          !player.matches(".ad-showing, .ad-interrupting")) continue;

      for (const button of player.querySelectorAll(SKIP_SELECTOR)) {
        if (!canClick(button, player)) continue;
        const now = Date.now();
        const lastClick = lastClicks.get(button);
        if (lastClick !== undefined && now - lastClick < CLICK_COOLDOWN_MS) continue;
        lastClicks.set(button, now);
        requestInFlight = true;
        chrome.runtime.sendMessage({ type: "skip-ad", url: location.href })
          .catch(() => {})
          .finally(() => { requestInFlight = false; });
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
    // This also catches CSS transitions and players replaced during navigation.
    scheduleScan();
  }

  function stop() {
    enabled = false;
    clearInterval(intervalId);
    clearTimeout(scanTimeout);
    intervalId = undefined;
    scanTimeout = undefined;
    for (const observer of players.values()) observer.disconnect();
    players.clear();
  }

  function setEnabled(value) {
    stop();
    enabled = value;
    if (!enabled) return;
    reconcilePlayers();
    intervalId = setInterval(reconcilePlayers, 1000);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.enabled) return;
    storageRevision += 1;
    setEnabled(changes.enabled.newValue !== false);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconcilePlayers();
  });

  const initialRevision = storageRevision;
  chrome.storage.local.get({ enabled: true }).then((settings) => {
    if (storageRevision === initialRevision) setEnabled(settings.enabled !== false);
  }).catch(() => {
    // Leave automation off if the saved preference cannot be read.
    if (storageRevision === initialRevision) stop();
  });
})();

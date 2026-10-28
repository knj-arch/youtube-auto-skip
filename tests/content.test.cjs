const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
const WATCH = "https://www.youtube.com/watch?v=video-a";
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function eventTarget(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type) { for (const fn of listeners.get(type) || []) fn({ type }); },
    listeners
  });
}

function harness(options = {}) {
  const calls = [], seeks = [], observers = [], timers = new Map();
  let now = 10000, nextTimer = 0, href = options.url || WATCH, mediaTime = options.time || 0;
  const state = { focused: true, covered: false, button: options.button !== false, ...options.state };
  const video = eventTarget({ readyState: 1, duration: 600, seeking: false });
  Object.defineProperty(video, "currentTime", {
    get: () => mediaTime,
    set: value => { seeks.push(value); mediaTime = value; }
  });
  const player = {
    ad: options.ad !== false, isConnected: true, parentElement: null,
    matches() { return this.ad; },
    querySelector(selector) { return selector.includes("video") ? video : null; },
    querySelectorAll() { return state.button ? [button] : []; }
  };
  const button = {
    isConnected: true, parentElement: player,
    closest(selector) { return selector === ".html5-video-player" ? player : null; },
    matches() { return false; }, getClientRects() { return [{}]; },
    getBoundingClientRect() { return { x: 20, y: 20, width: 100, height: 40 }; },
    contains(hit) { return hit === this; }
  };
  const document = eventTarget({
    visibilityState: "visible", hasFocus: () => state.focused,
    querySelectorAll() { return player.isConnected ? [player] : []; },
    querySelector() { return player.isConnected && player.ad ? player : null; },
    elementFromPoint() { return state.covered ? {} : button; }
  });
  const runtimeListeners = [], storageListeners = [];
  const window = eventTarget();
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "1.0.4" }),
      id: "own-extension", onMessage: { addListener: fn => runtimeListeners.push(fn) },
      sendMessage(message) {
        calls.push(JSON.parse(JSON.stringify(message)));
        if (message.type === "ad-reload-state") {
          return Promise.resolve(options.reloadState ? options.reloadState(message) :
            { ok: true, reloaded: options.reloaded === true,
              reloadCount: options.reloadCount ?? (options.reloaded === true ? 3 : 0),
              retryAfterMs: options.retryAfterMs || 0, resumeTime: options.resumeTime });
        }
        if (message.type === "reload-ad") return Promise.resolve(options.reloadReply ?
          options.reloadReply(message) : { ok: true, reloading: true, reloadCount: (options.reloadCount || 0) + 1 });
        return Promise.resolve({ ok: true });
      }
    },
    storage: { local: { get: async () => ({ enabled: options.enabled !== false,
      maxReloads: options.maxReloads === undefined ? 3 : options.maxReloads }) },
      onChanged: { addListener: fn => storageListeners.push(fn) } }
  };
  const addTimer = (fn, delay, repeat) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + delay, repeat });
    return id;
  };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, {
    chrome, document, window, URL, Date: Clock, innerWidth: 1000, innerHeight: 800,
    location: { get href() { return href; }, get pathname() { return new URL(href).pathname; } },
    getComputedStyle: () => ({ visibility: "visible", pointerEvents: "auto", display: "block",
      contentVisibility: "visible", opacity: "1" }),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    setTimeout: (fn, delay) => addTimer(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => addTimer(fn, delay, delay), clearInterval: id => timers.delete(id)
  });
  return {
    calls, seeks, state, video, player, document, window,
    actions: () => calls.filter(message => message.type !== "ad-reload-state"),
    async advance(milliseconds) {
      await flush();
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.repeat;
        else timers.delete(id);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    ad(value) { player.ad = value; for (const observer of observers) if (observer.active) observer.fn(); },
    time(value) { mediaTime = value; video.emit("timeupdate"); },
    navigate(url) { href = url; document.emit("yt-navigate-finish"); },
    enabled(value) {
      for (const fn of storageListeners) fn({ enabled: { newValue: value } }, "local");
    },
    maxReloads(value) {
      for (const fn of storageListeners) fn({ maxReloads: { newValue: value } }, "local");
    },
    diagnose(senderId = "own-extension") {
      let reply;
      for (const fn of runtimeListeners) fn({ type: "automation-content-status" },
        { id: senderId }, value => { reply = value; });
      return reply;
    },
    confirm(requireAd = false) {
      let reply;
      for (const fn of runtimeListeners) fn({ type: "confirm-skip-document", url: href, requireAd },
        { id: "own-extension" }, value => { reply = value; });
      return reply;
    }
  };
}

test("an initial ad reloads before clicking, even without a skip button", async () => {
  for (const button of [true, false]) {
    const h = harness({ button });
    await h.advance(5000);
    assert.deepEqual(h.actions().map(message => message.type), ["reload-ad"]);
  }
});

test("after exhausting the default budget the same ad uses the skip fallback", async () => {
  const h = harness({ reloaded: true });
  await h.advance(100);
  assert.deepEqual(h.actions().map(message => message.type), ["skip-ad"]);
});

test("an ad without a button waits after the reload budget is exhausted", async () => {
  const h = harness({ reloaded: true, button: false });
  await h.advance(5000);
  assert.deepEqual(h.actions(), []);
  h.state.button = true;
  h.ad(true);
  await h.advance(100);
  assert.deepEqual(h.actions().map(message => message.type), ["skip-ad"]);
});

test("storage failure falls back to skipping instead of unguarded refreshes", async () => {
  for (const failRead of [true, false]) {
    const h = harness(failRead ? { reloadState: () => ({ ok: false }) } :
      { reloadReply: () => ({ ok: false, reason: "reload-state-unavailable" }) });
    await h.advance(300);
    assert.deepEqual(h.actions().map(message => message.type), failRead ? ["skip-ad"] : ["reload-ad", "skip-ad"]);
  }
});

test("inactive replies can retry on focus return without a tight reload loop", async () => {
  let attempts = 0;
  const h = harness({ button: false, reloadReply: () => ++attempts === 1 ?
    { ok: false, reason: "inactive" } : { ok: true, reloading: true } });
  await h.advance(1000);
  assert.equal(attempts, 1);
  await h.advance(2500);
  assert.equal(attempts, 2);
  assert.deepEqual(h.actions().map(message => message.type), ["reload-ad", "reload-ad"]);
});

test("mid-roll refresh saves the main-video position rather than the ad time", async () => {
  const h = harness({ ad: false });
  await h.advance(100);
  h.time(200);
  h.ad(true);
  h.time(3);
  await h.advance(100);
  assert.deepEqual(h.actions(), [{ type: "reload-ad", url: WATCH, resumeTime: 200 }]);
});

test("resume waits for the main video and survives a long non-skippable ad", async () => {
  const h = harness({ reloaded: true, button: false, resumeTime: 200 });
  await h.advance(30000);
  assert.deepEqual(h.seeks, []);
  h.time(3);
  h.ad(false);
  await h.advance(100);
  assert.deepEqual(h.seeks, []);
  await h.advance(1100);
  assert.deepEqual(h.seeks, [200]);
  h.time(203);
  await h.advance(3000);
  assert.deepEqual(h.seeks, [200]);
});

test("resume respects a later provider position and never seeks a live stream", async () => {
  for (const live of [false, true]) {
    const h = harness({ ad: false, reloaded: true, resumeTime: 200, time: live ? 0 : 230 });
    if (live) h.video.duration = Infinity;
    await h.advance(3000);
    assert.deepEqual(h.seeks, []);
  }
});

test("SPA navigation discards a pending resume from a different video", async () => {
  const h = harness({ reloaded: true, resumeTime: 200, button: false,
    reloadState: message => ({ ok: true, reloaded: message.url === WATCH,
      reloadCount: message.url === WATCH ? 3 : 0, resumeTime: message.url === WATCH ? 200 : undefined }) });
  await h.advance(100);
  h.navigate("https://www.youtube.com/watch?v=video-b");
  h.ad(false);
  await h.advance(2000);
  assert.deepEqual(h.seeks, []);
  h.ad(true);
  await h.advance(100);
  assert.deepEqual(h.actions().map(message => [message.type, message.url]),
    [["reload-ad", "https://www.youtube.com/watch?v=video-b"]]);
});

test("SPA navigation never samples the previous video's retained currentTime", async () => {
  for (const metadataReady of [false, true]) {
    const h = harness({ ad: false, time: 200 });
    await h.advance(100);
    h.navigate("https://www.youtube.com/watch?v=video-b");
    await h.advance(100);
    if (metadataReady) {
      h.time(35);
      h.video.emit("loadedmetadata");
    }
    h.ad(true);
    h.time(3);
    await h.advance(100);
    const reload = h.actions()[0];
    assert.equal(reload.type, "reload-ad");
    assert.equal(reload.url, "https://www.youtube.com/watch?v=video-b");
    assert.equal(reload.resumeTime, metadataReady ? 35 : undefined);
  }
});

test("disabled, unfocused, hidden, non-watch, and covered fallback states do not act", async () => {
  const cases = [
    { enabled: false }, { state: { focused: false } },
    { url: "https://www.youtube.com/shorts/video-a" }, { url: "https://www.youtube.com/watch" },
    { reloaded: true, state: { covered: true } }
  ];
  for (const options of cases) {
    const h = harness(options);
    await h.advance(2000);
    assert.deepEqual(h.actions(), []);
  }
  const hidden = harness();
  hidden.document.visibilityState = "hidden";
  await hidden.advance(2000);
  assert.deepEqual(hidden.actions(), []);
});

test("turning off cancels scans and a delayed state reply cannot restart them", async () => {
  let resolve;
  const delayed = new Promise(done => { resolve = done; });
  const h = harness({ reloadState: () => delayed });
  await h.advance(100);
  h.enabled(false);
  resolve({ ok: true, reloaded: false });
  await h.advance(3000);
  assert.deepEqual(h.actions(), []);
});

test("a stale state response cannot override the current SPA video", async () => {
  let resolve;
  const delayed = new Promise(done => { resolve = done; });
  const h = harness({ reloadState: message => message.url === WATCH ? delayed :
    { ok: true, reloaded: true, reloadCount: 3 } });
  await h.advance(100);
  h.navigate("https://www.youtube.com/watch?v=video-b");
  await h.advance(100);
  resolve({ ok: true, reloaded: false });
  await h.advance(1000);
  assert.deepEqual(h.actions().map(message => message.type), ["skip-ad"]);
});

test("the worker's reload confirmation requires a current foreground ad", async () => {
  const h = harness({ ad: false });
  await h.advance(100);
  assert.equal(h.confirm(true).ok, false);
  h.ad(true);
  assert.equal(h.confirm(true).ok, true);
  assert.equal(h.confirm(true).adShowing, true);
  h.state.focused = false;
  assert.equal(h.confirm(true).ok, false);
  h.state.focused = true;
  h.enabled(false);
  assert.equal(h.confirm(true).ok, false);
});

test("remaining attempts repeat a reload after the persisted minimum interval", async () => {
  const h = harness({ reloadCount: 1, retryAfterMs: 3000 });
  await h.advance(2900);
  assert.deepEqual(h.actions(), []);
  await h.advance(1300);
  assert.deepEqual(h.actions().map(message => message.type), ["reload-ad"]);
});

test("the user's limit controls fallback and a later increase permits another attempt", async () => {
  const h = harness({ maxReloads: 1, reloadCount: 1 });
  await h.advance(100);
  assert.deepEqual(h.actions().map(message => message.type), ["skip-ad"]);
  h.maxReloads(5);
  await h.advance(100);
  assert.deepEqual(h.actions().map(message => message.type), ["skip-ad", "reload-ad"]);
});

test("decreasing the limit stops refreshes without resetting the saved count", async () => {
  const h = harness({ maxReloads: 5, reloadCount: 3, retryAfterMs: 3000 });
  await h.advance(100);
  h.maxReloads(2);
  await h.advance(100);
  assert.deepEqual(h.actions().map(message => message.type), ["skip-ad"]);
});

test("retry-later replies keep their server-provided delay instead of skipping or looping", async () => {
  let attempts = 0;
  const h = harness({ reloadReply: () => ++attempts === 1 ?
    { ok: false, reason: "retry-later", retryAfterMs: 5000, reloadCount: 1 } :
    { ok: true, reloading: true, reloadCount: 2 } });
  await h.advance(5000);
  assert.equal(attempts, 1);
  await h.advance(1500);
  assert.equal(attempts, 2);
  assert.equal(h.actions().some(message => message.type === "skip-ad"), false);
});

test("retries carry the original position across documents while the ad is playing", async () => {
  const h = harness({ reloadCount: 1, reloaded: true, resumeTime: 200, time: 3 });
  await h.advance(100);
  assert.deepEqual(h.seeks, []);
  assert.deepEqual(h.actions(), [{ type: "reload-ad", url: WATCH, resumeTime: 200 }]);
});

test("restoration acknowledges completion so the worker can discard the resume payload", async () => {
  const h = harness({ ad: false, reloaded: true, resumeTime: 200 });
  await h.advance(1300);
  assert.deepEqual(h.seeks, [200]);
  assert.deepEqual(h.actions().map(message => message.type), ["ad-resume-complete"]);
});

test("a changed limit racing the initial preference read is not overwritten", async () => {
  const h = harness({ maxReloads: 1, reloadCount: 1 });
  h.maxReloads(5);
  await h.advance(100);
  assert.deepEqual(h.actions().map(message => message.type), ["reload-ad"]);
});

test("an undefined, malformed, rejected or synchronously failed initial state recovers after three seconds", async () => {
  const failures = [
    () => undefined,
    () => ({ ok: false, reloadCount: 0 }),
    () => ({ ok: true, reloadCount: "0" }),
    () => ({ ok: true, reloadCount: -1 }),
    () => Promise.reject(new Error("Temporary message failure")),
    () => { throw new Error("Temporary synchronous message failure"); }
  ];
  for (const fail of failures) {
    let reads = 0;
    const h = harness({ button: false, reloadState: () => ++reads === 1 ? fail() :
      { ok: true, reloaded: false, reloadCount: 0, retryAfterMs: 0 } });
    await h.advance(2900);
    assert.equal(reads, 1);
    assert.deepEqual(h.actions(), []);
    await h.advance(500);
    assert.equal(reads, 2);
    assert.deepEqual(h.actions().map(message => message.type), ["reload-ad"]);
    await h.advance(10000);
    assert.equal(reads, 2);
  }
});

test("unknown state reads stay rate limited while the existing skip fallback remains available", async () => {
  const h = harness({ reloadState: () => ({ ok: false, reason: "reload-state-unavailable" }) });
  await h.advance(10000);
  assert.equal(h.calls.filter(message => message.type === "ad-reload-state").length, 4);
  assert.ok(h.actions().length > 0);
  assert.ok(h.actions().every(message => message.type === "skip-ad"));
});

test("state retries preserve the stored attempt cap and its remaining retry interval", async () => {
  for (const maxReloads of [1, 3]) {
    let reads = 0;
    const h = harness({ maxReloads, reloadState: () => ++reads === 1 ? undefined :
      { ok: true, reloaded: true, reloadCount: maxReloads, retryAfterMs: 0 } });
    await h.advance(10000);
    assert.equal(reads, 2);
    assert.ok(h.actions().length > 0);
    assert.ok(h.actions().every(message => message.type === "skip-ad"));
  }
  let reads = 0;
  const h = harness({ button: false, reloadState: () => ++reads === 1 ? undefined :
    { ok: true, reloaded: true, reloadCount: 1, retryAfterMs: 4000 } });
  await h.advance(6900);
  assert.equal(reads, 2);
  assert.deepEqual(h.actions(), []);
  await h.advance(500);
  assert.deepEqual(h.actions().map(message => message.type), ["reload-ad"]);
});

test("focus and visibility activation resume failed state reads without reading in the background", async () => {
  for (const hidden of [false, true]) {
    let reads = 0;
    const h = harness({ button: false, reloadState: () => ++reads === 1 ? undefined :
      { ok: true, reloaded: false, reloadCount: 0, retryAfterMs: 0 } });
    await h.advance(100);
    if (hidden) h.document.visibilityState = "hidden";
    else h.state.focused = false;
    await h.advance(10000);
    assert.equal(reads, 1);
    assert.deepEqual(h.actions(), []);
    if (hidden) {
      h.document.visibilityState = "visible";
      h.document.emit("visibilitychange");
    } else {
      h.state.focused = true;
      h.window.emit("focus");
    }
    await h.advance(100);
    assert.equal(reads, 2);
    assert.deepEqual(h.actions().map(message => message.type), ["reload-ad"]);
  }
});

test("an initially hidden or unfocused page waits until activation before its first state read", async () => {
  for (const hidden of [false, true]) {
    const h = harness({ button: false, state: { focused: hidden } });
    if (hidden) h.document.visibilityState = "hidden";
    await h.advance(5000);
    assert.equal(h.calls.length, 0);
    if (hidden) {
      h.document.visibilityState = "visible";
      h.document.emit("visibilitychange");
    } else {
      h.state.focused = true;
      h.window.emit("focus");
    }
    await h.advance(100);
    assert.deepEqual(h.actions().map(message => message.type), ["reload-ad"]);
  }
});

test("a delayed state read never overlaps another read after repeated activation events", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = harness({ reloadState: () => pending });
  await h.advance(100);
  for (let repeat = 0; repeat < 4; repeat++) {
    h.window.emit("focus");
    h.document.emit("visibilitychange");
    await h.advance(3000);
  }
  assert.equal(h.calls.filter(message => message.type === "ad-reload-state").length, 1);
  assert.deepEqual(h.actions(), []);
  resolve({ ok: true, reloaded: true, reloadCount: 3, retryAfterMs: 0 });
  await h.advance(100);
  assert.deepEqual(h.actions().map(message => message.type), ["skip-ad"]);
});

test("turning off during a delayed retry prevents both late recovery and further queries", async () => {
  let reads = 0, resolve;
  const delayed = new Promise(done => { resolve = done; });
  const h = harness({ button: false, reloadState: () => ++reads === 1 ? undefined : delayed });
  await h.advance(3200);
  assert.equal(reads, 2);
  h.enabled(false);
  resolve({ ok: true, reloaded: false, reloadCount: 0, retryAfterMs: 0 });
  h.window.emit("focus");
  h.document.emit("visibilitychange");
  await h.advance(10000);
  assert.equal(reads, 2);
  assert.deepEqual(h.actions(), []);
});

test("a retry response from the previous SPA video cannot override the current video's persisted cap", async () => {
  let readsForA = 0, resolve;
  const delayed = new Promise(done => { resolve = done; });
  const h = harness({ reloadState: message => message.url === WATCH ?
    ++readsForA === 1 ? undefined : delayed : { ok: true, reloaded: true, reloadCount: 3, retryAfterMs: 0 } });
  await h.advance(3200);
  assert.equal(readsForA, 2);
  h.navigate("https://www.youtube.com/watch?v=video-b");
  await h.advance(100);
  resolve({ ok: true, reloaded: false, reloadCount: 0, retryAfterMs: 0 });
  await h.advance(10000);
  assert.equal(readsForA, 2);
  assert.ok(h.actions().every(message => message.type === "skip-ad"));
});

test("an uncertain reload-ad response does not enable extra refreshes using an unverified old count", async () => {
  let persistedCount = 0;
  const h = harness({ reloadState: () => ({ ok: true, reloadCount: persistedCount }),
    reloadReply: () => { persistedCount += 1; return Promise.reject(new Error("Reload response channel closed")); } });
  await h.advance(10000);
  assert.equal(h.actions().filter(message => message.type === "reload-ad").length, 3);
  assert.ok(h.calls.filter(message => message.type === "ad-reload-state").length >= 3);
  assert.ok(h.actions().some(message => message.type === "skip-ad"));
  await h.advance(30000);
  assert.equal(h.actions().filter(message => message.type === "reload-ad").length, 3);
  assert.equal(h.calls.filter(message => message.type === "ad-reload-state").length, 4);
});

test("transient reload failures recover after a delayed persisted-state read without toggling", async () => {
  for (const reason of ["timeout", "failed", "reload-state-unavailable", "ad-not-showing", "busy",
    "inactive", "document-changed", "disabled"]) {
    let attempts = 0;
    const h = harness({ button: false, reloadReply: () => ++attempts === 1 ?
      { ok: false, reason, reloadCount: 0 } : { ok: true, reloading: true, reloadCount: 1 } });
    await h.advance(200);
    assert.equal(attempts, 1);
    assert.equal(h.diagnose().lastResult.reason, reason);
    assert.equal(h.diagnose().state.ready, false);
    await h.advance(2800);
    assert.equal(attempts, 1);
    await h.advance(1300);
    assert.equal(attempts, 2);
    assert.equal(h.calls.filter(message => message.type === "ad-reload-state").length, 2);
  }
});

test("an uncertain refund response cannot leave a healthy page stuck at a stale exhausted budget", async () => {
  let attempts = 0;
  const h = harness({ button: false, reloadState: () => ({ ok: true, reloadCount: 2 }),
    reloadReply: () => ++attempts === 1 ? { ok: false, reason: "inactive", reloadCount: 3 } :
      { ok: true, reloading: true, reloadCount: 3 } });
  await h.advance(200);
  assert.equal(h.diagnose().state.reloadCount, 3);
  assert.equal(h.diagnose().state.ready, false);
  await h.advance(4000);
  assert.equal(attempts, 2);
  assert.equal(h.calls.filter(message => message.type === "ad-reload-state").length, 2);
});

test("a missing reload response cannot bypass an unreadable persisted count", async () => {
  let reads = 0;
  const h = harness({ button: false, reloadState: () => ++reads === 1 ?
    { ok: true, reloadCount: 0 } : { ok: false, reason: "reload-state-unavailable" },
    reloadReply: () => undefined });
  await h.advance(30000);
  assert.equal(h.actions().filter(message => message.type === "reload-ad").length, 1);
  assert.ok(reads >= 5);
  assert.equal(h.diagnose().state.ready, false);
});

test("diagnostics are read-only, omit viewing identifiers, and retain the pre-popup foreground sample", async () => {
  const h = harness({ button: false, reloadCount: 3 });
  await h.advance(200);
  const before = h.calls.length;
  h.state.focused = false;
  const snapshot = h.diagnose();
  assert.equal(snapshot.build, "1.0.4");
  assert.equal(snapshot.adPlayers, 1);
  assert.equal(snapshot.state.reloadCount, 3);
  assert.equal(snapshot.focused, false);
  assert.equal(snapshot.lastForeground.focused, true);
  assert.equal(snapshot.lastForeground.adPlayers, 1);
  assert.equal(h.calls.length, before);
  assert.equal(JSON.stringify(snapshot).includes("video-a"), false);
  assert.equal(JSON.stringify(snapshot).includes("https://"), false);
  assert.equal(h.diagnose("unrelated-extension"), undefined);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const WATCH = "https://www.youtube.com/watch?v=video-a";
const event = () => {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)), listeners };
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const reloadRecord = values => ({ videoId: "video-a", sourceDocumentId: "document-a",
  reloadCount: 1, lastReloadAt: 10000, ...values });

function harness(options = {}) {
  const calls = { attach: [], detach: [], commands: [], confirms: [], writes: [],
    reloads: [], sessionReads: [], sessionWrites: [], sessionRemoves: [] };
  const state = { enabled: true, active: true, focused: true, now: 10000, frameReads: 0, targetReads: 0,
    url: WATCH, loaderId: "loader-a", confirmation: true, adShowing: true, ...options.state };
  const sessionData = options.sessionData || {};
  const timers = new Map();
  let timerId = 0;
  const events = { message: event(), detach: event(), debugger: event(), storage: event(),
    updated: event(), activated: event(), removed: event(), focused: event() };
  const chrome = {
    runtime: { id: "own-extension", onMessage: events.message },
    storage: {
      local: {
        get: async () => {
          if (options.localReadError) throw new Error("Preference read failed");
          return { enabled: state.enabled, maxReloads: state.maxReloads };
        },
        set: async values => {
          calls.writes.push(values);
          const oldValue = state.enabled;
          state.enabled = values.enabled;
          events.storage.emit({ enabled: { oldValue, newValue: values.enabled } }, "local");
        }
      },
      session: {
        get: async key => {
          calls.sessionReads.push(key);
          if (options.sessionReadError) throw new Error("Session storage read failed");
          return sessionData[key] === undefined ? {} : { [key]: structuredClone(sessionData[key]) };
        },
        set: async values => {
          calls.sessionWrites.push(structuredClone(values));
          if (typeof options.sessionWriteError === "function" ?
              options.sessionWriteError({ calls, state, events, sessionData }) : options.sessionWriteError) {
            throw new Error("Session storage write failed");
          }
          if (options.sessionWriteDeferred) await options.sessionWriteDeferred.promise;
          Object.assign(sessionData, structuredClone(values));
          if (options.afterSessionWrite) await options.afterSessionWrite({ calls, state, events, sessionData });
        },
        remove: async key => {
          calls.sessionRemoves.push(key);
          delete sessionData[key];
        }
      }, onChanged: events.storage
    },
    tabs: {
      get: async () => {
        if (options.tabRemovedDuringCleanup && calls.detach.length) throw new Error("No such tab");
        return { id: 7, windowId: 9, active: state.active, status: "complete", ...state.tab };
      },
      sendMessage: async (tabId, message, target) => {
        calls.confirms.push({ tabId, message, target });
        if (options.confirmError) throw new Error("No matching document");
        return { ok: state.confirmation, url: state.url, adShowing: state.adShowing };
      },
      reload: async tabId => {
        calls.reloads.push(tabId);
        if (options.emitReloadLoading) events.updated.emit(tabId, { status: "loading" });
        if (options.reloadError) throw new Error("Reload failed");
      },
      onUpdated: events.updated, onActivated: events.activated, onRemoved: events.removed
    },
    windows: { get: async () => ({ id: 9, focused: state.focused }), onFocusChanged: events.focused },
    debugger: {
      attach: async target => {
        calls.attach.push(target);
        if (options.attachError) throw new Error("Another debugger is already attached");
        if (options.attachDeferred) await options.attachDeferred.promise;
      },
      detach: async target => {
        calls.detach.push(target);
        if (options.detachError) throw new Error("Detach failed");
        if (options.emitOwnDetach) events.detach.emit(target, "canceled_by_user");
      },
      sendCommand: async (target, method, params) => {
        calls.commands.push({ target, method, params });
        if (options.beforeCommand) await options.beforeCommand({ target, method, params }, { calls, state, events });
        if (method === "Page.getFrameTree") {
          state.frameReads += 1;
          return { frameTree: { frame: { id: "frame-a", loaderId: state.loaderId, url: state.url } } };
        }
        if (method === "Runtime.evaluate") {
          state.targetReads += 1;
          const point = options.target ? options.target(state.targetReads, state) : { x: 50, y: 60, href: state.url };
          return { result: { value: point } };
        }
        return {};
      },
      onDetach: events.detach, onEvent: events.debugger
    }
  };
  class Clock extends Date { static now() { return state.now; } }
  vm.runInNewContext(source, {
    chrome, URL, Date: Clock,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  const sender = { id: "own-extension", frameId: 0, documentId: "document-a", documentLifecycle: "active",
    url: WATCH, tab: { id: 7, windowId: 9, url: WATCH } };
  const request = (message = {}, override = {}) => new Promise(resolve => {
    let responded = false;
    const keepOpen = events.message.listeners[0]({ type: "skip-ad", url: state.url, ...message },
      { ...sender, ...override }, value => { responded = true; resolve(value); });
    if (!keepOpen && !responded) resolve(undefined);
  });
  const mouseEvents = () => calls.commands.filter(item => item.method === "Input.dispatchMouseEvent").map(item => item.params);
  return { calls, state, events, request, mouseEvents, timers, sessionData };
}

test("uses only fixed CDP commands and the freshly verified target, with pinned document replies", async () => {
  const h = harness({ emitOwnDetach: true, target: count => ({ x: count * 50, y: 60, href: WATCH }) });
  const reply = await h.request({ x: 999, y: 999, script: "throw new Error('caller code')" });
  assert.equal(reply.ok, true);
  assert.deepEqual(h.mouseEvents().map(item => [item.type, item.x, item.y]), [
    ["mouseMoved", 50, 60], ["mousePressed", 100, 60], ["mouseReleased", 100, 60]
  ]);
  assert.equal(h.calls.attach.length, 1);
  assert.equal(h.calls.detach.length, 1);
  assert.equal(h.calls.writes.length, 0);
  assert.ok(h.calls.confirms.every(item => item.target.documentId === "document-a" && item.target.frameId === 0));
  assert.ok(h.calls.commands.filter(item => item.method === "Runtime.evaluate").every(item =>
    !item.params.expression.includes("caller code") && item.params.returnByValue));
});

test("rejects other extensions, subframes, missing documents, inactive documents, and other origins", async () => {
  for (const override of [{ id: "other" }, { frameId: 1 }, { documentId: undefined },
    { documentLifecycle: "cached" }, { url: "https://evil.example/watch" }]) {
    const h = harness();
    assert.equal(await h.request({}, override), undefined);
    assert.equal(h.calls.attach.length, 0);
    assert.equal(h.calls.commands.length, 0);
  }
  for (const url of ["https://www.youtube.com.evil.example/watch", "http://www.youtube.com/watch",
    "https://user@www.youtube.com/watch", "https://www.youtube.com/shorts/video-a"]) {
    const h = harness();
    assert.equal(await h.request({ url }), undefined);
    assert.equal(h.calls.attach.length, 0);
  }
});

test("saved off, inactive tabs, and unfocused windows never attach", async () => {
  for (const state of [{ enabled: false }, { active: false }, { focused: false }]) {
    const h = harness({ state });
    assert.equal((await h.request()).ok, false);
    assert.equal(h.calls.attach.length, 0);
    assert.equal(h.mouseEvents().length, 0);
  }
});

test("a stale document with the same URL cannot pass the documentId handshake", async () => {
  const h = harness({ confirmError: true });
  assert.equal((await h.request()).ok, false);
  assert.equal(h.calls.attach.length, 0);
});

test("SPA messages may use their current URL while the sender metadata retains the previous URL", async () => {
  const current = "https://www.youtube.com/watch?v=video-b";
  for (const previous of [WATCH, "https://www.youtube.com/", "https://www.youtube.com/results?search_query=video"]) {
    const h = harness({ state: { url: current } });
    assert.equal((await h.request({ url: current }, { url: previous })).ok, true);
  }
});

test("Chrome exposing a different current tab URL blocks the request", async () => {
  const h = harness({ state: { tab: { url: "https://www.youtube.com/watch?v=other" } } });
  assert.equal((await h.request()).reason, "document-changed");
  assert.equal(h.calls.attach.length, 0);
});

test("a changed loader or URL after hover prevents the press and cleans up", async () => {
  for (const field of ["loaderId", "url"]) {
    const h = harness({ beforeCommand: async ({ method, params }, { state }) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
        state[field] = field === "url" ? "https://www.youtube.com/watch?v=other" : "loader-b";
      }
    } });
    assert.equal((await h.request()).reason, "document-changed");
    assert.equal(h.mouseEvents().some(item => item.type === "mousePressed"), false);
    assert.equal(h.calls.detach.length, 1);
  }
});

test("a vanished, disabled, or covered current target cannot be clicked", async () => {
  const h = harness({ target: count => count === 1 ? { x: 50, y: 60, href: WATCH } : null });
  assert.equal((await h.request()).reason, "target-unavailable");
  assert.equal(h.mouseEvents().some(item => item.type === "mousePressed"), false);
  assert.equal(h.calls.detach.length, 1);
});

test("settings off during hover aborts before mouse down", async () => {
  const h = harness({ beforeCommand: async ({ method, params }, { state, events }) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
      state.enabled = false;
      events.storage.emit({ enabled: { newValue: false } }, "local");
    }
  } });
  assert.equal((await h.request()).ok, false);
  assert.equal(h.mouseEvents().some(item => item.type === "mousePressed"), false);
  assert.equal(h.calls.detach.length, 1);
});

test("user debugger cancellation persists off, prevents reattach, and explicit on restores operation", async () => {
  let cancelled = false;
  const h = harness({ beforeCommand: async ({ method, params }, { events }) => {
    if (!cancelled && method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
      cancelled = true;
      events.detach.emit({ tabId: 7 }, "canceled_by_user");
    }
  } });
  assert.equal((await h.request()).ok, false);
  assert.equal(h.state.enabled, false);
  assert.equal(h.mouseEvents().some(item => item.type === "mousePressed"), false);
  assert.equal((await h.request()).reason, "disabled");
  assert.equal(h.calls.attach.length, 1);
  h.state.enabled = true;
  h.events.storage.emit({ enabled: { oldValue: false, newValue: true } }, "local");
  assert.equal((await h.request()).ok, true);
  assert.ok(h.calls.writes.every(values => Object.keys(values).join() === "enabled"));
});

test("concurrent requests do not attach a second debugger", async () => {
  const attachDeferred = deferred();
  const h = harness({ attachDeferred });
  const first = h.request();
  await flush();
  assert.equal((await h.request()).reason, "busy");
  assert.equal(h.calls.attach.length, 1);
  attachDeferred.resolve();
  assert.equal((await first).ok, true);
});

test("a timed-out late attach is detached and never dispatches input", async () => {
  const attachDeferred = deferred();
  const h = harness({ attachDeferred });
  const request = h.request();
  await flush();
  h.state.now += 2001;
  for (const callback of h.timers.values()) callback();
  attachDeferred.resolve();
  assert.equal((await request).reason, "timeout");
  assert.equal(h.calls.detach.length, 1);
  assert.equal(h.mouseEvents().length, 0);
});

test("a main-frame navigation event cancels; a child-frame navigation does not", async () => {
  for (const child of [false, true]) {
    const h = harness({ beforeCommand: async ({ method, params }, { events }) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
        events.debugger.emit({ tabId: 7 }, "Page.frameNavigated", {
          frame: child ? { id: "child", parentId: "frame-a" } : { id: "frame-a" }
        });
      }
    } });
    assert.equal((await h.request()).ok, child);
    assert.equal(h.calls.detach.length, 1);
  }
});

test("focus loss or tab navigation after down releases outside the viewport without clicking", async () => {
  for (const focusLoss of [true, false]) {
    const h = harness({ beforeCommand: async ({ method, params }, { events }) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
        if (focusLoss) events.focused.emit(-1);
        else events.updated.emit(7, { status: "loading" });
      }
    } });
    assert.equal((await h.request()).ok, false);
    assert.deepEqual(h.mouseEvents().filter(item => item.type === "mouseReleased").map(item => [item.x, item.y]), [[-1, -1]]);
    assert.equal(h.calls.detach.length, 1);
  }
});

test("attach conflicts leave the existing debugger alone and turn automation off", async () => {
  const h = harness({ attachError: true });
  assert.equal((await h.request()).reason, "debugger-unavailable");
  assert.equal(h.calls.detach.length, 0);
  assert.equal(h.mouseEvents().length, 0);
  assert.equal(h.state.enabled, false);
});

test("failed cleanup retries detach once and disables further attempts", async () => {
  const h = harness({ detachError: true });
  assert.equal((await h.request()).reason, "cleanup-failed");
  assert.equal(h.calls.detach.length, 2);
  assert.equal(h.state.enabled, false);
  assert.equal((await h.request()).reason, "disabled");
});

test("a tab removed during detach is already cleaned up and does not disable other videos", async () => {
  const h = harness({ detachError: true, tabRemovedDuringCleanup: true });
  assert.equal((await h.request()).ok, true);
  assert.equal(h.calls.detach.length, 1);
  assert.equal(h.state.enabled, true);
  assert.equal(h.calls.writes.length, 0);
});

test("first ad reload saves its guard and playback position before rechecking the ad and navigating", async () => {
  const h = harness({ emitReloadLoading: true, afterSessionWrite: ({ calls }) => {
    assert.equal(calls.reloads.length, 0);
    assert.equal(calls.confirms.length, 1);
  } });
  const reply = await h.request({ type: "reload-ad", resumeTime: 123.5, tabId: 99 });
  assert.equal(reply.ok, true);
  assert.equal(reply.reloading, true);
  assert.deepEqual(h.calls.reloads, [7]);
  assert.equal(h.sessionData["ad-reload:7"].videoId, "video-a");
  assert.equal(h.sessionData["ad-reload:7"].sourceDocumentId, "document-a");
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, 123.5);
  assert.equal(h.sessionData["ad-reload:7"].resumeExpiresAt, h.state.now + 60000);
  assert.equal(h.calls.confirms.length, 2);
  assert.ok(h.calls.confirms.every(item => item.message.requireAd === true &&
    item.target.documentId === "document-a" && item.target.frameId === 0));
  assert.equal(h.calls.attach.length, 0);
  assert.equal(h.calls.commands.length, 0);
  assert.equal(h.calls.writes.length, 0);
});

test("reload count and retry interval survive worker restart and watch URL parameter changes", async () => {
  const sessionData = {};
  const first = harness({ sessionData });
  assert.equal((await first.request({ type: "reload-ad" })).reloading, true);
  const secondUrl = WATCH + "&t=23&list=playlist-a#details";
  const next = harness({ sessionData, state: { url: secondUrl } });
  const state = await next.request({ type: "ad-reload-state" }, { documentId: "document-b" });
  assert.equal(state.ok, true);
  assert.equal(state.reloaded, true);
  assert.equal(state.reloadCount, 1);
  assert.equal(state.retryAfterMs, 3000);
  const reply = await next.request({ type: "reload-ad" }, { documentId: "document-b" });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, "retry-later");
  assert.equal(reply.reloadCount, 1);
  assert.equal(reply.retryAfterMs, 3000);
  assert.equal(next.calls.reloads.length, 0);
  next.state.now += 3000;
  const second = await next.request({ type: "reload-ad" }, { documentId: "document-b" });
  assert.equal(second.reloading, true);
  assert.equal(second.reloadCount, 2);
  next.state.now += 1501;
  assert.equal((await next.request({}, { documentId: "document-b" })).ok, true);
  assert.equal(next.calls.attach.length, 1);
});

test("state delivers a resume position once per document and keeps it until a matching acknowledgement", async () => {
  const h = harness();
  assert.equal((await h.request({ type: "reload-ad", resumeTime: 42 })).reloading, true);
  const original = await h.request({ type: "ad-reload-state" });
  assert.equal(original.reloaded, true);
  assert.equal(original.resumeTime, undefined);
  const replies = await Promise.all([
    h.request({ type: "ad-reload-state" }, { documentId: "document-b" }),
    h.request({ type: "ad-reload-state" }, { documentId: "document-b" })
  ]);
  assert.equal(replies.filter(reply => reply.resumeTime === 42).length, 1);
  assert.ok(replies.every(reply => reply.ok && reply.reloaded));
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, 42);
  assert.equal(h.sessionData["ad-reload:7"].resumeDeliveredTo, "document-b");
  assert.equal((await h.request({ type: "ad-resume-complete" }, { documentId: "document-b" })).cleared, true);
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
  assert.equal(h.sessionData["ad-reload:7"].reloadCount, 1);
  const later = await h.request({ type: "ad-reload-state" }, { documentId: "manual-refresh" });
  assert.equal(later.resumeTime, undefined);
});

test("state lookups require the own top-frame document but work without current focus", async () => {
  const h = harness({ state: { enabled: false, active: false, focused: false } });
  const reply = await h.request({ type: "ad-reload-state" });
  assert.equal(reply.ok, true);
  assert.equal(reply.reloaded, false);
  assert.equal(reply.reloadCount, 0);
  assert.equal(reply.retryAfterMs, 0);
  assert.equal(h.calls.confirms.length, 0);
  for (const override of [{ id: "other" }, { frameId: 1 }, { documentId: "" },
    { documentLifecycle: "cached" }, { url: "https://evil.example/watch" }]) {
    assert.equal(await h.request({ type: "ad-reload-state" }, override), undefined);
    assert.equal(await h.request({ type: "reload-ad" }, override), undefined);
    assert.equal(await h.request({ type: "ad-resume-complete" }, override), undefined);
  }
  assert.ok(h.calls.sessionReads.every(key => key === "ad-reload:7"));
  assert.equal(h.calls.reloads.length, 0);
});

test("reload requests require one nonempty, bounded watch video ID", async () => {
  for (const url of ["https://www.youtube.com/watch", "https://www.youtube.com/watch?v=",
    WATCH + "&v=other", "https://www.youtube.com/watch?v=with%20space",
    "https://www.youtube.com/watch?v=" + "a".repeat(129),
    "https://www.youtube.com/shorts/video-a", "https://evil.example/watch?v=video-a"]) {
    const h = harness();
    assert.equal(await h.request({ type: "reload-ad", url }), undefined);
    assert.equal(await h.request({ type: "ad-reload-state", url }), undefined);
    assert.equal(await h.request({ type: "ad-resume-complete", url }), undefined);
    assert.equal(h.calls.sessionReads.length, 0);
    assert.equal(h.calls.reloads.length, 0);
  }
});

test("new videos receive a fresh retry budget without retaining a viewing history", async () => {
  const h = harness();
  assert.equal((await h.request({ type: "reload-ad", resumeTime: 50 })).reloading, true);
  h.state.url = "https://www.youtube.com/watch?v=video-b";
  h.state.now += 1501;
  const state = await h.request({ type: "ad-reload-state" });
  assert.equal(state.reloaded, false);
  assert.equal(state.resumeTime, undefined);
  assert.equal((await h.request({ type: "reload-ad" })).reloading, true);
  assert.equal(h.sessionData["ad-reload:7"].videoId, "video-b");
  assert.equal(h.sessionData["ad-reload:7"].reloadCount, 1);
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
  assert.deepEqual(Object.keys(h.sessionData), ["ad-reload:7"]);
  assert.equal(h.calls.reloads.length, 2);
});

test("storage read/write failures never reload, and unreadable state is reported explicitly", async () => {
  for (const option of ["sessionReadError", "sessionWriteError"]) {
    const h = harness({ [option]: true });
    const reply = await h.request({ type: "reload-ad" });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "reload-state-unavailable");
    assert.equal(h.calls.reloads.length, 0);
    assert.equal(h.calls.attach.length, 0);
  }
  const h = harness({ sessionReadError: true });
  assert.equal((await h.request({ type: "ad-reload-state" })).reason, "reload-state-unavailable");
});

test("failed resume delivery never returns a position or drops the reload counter", async () => {
  const sessionData = { "ad-reload:7": reloadRecord({ resumeTime: 72, resumeExpiresAt: 70000 }) };
  const h = harness({ sessionData, sessionWriteError: true });
  const reply = await h.request({ type: "ad-reload-state" }, { documentId: "document-b" });
  assert.equal(reply.ok, true);
  assert.equal(reply.reloaded, true);
  assert.equal(reply.resumeTime, undefined);
  assert.equal(h.sessionData["ad-reload:7"].videoId, "video-a");
});

test("disabled settings, background tabs, lost focus, absent ads, and stale documents never reload", async () => {
  for (const state of [{ enabled: false }, { active: false }, { focused: false },
    { adShowing: false }, { confirmation: false }, { tab: { url: WATCH + "&t=other" } }]) {
    const h = harness({ state });
    assert.equal((await h.request({ type: "reload-ad" })).ok, false);
    assert.equal(h.calls.reloads.length, 0);
    assert.equal(h.calls.sessionWrites.length, 0);
  }
  const h = harness({ confirmError: true });
  assert.equal((await h.request({ type: "reload-ad" })).ok, false);
  assert.equal(h.calls.reloads.length, 0);
});

test("settings, focus, document identity and ad state are rechecked after guard persistence", async () => {
  for (const changed of [{ enabled: false }, { active: false }, { focused: false },
    { adShowing: false }, { confirmation: false }, { url: WATCH + "&t=changed" }]) {
    const h = harness({ afterSessionWrite: ({ state }) => Object.assign(state, changed) });
    const reply = await h.request({ type: "reload-ad" });
    assert.equal(reply.ok, false);
    assert.equal(h.calls.reloads.length, 0);
    assert.equal(h.sessionData["ad-reload:7"].videoId, "video-a");
    assert.equal(h.calls.confirms.length, 2);
  }
});

test("concurrent reloads and skip requests share the same tab lock", async () => {
  const sessionWriteDeferred = deferred();
  const h = harness({ sessionWriteDeferred });
  const first = h.request({ type: "reload-ad" });
  await flush();
  assert.equal((await h.request({ type: "reload-ad" })).reason, "busy");
  assert.equal((await h.request()).reason, "busy");
  assert.equal(h.calls.sessionWrites.length, 1);
  sessionWriteDeferred.resolve();
  assert.equal((await first).reloading, true);
  assert.equal(h.calls.reloads.length, 1);
});

test("a tab closed while saving cannot reload or leave a session record behind", async () => {
  const sessionWriteDeferred = deferred();
  const h = harness({ sessionWriteDeferred });
  const first = h.request({ type: "reload-ad", resumeTime: 18 });
  await flush();
  h.events.removed.emit(7);
  sessionWriteDeferred.resolve();
  assert.equal((await first).ok, false);
  await flush();
  assert.equal(h.calls.reloads.length, 0);
  assert.equal(h.sessionData["ad-reload:7"], undefined);
  assert.deepEqual(h.calls.sessionRemoves, ["ad-reload:7"]);
});

test("invalid resume positions are omitted, and failed reloads consume the configured budget", async () => {
  for (const resumeTime of [undefined, null, 0, -1, NaN, Infinity, "23"]) {
    const h = harness();
    assert.equal((await h.request({ type: "reload-ad", resumeTime })).reloading, true);
    assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
  }
  const h = harness({ reloadError: true, state: { maxReloads: 1 } });
  assert.equal((await h.request({ type: "reload-ad" })).ok, false);
  assert.equal(h.sessionData["ad-reload:7"].videoId, "video-a");
  h.state.now += 3000;
  const next = await h.request({ type: "reload-ad" });
  assert.equal(next.reason, "reload-limit");
  assert.equal(next.reloadCount, 1);
  assert.equal(h.calls.reloads.length, 1);
});

test("a failed reload discards its resume payload while retaining the same-video guard", async () => {
  const h = harness({ reloadError: true });
  assert.equal((await h.request({ type: "reload-ad", resumeTime: 180 })).ok, false);
  assert.equal(h.sessionData["ad-reload:7"].videoId, "video-a");
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
  assert.equal(h.sessionData["ad-reload:7"].resumeExpiresAt, undefined);
  const later = await h.request({ type: "ad-reload-state" }, { documentId: "manual-refresh" });
  assert.equal(later.reloaded, true);
  assert.equal(later.resumeTime, undefined);
});

test("failed post-save verification clears playback restoration and retains the consumed attempt", async () => {
  for (const changed of [{ enabled: false }, { focused: false }, { adShowing: false }, { confirmation: false }]) {
    const h = harness({ afterSessionWrite: ({ state }) => Object.assign(state, changed) });
    assert.equal((await h.request({ type: "reload-ad", resumeTime: 180 })).ok, false);
    assert.equal(h.calls.reloads.length, 0);
    assert.equal(h.sessionData["ad-reload:7"].videoId, "video-a");
    assert.equal(h.sessionData["ad-reload:7"].reloadCount, 1);
    assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
    assert.equal(h.sessionData["ad-reload:7"].resumeExpiresAt, undefined);
  }
});

test("restoration expires at sixty seconds while the reload guard remains", async () => {
  for (const elapsed of [59999, 60000, 60001]) {
    const h = harness();
    assert.equal((await h.request({ type: "reload-ad", resumeTime: 180 })).reloading, true);
    h.state.now += elapsed;
    const reply = await h.request({ type: "ad-reload-state" }, { documentId: "document-b" });
    assert.equal(reply.reloaded, true);
    assert.equal(reply.resumeTime, elapsed < 60000 ? 180 : undefined);
    assert.equal(h.sessionData["ad-reload:7"].videoId, "video-a");
    assert.equal(h.sessionData["ad-reload:7"].resumeTime, elapsed < 60000 ? 180 : undefined);
    assert.equal(h.sessionData["ad-reload:7"].resumeExpiresAt, elapsed < 60000 ? 70000 : undefined);
  }
});

test("expired restoration is never returned even if failure cleanup and consumption writes both fail", async () => {
  const h = harness({ reloadError: true, sessionWriteError: ({ calls }) => calls.sessionWrites.length > 1 });
  assert.equal((await h.request({ type: "reload-ad", resumeTime: 180 })).ok, false);
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, 180);
  h.state.now += 60000;
  const reply = await h.request({ type: "ad-reload-state" }, { documentId: "manual-refresh" });
  assert.equal(reply.ok, true);
  assert.equal(reply.reloaded, true);
  assert.equal(reply.resumeTime, undefined);
  assert.equal(h.sessionData["ad-reload:7"].videoId, "video-a");
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, 180);
});

test("a position expiring during its consumption write is not returned", async () => {
  const sessionWriteDeferred = deferred();
  const sessionData = { "ad-reload:7": reloadRecord({ resumeTime: 180, resumeExpiresAt: 70000 }) };
  const h = harness({ sessionData, sessionWriteDeferred });
  const pending = h.request({ type: "ad-reload-state" }, { documentId: "document-b" });
  await flush();
  h.state.now = 70000;
  sessionWriteDeferred.resolve();
  const reply = await pending;
  assert.equal(reply.reloaded, true);
  assert.equal(reply.resumeTime, undefined);
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
});

test("resume payloads without a valid expiry are dropped rather than returned", async () => {
  for (const resumeExpiresAt of [undefined, null, NaN, Infinity, "70000"]) {
    const sessionData = { "ad-reload:7": reloadRecord({ resumeTime: 180, resumeExpiresAt }) };
    const h = harness({ sessionData });
    const reply = await h.request({ type: "ad-reload-state" }, { documentId: "document-b" });
    assert.equal(reply.reloaded, true);
    assert.equal(reply.resumeTime, undefined);
    assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
    assert.equal(h.sessionData["ad-reload:7"].resumeExpiresAt, undefined);
  }
});

test("the default budget allows three spaced reloads then falls back to the trusted skip", async () => {
  const h = harness();
  for (let count = 1; count <= 3; count++) {
    const reply = await h.request({ type: "reload-ad" }, { documentId: "document-" + count });
    assert.equal(reply.ok, true);
    assert.equal(reply.reloading, true);
    assert.equal(reply.reloadCount, count);
    const state = await h.request({ type: "ad-reload-state" }, { documentId: "after-" + count });
    assert.equal(state.reloadCount, count);
    assert.equal(state.retryAfterMs, 3000);
    h.state.now += 3000;
  }
  const blocked = await h.request({ type: "reload-ad" }, { documentId: "document-4" });
  assert.equal(blocked.reason, "reload-limit");
  assert.equal(blocked.reloadCount, 3);
  assert.equal(h.calls.reloads.length, 3);
  h.state.now += 1501;
  assert.equal((await h.request()).ok, true);
  assert.equal(h.calls.attach.length, 1);
});

test("saved limits of one and five determine the actual number of reload attempts", async () => {
  for (const maxReloads of [1, 5]) {
    const h = harness({ state: { maxReloads } });
    for (let count = 1; count <= maxReloads; count++) {
      const reply = await h.request({ type: "reload-ad" });
      assert.equal(reply.reloading, true);
      assert.equal(reply.reloadCount, count);
      h.state.now += 3000;
    }
    const reply = await h.request({ type: "reload-ad" });
    assert.equal(reply.reason, "reload-limit");
    assert.equal(reply.reloadCount, maxReloads);
    assert.equal(h.calls.reloads.length, maxReloads);
  }
});

test("invalid preference values default safely and numeric limits clamp to one through ten", async () => {
  for (const [configured, expected] of [[undefined, 3], ["5", 3], [NaN, 3], [Infinity, 3],
    [-2, 1], [0, 1], [2.9, 2], [20, 10]]) {
    const h = harness({ state: { maxReloads: configured } });
    for (let count = 1; count <= expected; count++) {
      assert.equal((await h.request({ type: "reload-ad" })).reloadCount, count);
      h.state.now += 3000;
    }
    assert.equal((await h.request({ type: "reload-ad" })).reason, "reload-limit");
    assert.equal(h.calls.reloads.length, expected);
  }
});

test("changing the saved limit affects the next attempt without resetting its count", async () => {
  const h = harness({ state: { maxReloads: 3 } });
  assert.equal((await h.request({ type: "reload-ad" })).reloadCount, 1);
  h.state.now += 3000;
  h.state.maxReloads = 1;
  assert.equal((await h.request({ type: "reload-ad" })).reason, "reload-limit");
  h.state.maxReloads = 5;
  for (let count = 2; count <= 5; count++) {
    const reply = await h.request({ type: "reload-ad" });
    assert.equal(reply.reloading, true);
    assert.equal(reply.reloadCount, count);
    h.state.now += 3000;
  }
  assert.equal((await h.request({ type: "reload-ad" })).reason, "reload-limit");
  assert.equal(h.calls.reloads.length, 5);
});

test("a lower limit saved during guard persistence prevents that reload and preserves the consumed count", async () => {
  const sessionData = { "ad-reload:7": reloadRecord({ lastReloadAt: 7000, sourceDocumentId: "previous" }) };
  const h = harness({ sessionData, state: { maxReloads: 3 },
    afterSessionWrite: ({ state }) => { state.maxReloads = 1; } });
  const reply = await h.request({ type: "reload-ad", resumeTime: 100 });
  assert.equal(reply.reason, "reload-limit");
  assert.equal(reply.reloadCount, 2);
  assert.equal(h.calls.reloads.length, 0);
  assert.equal(h.sessionData["ad-reload:7"].reloadCount, 2);
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
});

test("each retry waits at least three seconds and reports the remaining interval", async () => {
  const h = harness();
  assert.equal((await h.request({ type: "reload-ad" })).reloadCount, 1);
  for (const [elapsed, remaining] of [[0, 3000], [1, 2999], [1500, 1500], [2999, 1]]) {
    h.state.now = 10000 + elapsed;
    const reply = await h.request({ type: "reload-ad" });
    assert.equal(reply.reason, "retry-later");
    assert.equal(reply.retryAfterMs, remaining);
    assert.equal(reply.reloadCount, 1);
  }
  h.state.now = 13000;
  const reply = await h.request({ type: "reload-ad" });
  assert.equal(reply.reloading, true);
  assert.equal(reply.reloadCount, 2);
  assert.equal(h.calls.reloads.length, 2);
});

test("unreadable preferences never allow a reload or consume its session budget", async () => {
  const h = harness({ localReadError: true });
  assert.equal((await h.request({ type: "reload-ad" })).ok, false);
  assert.equal(h.calls.reloads.length, 0);
  assert.equal(h.calls.sessionWrites.length, 0);
  const state = await h.request({ type: "ad-reload-state" });
  assert.equal(state.reloadCount, 0);
});

test("failed browser reloads count toward the default three-attempt budget", async () => {
  const h = harness({ reloadError: true });
  for (let count = 1; count <= 3; count++) {
    const reply = await h.request({ type: "reload-ad" });
    assert.equal(reply.ok, false);
    assert.equal(reply.reloadCount, count);
    h.state.now += 3000;
  }
  assert.equal((await h.request({ type: "reload-ad" })).reason, "reload-limit");
  assert.equal(h.calls.reloads.length, 3);
});

test("the original position survives three ad documents and clears only after the current document restores it", async () => {
  const h = harness();
  assert.equal((await h.request({ type: "reload-ad", resumeTime: 200 })).reloading, true);
  h.state.now += 3000;
  assert.equal((await h.request({ type: "ad-reload-state" }, { documentId: "document-b" })).resumeTime, 200);
  for (const [doc, nextDoc, expectedCount] of [["document-b", "document-c", 2], ["document-c", "document-d", 3]]) {
    const state = await h.request({ type: "ad-reload-state" }, { documentId: doc });
    assert.equal(state.resumeTime, undefined);
    const next = await h.request({ type: "reload-ad" }, { documentId: doc });
    assert.equal(next.reloadCount, expectedCount);
    assert.equal(h.sessionData["ad-reload:7"].resumeTime, 200);
    assert.equal(h.sessionData["ad-reload:7"].resumeExpiresAt, h.state.now + 60000);
    assert.equal(h.sessionData["ad-reload:7"].resumeDeliveredTo, undefined);
    const delivered = await h.request({ type: "ad-reload-state" }, { documentId: nextDoc });
    assert.equal(delivered.resumeTime, 200);
    const lateAck = await h.request({ type: "ad-resume-complete" }, { documentId: doc });
    assert.equal(lateAck.cleared, false);
    assert.equal(h.sessionData["ad-reload:7"].resumeTime, 200);
    h.state.now += 3000;
  }
  assert.equal((await h.request({ type: "ad-resume-complete" }, { documentId: "document-d" })).cleared, true);
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, undefined);
  assert.equal(h.sessionData["ad-reload:7"].resumeExpiresAt, undefined);
  assert.equal(h.sessionData["ad-reload:7"].resumeDeliveredTo, undefined);
  assert.equal(h.sessionData["ad-reload:7"].reloadCount, 3);
});

test("a newer main-video position supersedes an inherited one and old-video acknowledgements cannot clear it", async () => {
  const h = harness();
  assert.equal((await h.request({ type: "reload-ad", resumeTime: 100 })).reloadCount, 1);
  await h.request({ type: "ad-reload-state" }, { documentId: "document-b" });
  h.state.now += 3000;
  assert.equal((await h.request({ type: "reload-ad", resumeTime: 220 }, { documentId: "document-b" })).reloadCount, 2);
  assert.equal((await h.request({ type: "ad-reload-state" }, { documentId: "document-c" })).resumeTime, 220);
  assert.equal((await h.request({ type: "ad-resume-complete" }, { documentId: "document-b" })).cleared, false);
  h.state.url = "https://www.youtube.com/watch?v=video-b";
  h.state.now += 3000;
  assert.equal((await h.request({ type: "reload-ad", resumeTime: 22 }, { documentId: "document-c" })).reloadCount, 1);
  await h.request({ type: "ad-reload-state" }, { documentId: "document-d" });
  const old = await h.request({ type: "ad-resume-complete", url: WATCH }, { documentId: "document-d" });
  assert.equal(old.cleared, false);
  assert.equal(h.sessionData["ad-reload:7"].resumeTime, 22);
});

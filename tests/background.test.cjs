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

function harness(options = {}) {
  const calls = { attach: [], detach: [], commands: [], confirms: [], writes: [] };
  const state = { enabled: true, active: true, focused: true, now: 10000, frameReads: 0, targetReads: 0,
    url: WATCH, loaderId: "loader-a", confirmation: true, ...options.state };
  const timers = new Map();
  let timerId = 0;
  const events = { message: event(), detach: event(), debugger: event(), storage: event(),
    updated: event(), activated: event(), removed: event(), focused: event() };
  const chrome = {
    runtime: { id: "own-extension", onMessage: events.message },
    storage: {
      local: {
        get: async () => ({ enabled: state.enabled }),
        set: async values => {
          calls.writes.push(values);
          const oldValue = state.enabled;
          state.enabled = values.enabled;
          events.storage.emit({ enabled: { oldValue, newValue: values.enabled } }, "local");
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
        return { ok: state.confirmation, url: state.url };
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
  return { calls, state, events, request, mouseEvents, timers };
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

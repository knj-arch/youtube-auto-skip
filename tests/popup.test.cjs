const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const success = (overrides = {}) => ({
  ok: true, version: "1.0.4", enabled: true, maxReloads: 3,
  page: { supported: true, active: true, windowFocused: true, loading: false, discarded: false, frozen: false },
  content: {
    connected: true, build: "1.0.4", supported: true, enabled: true, visibility: "visible", focused: true,
    players: 1, adPlayers: 1, skipButtons: 0, eligibleSkipButtons: 0,
    state: { ready: true, reloadCount: 0, refreshUnavailable: false, reloading: false, nextReloadMs: 0 },
    lastForeground: { ageMs: 500, adPlayers: 1, focused: true }
  },
  ...overrides
});

function harness(options = {}) {
  const elements = new Map(), messages = [], queries = [], clipboard = [], writes = [], timers = new Map();
  let nextTimer = 0;
  const document = { activeElement: null, getElementById: id => elements.get(id) };
  const tags = { enabled: "INPUT", state: "SPAN", "max-reloads": "INPUT", "reload-state": "SPAN",
    error: "P", version: "P", "diagnostic-check": "BUTTON", "diagnostic-copy": "BUTTON",
    "diagnostic-status": "P", "diagnostic-result": "DIV", "diagnostic-report": "TEXTAREA",
    "diagnostic-copy-status": "P" };
  for (const id of ["enabled", "state", "max-reloads", "reload-state", "error", "version", "diagnostic-check",
    "diagnostic-copy", "diagnostic-status", "diagnostic-result", "diagnostic-report", "diagnostic-copy-status"]) {
    if (options.missingElement === id) continue;
    const listeners = new Map(), attributes = new Map();
    const element = { id, tagName: options.wrongElement === id ? "DIV" : tags[id],
      textContent: "", value: "", checked: false, disabled: id === "diagnostic-copy",
      hidden: id === "diagnostic-result", dataset: {}, selected: false,
      setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
      getAttribute: key => attributes.get(key),
      addEventListener: (type, handler) => listeners.set(type, handler),
      emit: type => listeners.get(type)?.(),
      focus: () => { document.activeElement = element; }, select: () => { element.selected = true; }
    };
    elements.set(id, element);
  }
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "1.0.4" }),
      sendMessage: async message => {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (options.messageError) throw new Error("private-message-error");
        return options.reply ? options.reply(message) : success();
      }
    },
    tabs: { query: async query => {
      queries.push(JSON.parse(JSON.stringify(query)));
      if (options.queryError) throw new Error("private-query-error");
      return options.tabs ?? [{ id: 7, url: "https://private.example/secret-video", title: "private-title" }];
    } },
    storage: {
      local: { get: async () => ({ enabled: true, maxReloads: 3 }),
        set: async values => { writes.push(JSON.parse(JSON.stringify(values))); } },
      onChanged: { addListener() {} }
    }
  };
  const navigator = { userAgent: options.userAgent || "Mozilla/5.0 private-platform Chrome/154.0.8037.98 Safari/537.36" };
  if (!options.clipboardMissing) navigator.clipboard = { writeText: async value => {
    if (options.clipboardError) throw new Error("clipboard unavailable");
    clipboard.push(value);
  } };
  vm.runInNewContext(source, { chrome, document, navigator,
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  });
  return { elements, messages, queries, clipboard, writes, document,
    element: id => elements.get(id), report: () => JSON.parse(elements.get("diagnostic-report").value),
    check: () => elements.get("diagnostic-check").emit("click"),
    copy: () => elements.get("diagnostic-copy").emit("click"),
    expire: () => { for (const timer of [...timers.values()]) timer(); }
  };
}

test("fixed popup controls must exist with their expected element type", () => {
  assert.throws(() => harness({ missingElement: "enabled" }), /Required popup element/);
  assert.throws(() => harness({ wrongElement: "diagnostic-report" }), /Required popup element/);
});

test("diagnostics runs only on request and sends no reload or skip action", async () => {
  const h = harness();
  await flush();
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.queries, []);
  await h.check();
  assert.deepEqual(h.queries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(h.messages, [{ type: "automation-diagnostics", tabId: 7 }]);
  assert.equal(h.report().version, "1.0.4");
  assert.deepEqual(h.report().browser, { family: "Chrome", version: "154.0.8037.98" });
  assert.deepEqual(h.writes, []);
  assert.equal(h.element("diagnostic-copy").disabled, false);
});

test("no active tab produces a copyable report without contacting a content script", async () => {
  const h = harness({ tabs: [] });
  await h.check();
  assert.deepEqual(h.messages, []);
  assert.equal(h.report().reason, "no-active-tab");
  assert.match(h.element("diagnostic-status").textContent, /영상 탭을 열고/);
  assert.equal(h.element("diagnostic-copy").disabled, false);
});

test("unsupported pages are identified without triggering automation", async () => {
  const h = harness({ reply: () => success({ page: { supported: false },
    content: { connected: false, reason: "no-content-script" } }) });
  await h.check();
  assert.equal(h.element("diagnostic-status").textContent, "유튜브 영상 페이지에서 확인해 주세요.");
  assert.ok(h.messages.every(message => message.type === "automation-diagnostics"));
});

test("missing and timed-out content scripts recommend refreshing the video page", async () => {
  for (const reason of ["no-content-script", "timeout"]) {
    const h = harness({ reply: () => success({ content: { connected: false, reason } }) });
    await h.check();
    assert.equal(h.report().content.reason, reason);
    assert.match(h.element("diagnostic-status").textContent, /영상 페이지를 새로고침한 뒤/);
  }
});

test("opening the popup does not misdiagnose a lost document focus", async () => {
  for (const windowFocused of [true, false]) {
    const reply = success();
    reply.page.windowFocused = windowFocused;
    reply.content.focused = false;
    const h = harness({ reply: () => reply });
    await h.check();
    assert.equal(h.report().content.focused, false);
    assert.match(h.element("diagnostic-status").textContent, /광고 감지됨/);
  }
});

test("budget exhaustion and a recent action timeout are explained separately", async () => {
  const limited = success();
  limited.content.state.reloadCount = 3;
  const first = harness({ reply: () => limited });
  await first.check();
  assert.match(first.element("diagnostic-status").textContent, /새로고침 한도 도달/);
  const h = harness({ reply: () => success({ lastAction: {
    operation: "reload-ad", ok: false, reason: "timeout", ageMs: 100, elapsedMs: 2000
  } }) });
  await h.check();
  assert.match(h.element("diagnostic-status").textContent, /광고를 감지했지만 시간 초과/);
});

test("a normal video waits for ads instead of reporting an exhausted budget as a failure", async () => {
  const reply = success();
  reply.content.adPlayers = 0;
  reply.content.state.reloadCount = 3;
  const h = harness({ reply: () => reply });
  await h.check();
  assert.equal(h.element("diagnostic-status").textContent, "광고 감지 대기 중");
});

test("a loading flag does not hide a connected ad or a recent operation timeout", async () => {
  const connected = success();
  connected.page.loading = true;
  const h = harness({ reply: () => connected });
  await h.check();
  assert.match(h.element("diagnostic-status").textContent, /광고 감지됨/);
  assert.doesNotMatch(h.element("diagnostic-status").textContent, /불러오는 중/);

  for (const adPlayers of [0, 1]) {
    const reply = success({ lastAction: { operation: "reload-ad", ok: false, reason: "timeout", ageMs: 10 } });
    reply.page.loading = true;
    reply.content.adPlayers = adPlayers;
    const failed = harness({ reply: () => reply });
    await failed.check();
    assert.match(failed.element("diagnostic-status").textContent, /시간 초과/);
    assert.doesNotMatch(failed.element("diagnostic-status").textContent, /불러오는 중/);
  }
});

test("loading is supplementary only while waiting for a connection or a player", async () => {
  const reply = success();
  reply.page.loading = true;
  reply.content.players = 0;
  reply.content.adPlayers = 0;
  const h = harness({ reply: () => reply });
  await h.check();
  assert.match(h.element("diagnostic-status").textContent, /플레이어 연결 대기 중/);
  assert.match(h.element("diagnostic-status").textContent, /불러오는 중/);

  const missing = harness({ reply: () => success({ page: { supported: true, loading: true },
    content: { connected: false, reason: "no-content-script" } }) });
  await missing.check();
  assert.match(missing.element("diagnostic-status").textContent, /유튜브 연결 대기 중/);
});

test("an eligible skip after the budget recommends closing the popup", async () => {
  const reply = success();
  reply.page.loading = true;
  reply.content.focused = false;
  reply.content.state.reloadCount = 3;
  reply.content.eligibleSkipButtons = 1;
  const h = harness({ reply: () => reply });
  await h.check();
  assert.equal(h.element("diagnostic-status").textContent, "건너뛰기 버튼 감지됨 — 팝업을 닫으면 자동 처리돼요.");
});

test("an unavailable reload is reported even after its counter was read successfully", async () => {
  const reply = success();
  reply.content.state.refreshUnavailable = true;
  const h = harness({ reply: () => reply });
  await h.check();
  assert.match(h.element("diagnostic-status").textContent, /새로고침을 진행하지 못했어요/);
});

test("malformed replies and API failures produce bounded error reports", async () => {
  for (const reply of [null, [], { ok: "yes" }, { ok: true }]) {
    const h = harness({ reply: () => reply });
    await h.check();
    assert.equal(h.report().ok, false);
    assert.equal(h.report().reason, "invalid-response");
  }
  for (const option of ["queryError", "messageError"]) {
    const h = harness({ [option]: true });
    await h.check();
    assert.equal(h.report().reason, "unavailable");
    assert.doesNotMatch(h.element("diagnostic-report").value, /private-/);
  }
});

test("the report removes private fields and does not preserve arbitrary strings in known fields", async () => {
  const reply = success();
  reply.url = "https://private.example/secret";
  reply.title = "private-title";
  reply.page.videoId = "private-video-id";
  reply.content.url = reply.url;
  reply.content.build = "private-build";
  reply.content.players = "private-count";
  reply.content.lastResult = { operation: "private-operation", reason: "private-reason", ok: false,
    ageMs: -2, elapsedMs: Infinity, privateData: "private-data" };
  const h = harness({ reply: () => reply });
  await h.check();
  const report = h.report();
  assert.doesNotMatch(h.element("diagnostic-report").value, /private|https:|secret/);
  assert.equal(report.content.build, null);
  assert.equal(report.content.players, null);
  assert.equal(report.content.lastResult.reason, "unknown");
  assert.equal(report.content.lastResult.ageMs, null);
  assert.match(h.element("diagnostic-status").textContent, /상태 일부/);
});

test("the content diagnostic reason codes survive the report whitelist", async () => {
  for (const reason of ["ok", "no-response", "message-failed"]) {
    const reply = success();
    reply.content.lastResult = { operation: "ad-reload-state", reason, ok: reason === "ok", ageMs: 10 };
    const h = harness({ reply: () => reply });
    await h.check();
    assert.equal(h.report().content.lastResult.reason, reason);
    assert.equal(h.report().content.lastResult.operation, "ad-reload-state");
  }
});

test("the outer timeout unlocks the controls and late replies cannot overwrite its report", async () => {
  const waiting = deferred();
  const h = harness({ reply: () => waiting.promise });
  const request = h.check();
  await flush();
  assert.equal(h.element("diagnostic-check").disabled, true);
  await h.check();
  assert.equal(h.messages.length, 1);
  h.expire();
  await request;
  assert.equal(h.report().reason, "timeout");
  assert.equal(h.element("diagnostic-check").disabled, false);
  waiting.resolve(success());
  await flush();
  assert.equal(h.report().reason, "timeout");
});

test("copy writes the sanitized report rather than DOM edits and sends no new message", async () => {
  const h = harness();
  await h.check();
  const expected = h.element("diagnostic-report").value;
  h.element("diagnostic-report").value = "private DOM edit";
  await h.copy();
  assert.deepEqual(h.clipboard, [expected]);
  assert.equal(h.messages.length, 1);
  assert.equal(h.element("diagnostic-copy-status").textContent, "복사했어요.");
});

test("a blocked or unavailable clipboard selects the safe textarea for manual copying", async () => {
  for (const option of ["clipboardError", "clipboardMissing"]) {
    const h = harness({ [option]: true });
    await h.check();
    await h.copy();
    assert.equal(h.document.activeElement, h.element("diagnostic-report"));
    assert.equal(h.element("diagnostic-report").selected, true);
    assert.match(h.element("diagnostic-copy-status").textContent, /Ctrl\+C/);
    assert.equal(h.report().version, "1.0.4");
  }
});

test("browser reporting prefers the product token and omits the full user agent", async () => {
  const h = harness({ userAgent: "private-platform Chrome/154.0.0.0 Safari/537.36 Edg/154.0.2.3" });
  await h.check();
  assert.deepEqual(h.report().browser, { family: "Edge", version: "154.0.2.3" });
  assert.doesNotMatch(h.element("diagnostic-report").value, /private-platform|Safari/);
});

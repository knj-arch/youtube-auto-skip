"use strict";

// Optional performance harness: isolated Chromium, real MV3 extension, and
// locally fulfilled synthetic pages only. No real YouTube/ad requests, user
// profiles, desktop input, or OS clipboard access are used.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const projectRoot = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const option = (key, fallback) => {
  const index = argv.indexOf(key);
  return index === -1 ? fallback : argv[index + 1];
};
const extensionRoot = path.resolve(option("--extension", projectRoot));
const label = option("--label", "candidate");
const noiseOnly = argv.includes("--noise-only");
assert.match(label, /^[a-zA-Z0-9_-]+$/, "Label must be a simple artifact name");
const samples = Number(option("--samples", "24"));
assert.ok(Number.isInteger(samples) && samples >= 20 && samples <= 30, "Use 20 through 30 samples per condition");
const output = path.resolve(option("--output", path.join(projectRoot, "dist", `detection-benchmark-${label}.json`)));
assert.ok(output.startsWith(path.join(projectRoot, "dist") + path.sep), "Benchmark reports must stay under project dist");
const runtimeFiles = ["manifest.json", "content.js", "background.js", "popup.html", "popup.css", "popup.js",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function playwright() {
  if (process.env.PLAYWRIGHT_CORE_PATH) return require(process.env.PLAYWRIGHT_CORE_PATH);
  try { return require("playwright-core"); } catch {}
  return require(path.join(os.tmpdir(), "youtube-auto-skip-browser-fixture-deps", "node_modules", "playwright-core"));
}
function chromiumExecutable() {
  if (process.env.FIXTURE_CHROMIUM_PATH) return process.env.FIXTURE_CHROMIUM_PATH;
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1243", "chrome-win64", "chrome.exe");
  return undefined;
}
function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, hash(await fs.readFile(path.join(extensionRoot, file)))])));
}
function phases(count) {
  const indices = Array.from({ length: count }, (_, index) => index);
  let random = 0x5eed;
  for (let index = indices.length - 1; index > 0; index -= 1) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const other = random % (index + 1);
    [indices[index], indices[other]] = [indices[other], indices[index]];
  }
  return indices.map(index => Math.floor(index * 1000 / count));
}
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { n: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1),
    minMs: sorted[0], meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) };
}
async function until(check, description, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await sleep(10);
  }
  throw new Error(description + (last ? ": " + last.message : ""));
}
function html(kind, settled) {
  const player = kind !== "insert" || settled ? '<div id="initial-player" class="html5-video-player">Synthetic main player</div>' : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic detection benchmark</title>
  <style>body{margin:0;background:white}.html5-video-player{width:640px;height:360px;background:#222;color:#fff}</style>
  </head><body><main id="stage">${player}</main><script>window.__benchmarkFixture={settled:${settled}};</script></body></html>`;
}

(async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
  const result = { label, version: manifest.version, startedAt: new Date().toISOString(), extensionRoot, noiseOnly,
    syntheticLocalFixtures: true, realYouTubeAdTest: false, sampleCountPerCondition: samples,
    measurement: "DOM mutation Date.now() to real worker passive onMessage listener Date.now() for reload-ad",
    percentileMethod: "nearest rank", phaseOffsetsMs: phases(samples), warmWorker: true,
    notes: ["Same seeded offsets cover an entire 1000ms interval and are shuffled identically for all builds.",
      "Each sample uses a new tab and fixture video ID; no reload limits are reset in the timed path.",
      "The real tabs.reload runs; its local response is a non-ad page, naturally ending that sample.",
      "Polling reads stored worker timestamps after arrival; it does not supply the measured end time.",
      "The passive listener runs after the extension's own listener, so IPC and initial handler scheduling are included.",
      "Clock calibration uses Node round-trip bounds for page and worker Date.now; no clocks are changed."],
    sourceHashes: await sourceHashes(), clockCalibration: [], groups: {}, controls: {} };
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-detection-benchmark-"));
  let context;
  const save = () => fs.writeFile(output, JSON.stringify(result, null, 2));
  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    const { chromium } = playwright();
    context = await chromium.launchPersistentContext(profile, { executablePath: chromiumExecutable(), headless: true,
      viewport: { width: 1000, height: 720 }, args: ["--disable-extensions-except=" + extensionRoot, "--load-extension=" + extensionRoot] });
    result.browserVersion = context.browser().version();
    let worker = context.serviceWorkers().find(item => item.url().startsWith("chrome-extension://"));
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const actualWorker = await worker.evaluate(() => fetch(chrome.runtime.getURL("background.js")).then(response => response.text()));
    result.workerSourceMatched = hash(actualWorker) === result.sourceHashes["background.js"];
    assert.ok(result.workerSourceMatched, "Loaded worker does not match the selected source");
    await worker.evaluate(() => {
      self.__detectionBenchmarkMessages = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (["reload-ad", "skip-ad", "ad-reload-state"].includes(message.type)) {
          self.__detectionBenchmarkMessages.push({ at: Date.now(), type: message.type, url: message.url,
            tabId: sender.tab?.id, documentId: sender.documentId });
        }
      });
    });
    const definitions = new Map();
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.protocol === "chrome-extension:") return route.continue();
      if (url.origin !== "https://www.youtube.com" || url.pathname !== "/watch") return route.abort();
      const definition = definitions.get(url.searchParams.get("v"));
      if (!definition) return route.abort();
      definition.loads += 1;
      return route.fulfill({ contentType: "text/html", body: html(definition.kind, definition.loads > 1) });
    });
    const initialPages = context.pages();
    const spare = initialPages[0] || await context.newPage();
    for (const page of initialPages) if (page !== spare) await page.close();
    await spare.goto("about:blank");
    const getMessages = () => worker.evaluate(() => self.__detectionBenchmarkMessages);
    async function prepare(kind, id) {
      const definition = { kind, loads: 0 };
      definitions.set(id, definition);
      const page = await context.newPage();
      await page.goto("https://www.youtube.com/watch?v=" + id, { waitUntil: "load" });
      await page.bringToFront();
      const tabId = await worker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0].id));
      await until(() => worker.evaluate(id => chrome.tabs.get(id).then(tab => tab.status === "complete"), tabId),
        "Fixture tab did not finish initial loading");
      const status = await until(() => worker.evaluate(async id => {
        const status = await chrome.tabs.sendMessage(id, { type: "automation-content-status" }, { frameId: 0 }).catch(() => undefined);
        return status?.connected && status.enabled ? { at: Date.now(), status } : undefined;
      }, tabId), "Content script did not initialize");
      return { page, tabId, definition, status };
    }
    async function mutate(page, kind, targetAt, burst = false) {
      return page.evaluate(({ kind, targetAt, burst }) => new Promise(resolve => {
        setTimeout(() => {
          const at = Date.now(), stage = document.querySelector("#stage");
          if (kind === "existing") {
            const player = stage.querySelector(".html5-video-player");
            if (burst) for (let index = 0; index < 20; index += 1) player.classList.toggle("ad-showing");
            player.classList.add("ad-showing");
          } else {
            const player = document.createElement("div");
            player.className = "html5-video-player ad-showing";
            player.textContent = "Synthetic ad player";
            if (kind === "replace") stage.querySelector(".html5-video-player").replaceWith(player);
            else stage.append(player);
          }
          const player = stage.querySelector(".html5-video-player"), rect = player.getBoundingClientRect();
          resolve({ at, targetAt, latenessMs: at - targetAt, visible: document.visibilityState,
            focused: document.hasFocus(), playerVisible: rect.width > 0 && rect.height > 0 });
        }, Math.max(0, targetAt - Date.now()));
      }), { kind, targetAt, burst });
    }
    for (let index = 0; index < 3; index += 1) {
      const pageBefore = Date.now(), pageNow = await spare.evaluate(() => Date.now()), pageAfter = Date.now();
      const workerBefore = Date.now(), workerNow = await worker.evaluate(() => Date.now()), workerAfter = Date.now();
      result.clockCalibration.push({ page: { before: pageBefore, value: pageNow, after: pageAfter,
        offsetBoundsMs: [pageNow - pageAfter, pageNow - pageBefore] }, worker: { before: workerBefore, value: workerNow,
        after: workerAfter, offsetBoundsMs: [workerNow - workerAfter, workerNow - workerBefore] } });
    }
    for (const kind of noiseOnly ? [] : ["existing", "insert", "replace"]) {
      const raw = [];
      result.groups[kind] = { raw };
      for (let index = 0; index < samples; index += 1) {
        const id = `bench-${kind}-${index}`;
        const prepared = await prepare(kind, id);
        try {
          const phaseMs = result.phaseOffsetsMs[index];
          const targetAt = prepared.status.at + 250 + phaseMs;
          const tab = await worker.evaluate(id => chrome.tabs.get(id).then(tab => ({ active: tab.active,
            status: tab.status, discarded: tab.discarded, frozen: tab.frozen, windowId: tab.windowId })), prepared.tabId);
          const windowFocused = await worker.evaluate(id => chrome.windows.get(id).then(window => window.focused), tab.windowId);
          const marker = await mutate(prepared.page, kind, targetAt);
          assert.equal(marker.visible, "visible"); assert.equal(marker.focused, true); assert.equal(marker.playerVisible, true);
          assert.equal(tab.active, true); assert.equal(tab.status, "complete"); assert.equal(windowFocused, true);
          const message = await until(async () => (await getMessages()).find(item => item.tabId === prepared.tabId &&
            item.type === "reload-ad" && item.at >= marker.at), "Ad mutation did not reach worker", 3500);
          const latencyMs = message.at - marker.at;
          assert.ok(latencyMs >= 0 && latencyMs < 3500, "Unexpected cross-clock latency");
          await until(() => prepared.page.evaluate(() => window.__benchmarkFixture?.settled === true),
            "Real reload did not finish on the settled main fixture", 4500);
          await sleep(120);
          const requests = (await getMessages()).filter(item => item.tabId === prepared.tabId && item.type === "reload-ad");
          assert.equal(requests.length, 1, "Duplicate ad handling in a single sample");
          assert.equal(prepared.definition.loads, 2, "A sample did not reload exactly once");
          raw.push({ index, phaseMs, anchorAt: prepared.status.at, mutationAt: marker.at,
            scheduledAt: targetAt, schedulingLatenessMs: marker.latenessMs, workerReceivedAt: message.at,
            latencyMs, requestCount: requests.length, documentLoads: prepared.definition.loads,
            tab, windowFocused, page: { visible: marker.visible, focused: marker.focused, playerVisible: marker.playerVisible } });
        } finally { await prepared.page.close(); }
        if ((index + 1) % 8 === 0) console.log(JSON.stringify({ label, condition: kind, completed: index + 1,
          provisional: summarize(raw.map(sample => sample.latencyMs)) }));
      }
      result.groups[kind].summary = summarize(raw.map(sample => sample.latencyMs));
      console.log("GROUP " + JSON.stringify({ label, condition: kind, ...result.groups[kind].summary }));
      await save();
    }

    if (noiseOnly) {
      const id = "control-unrelated-noise", prepared = await prepare("existing", id);
      const session = await context.newCDPSession(prepared.page);
      const repeats = [];
      try {
        await session.send("Performance.enable");
        const metrics = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map(item => [item.name, item.value]));
        for (let repeat = 0; repeat < 3; repeat += 1) {
          const before = await metrics();
          const workload = await prepared.page.evaluate(async () => {
            const host = document.createElement("div");
            host.id = "unrelated-noise";
            document.body.append(host);
            const start = performance.now();
            for (let batch = 0; batch < 200; batch += 1) {
              const fragment = document.createDocumentFragment();
              for (let index = 0; index < 20; index += 1) {
                const element = document.createElement("span");
                element.textContent = "unrelated fixture node";
                fragment.append(element);
              }
              host.append(fragment);
              host.replaceChildren();
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            host.remove();
            return { wallMs: performance.now() - start, batches: 200, nodesPerBatch: 20 };
          });
          await sleep(50);
          const after = await metrics();
          const deltas = Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(name => [name + "Ms",
            Number.isFinite(before[name]) && Number.isFinite(after[name]) ? Number(((after[name] - before[name]) * 1000).toFixed(3)) : null]));
          repeats.push({ repeat, ...workload, ...deltas });
        }
        const requests = (await getMessages()).filter(item => item.tabId === prepared.tabId && ["reload-ad", "skip-ad"].includes(item.type));
        assert.equal(requests.length, 0, "Unrelated DOM noise triggered an ad action");
        assert.equal(prepared.definition.loads, 1);
        result.controls.unrelatedNoise = { repeats, reloadOrSkipRequests: 0, actualReloads: 0,
          notes: "CDP renderer duration deltas include fixture DOM work and extension observer callbacks; these are short synthetic workload comparisons, not isolated extension CPU profiles." };
      } finally { await session.detach(); await prepared.page.close(); }
    }
    if (!noiseOnly) {
    // Burst coalescing is checked outside the timed distributions.
    {
      const id = "control-burst", prepared = await prepare("existing", id);
      try {
        await mutate(prepared.page, "existing", Date.now() + 50, true);
        await until(() => prepared.page.evaluate(() => window.__benchmarkFixture?.settled === true), "Burst did not settle");
        await sleep(150);
        const requests = (await getMessages()).filter(item => item.tabId === prepared.tabId && item.type === "reload-ad");
        assert.equal(requests.length, 1); assert.equal(prepared.definition.loads, 2);
        result.controls.burst = { mutationCount: 21, reloadRequests: requests.length, actualReloads: prepared.definition.loads - 1 };
      } finally { await prepared.page.close(); }
    }
    {
      const id = "control-background", prepared = await prepare("existing", id);
      try {
        await spare.bringToFront();
        await until(() => worker.evaluate(id => chrome.tabs.get(id).then(tab => !tab.active), prepared.tabId), "Background control remained active");
        await sleep(100);
        const tab = await worker.evaluate(id => chrome.tabs.get(id).then(tab => ({ active: tab.active, status: tab.status })), prepared.tabId);
        const marker = await mutate(prepared.page, "existing", Date.now());
        await sleep(1250);
        const requests = (await getMessages()).filter(item => item.tabId === prepared.tabId && item.type === "reload-ad");
        assert.equal(prepared.definition.loads, 1, "Background control refreshed the document");
        result.controls.background = { tab, page: marker, reloadRequests: requests.length, actualReloads: 0 };
      } finally { await prepared.page.close(); }
    }
    await worker.evaluate(() => chrome.storage.local.set({ enabled: false }));
    {
      const id = "control-disabled", definition = { kind: "existing", loads: 0 };
      definitions.set(id, definition);
      const page = await context.newPage();
      try {
        await page.goto("https://www.youtube.com/watch?v=" + id, { waitUntil: "load" });
        await page.bringToFront(); await mutate(page, "existing", Date.now()); await sleep(1250);
        const requests = (await getMessages()).filter(item => item.url?.endsWith("v=" + id) && item.type === "reload-ad");
        assert.equal(requests.length, 0); assert.equal(definition.loads, 1);
        result.controls.disabled = { reloadRequests: requests.length, actualReloads: 0 };
      } finally { await page.close(); }
    }
    await worker.evaluate(() => chrome.storage.local.set({ enabled: true, maxReloads: 1 }));
    {
      const id = "control-budget", definition = { kind: "existing", loads: 0 };
      definitions.set(id, definition);
      const page = await context.newPage();
      try {
        await page.bringToFront();
        const tabId = await worker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0].id));
        await worker.evaluate(({ tabId, videoId }) => chrome.storage.session.set({ ["ad-reload:" + tabId]: {
          videoId, reloadCount: 1, lastReloadAt: Date.now() - 10000, sourceDocumentId: "benchmark-budget-precondition"
        } }), { tabId, videoId: id });
        await page.goto("https://www.youtube.com/watch?v=" + id, { waitUntil: "load" });
        await until(() => worker.evaluate(id => chrome.tabs.sendMessage(id, { type: "automation-content-status" }, { frameId: 0 })
          .then(status => status.state?.ready === true && status.state.reloadCount === 1).catch(() => false), tabId), "Budget guard did not initialize");
        await mutate(page, "existing", Date.now()); await sleep(1250);
        const requests = (await getMessages()).filter(item => item.tabId === tabId && item.type === "reload-ad");
        assert.equal(requests.length, 0); assert.equal(definition.loads, 1);
        result.controls.exhaustedBudget = { maxReloads: 1, persistedCount: 1, reloadRequests: requests.length, actualReloads: 0 };
      } finally { await page.close(); }
    }
    }
    result.finalSourceHashes = await sourceHashes();
    result.sourceUnchanged = JSON.stringify(result.sourceHashes) === JSON.stringify(result.finalSourceHashes);
    assert.ok(result.sourceUnchanged, "Selected source changed during benchmark");
    result.complete = true;
    result.finishedAt = new Date().toISOString();
    await save();
    console.log("RESULT " + JSON.stringify({ label, version: result.version, groups: Object.fromEntries(Object.entries(result.groups).map(([kind, group]) => [kind, group.summary])),
      controls: result.controls, sourceUnchanged: result.sourceUnchanged, output }));
  } catch (error) {
    result.complete = false; result.error = error.stack; result.finishedAt = new Date().toISOString(); await save(); throw error;
  } finally {
    if (context) await context.close();
    assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(profile).startsWith("youtube-detection-benchmark-"));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

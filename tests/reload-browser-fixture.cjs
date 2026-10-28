"use strict";

// Optional integration check: an isolated Chromium profile, the real MV3 worker,
// and locally fulfilled YouTube-shaped pages. No real YouTube request/ad is used.
// Set PLAYWRIGHT_CORE_PATH and FIXTURE_CHROMIUM_PATH for local installations.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || "playwright-core");

const extensionRoot = path.resolve(__dirname, "..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function silentWav(seconds = 10) {
  const samples = 8000 * seconds;
  const bytes = Buffer.alloc(44 + samples, 128);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36 + samples, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples, 40);
  return "data:audio/wav;base64," + bytes.toString("base64");
}
const media = silentWav();

function fixtureHtml({ ad, button, pendingImage }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Local ad-flow fixture</title>
    <style>body{margin:0;background:#fff}.html5-video-player{position:relative;width:640px;height:360px}
    video{width:640px;height:360px}button{position:absolute;right:20px;bottom:30px;width:140px;height:44px}</style>
    </head><body><div class="html5-video-player ${ad ? "ad-showing" : ""}">
    <video class="html5-main-video" preload="auto" src="${media}"></video>
    ${button ? '<button class="ytp-skip-ad-button">Skip ad</button>' : ""}</div>
    ${pendingImage ? '<img src="/fixture-pending.png" width="1" height="1">' : ""}
    <script>
      window.fixtureClicks=[];
      const button=document.querySelector('button');
      if(button)button.addEventListener('click',event=>{
        window.fixtureClicks.push({trusted:event.isTrusted});
        if(event.isTrusted){document.querySelector('.html5-video-player').classList.remove('ad-showing');}
      });
      window.fixtureReady=true;
    </script></body></html>`;
}

async function eventually(check, description, timeout = 7000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(description + (last ? ": " + last.message : ""));
}

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-reload-browser-fixture-"));
  let context;
  let checks = 0;
  const record = name => { checks += 1; console.log("PASS " + name); };
  const sourceHashes = {};
  for (const name of ["content.js", "background.js", "popup.js", "popup.html", "popup.css", "manifest.json"]) {
    sourceHashes[name] = crypto.createHash("sha256").update(await fs.readFile(path.join(extensionRoot, name))).digest("hex");
  }
  const expectedVersion = JSON.parse(await fs.readFile(path.join(extensionRoot, "manifest.json"), "utf8")).version;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.FIXTURE_CHROMIUM_PATH || undefined,
      headless: true,
      viewport: { width: 1000, height: 720 },
      args: [
        "--disable-extensions-except=" + extensionRoot,
        "--load-extension=" + extensionRoot,
        "--autoplay-policy=no-user-gesture-required"
      ]
    });
    let worker = context.serviceWorkers().find(item => item.url().startsWith("chrome-extension://"));
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
    assert.ok(worker.url().startsWith("chrome-extension://"), "Extension worker was not loaded");
    const workerSource = await worker.evaluate(() => fetch(chrome.runtime.getURL("background.js")).then(response => response.text()));
    assert.equal(crypto.createHash("sha256").update(workerSource).digest("hex"), sourceHashes["background.js"]);
    const popupUrl = new URL("popup.html", worker.url()).href;
    await worker.evaluate(() => {
      self.fixtureMessages = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        self.fixtureMessages.push({ at: Date.now(), type: message.type, url: message.url, resumeTime: message.resumeTime,
          tabId: sender.tab?.id, documentId: sender.documentId });
      });
      return chrome.storage.local.set({ enabled: true });
    });
    let scenario = { startMain: false, firstButton: false, reloadsBeforeButton: 3, pendingImage: false,
      loads: new Map(), loadTimes: new Map() };
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.protocol === "chrome-extension:") return route.continue();
      if (url.origin !== "https://www.youtube.com") return route.abort();
      // Leave this locally intercepted request unresolved. DOMContentLoaded
      // completes, but Chrome's real tab.status remains "loading".
      if (url.pathname === "/fixture-pending.png") return;
      const id = url.searchParams.get("v") || url.pathname;
      const count = (scenario.loads.get(id) || 0) + 1;
      scenario.loads.set(id, count);
      const times = scenario.loadTimes.get(id) || [];
      times.push(Date.now());
      scenario.loadTimes.set(id, times);
      return route.fulfill({ contentType: "text/html", body: fixtureHtml({
        ad: !(scenario.startMain && count === 1),
        button: scenario.firstButton || count > scenario.reloadsBeforeButton,
        pendingImage: scenario.pendingImage
      }) });
    });
    const messages = () => worker.evaluate(() => self.fixtureMessages || []);
    const reset = async options => {
      for (const page of context.pages()) await page.close();
      scenario = { startMain: false, firstButton: false, reloadsBeforeButton: 3, pendingImage: false,
        loads: new Map(), loadTimes: new Map(), ...options };
      await worker.evaluate(() => { self.fixtureMessages = []; });
      return context.newPage();
    };
    const go = async (page, suffix) => {
      await page.goto("https://www.youtube.com/" + suffix, { waitUntil: "domcontentloaded" })
        .catch(error => { if (!/interrupted|ERR_ABORTED/.test(error.message)) throw error; });
      await page.bringToFront();
      await eventually(() => page.evaluate(() => window.fixtureReady), "Fixture did not load");
    };
    const openPopup = async () => {
      const popup = await context.newPage();
      await popup.goto(popupUrl);
      await popup.locator("#max-reloads").waitFor();
      await eventually(() => popup.locator("#max-reloads").isEnabled(), "Popup settings did not initialize");
      return popup;
    };
    const savedLimit = () => worker.evaluate(() => chrome.storage.local.get("maxReloads").then(values => values.maxReloads));
    const setLimitThroughPopup = async limit => {
      let popup = await openPopup();
      await popup.locator("#max-reloads").fill(String(limit));
      await popup.locator("#max-reloads").press("Tab");
      await eventually(async () => (await savedLimit()) === limit, "Popup did not persist limit " + limit);
      await popup.close();
      popup = await openPopup();
      assert.equal(await popup.locator("#max-reloads").inputValue(), String(limit));
      await popup.close();
    };
    const assertReloadSpacing = id => {
      const times = (scenario.loadTimes.get(id) || []).slice(1);
      // Observe full document requests; allow 50ms for request-dispatch timing.
      for (let index = 1; index < times.length; index += 1) {
        assert.ok(times[index] - times[index - 1] >= 2950,
          "Automatic reload interval was shorter than the 3-second policy");
      }
    };
    const waitForSkip = async (page, id, limit) => {
      await eventually(() => Promise.resolve(scenario.loads.get(id) >= limit + 1),
        "Ad did not reach its configured reload limit", limit * 4000 + 5000);
      await eventually(() => page.evaluate(() => window.fixtureClicks?.some(item => item.trusted)),
        "Remaining ad was not skipped using trusted input", 7000);
      assert.equal(scenario.loads.get(id), limit + 1);
      assertReloadSpacing(id);
    };
    const currentOnlyTabId = async () => {
      const ids = await worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id)));
      assert.equal(ids.length, 1, "Failure injection requires exactly one isolated test tab");
      return ids[0];
    };
    const injectFirstSessionReadFailure = async tabId => worker.evaluate(id => {
      if (self.fixtureRestoreSessionGet) self.fixtureRestoreSessionGet();
      const original = chrome.storage.session.get;
      const key = "ad-reload:" + id;
      self.fixtureSessionReadFault = { key, failures: 0, failedAt: undefined, restored: false };
      self.fixtureRestoreSessionGet = () => {
        chrome.storage.session.get = original;
        self.fixtureSessionReadFault.restored = true;
        delete self.fixtureRestoreSessionGet;
      };
      chrome.storage.session.get = function (keys, ...args) {
        if (keys === key) {
          self.fixtureSessionReadFault.failures += 1;
          self.fixtureSessionReadFault.failedAt = Date.now();
          self.fixtureRestoreSessionGet();
          return Promise.reject(new Error("Synthetic one-time session storage read failure"));
        }
        return original.call(chrome.storage.session, keys, ...args);
      };
      if (chrome.storage.session.get === original) throw new Error("Session failure injection was not installed");
    }, tabId);
    const restoreSessionRead = async () => worker.evaluate(() => {
      if (self.fixtureRestoreSessionGet) self.fixtureRestoreSessionGet();
      return self.fixtureSessionReadFault;
    });
    const waitForStateRetry = async id => {
      await eventually(async () => (await messages()).filter(item =>
        item.type === "ad-reload-state" && item.url.includes("v=" + id)).length >= 2,
      "Content script did not retry its transient initial state lookup", 8000);
      const requests = (await messages()).filter(item => item.type === "ad-reload-state" &&
        item.url.includes("v=" + id));
      assert.ok(requests[1].at - requests[0].at >= 2950,
        "Initial state lookup was retried before its 3-second recovery delay");
    };
    const injectDelayedCalls = async (tabId, videoId, confirmationMs, writeMs) => worker.evaluate(options => {
      const originalSend = chrome.tabs.sendMessage;
      const originalSet = chrome.storage.session.set;
      const key = "ad-reload:" + options.tabId;
      self.fixtureDelay = { confirmation: {}, write: {}, options };
      const delayed = (value, duration, record) => new Promise(resolve => {
        setTimeout(() => { record.resolvedAt = Date.now(); resolve(value); }, duration);
      });
      chrome.tabs.sendMessage = function (...args) {
        if (options.confirmationMs && args[0] === options.tabId &&
            args[1]?.type === "confirm-skip-document" && args[1].requireAd === true) {
          chrome.tabs.sendMessage = originalSend;
          const entry = self.fixtureDelay.confirmation;
          entry.startedAt = Date.now();
          return Promise.resolve(originalSend.apply(this, args)).then(value => {
            entry.originalResolvedAt = Date.now();
            return delayed(value, options.confirmationMs, entry);
          });
        }
        return originalSend.apply(this, args);
      };
      chrome.storage.session.set = function (...args) {
        if (options.writeMs && args[0]?.[key]?.videoId === options.videoId) {
          chrome.storage.session.set = originalSet;
          const entry = self.fixtureDelay.write;
          entry.startedAt = Date.now();
          return Promise.resolve(originalSet.apply(this, args)).then(value => {
            entry.committedAt = Date.now();
            return delayed(value, options.writeMs, entry);
          });
        }
        return originalSet.apply(this, args);
      };
      self.fixtureRestoreDelay = () => {
        chrome.tabs.sendMessage = originalSend;
        chrome.storage.session.set = originalSet;
        delete self.fixtureRestoreDelay;
      };
    }, { tabId, videoId, confirmationMs, writeMs });
    const restoreDelayedCalls = async () => worker.evaluate(() => {
      if (self.fixtureRestoreDelay) self.fixtureRestoreDelay();
      return self.fixtureDelay;
    });
    const contentStatus = tabId => worker.evaluate(id => chrome.tabs.sendMessage(id,
      { type: "automation-content-status" }, { frameId: 0 }), tabId);
    const prepareCssSkip = async id => {
      const cssPage = await reset({ reloadsBeforeButton: 99 });
      await setLimitThroughPopup(1);
      await go(cssPage, "watch?v=" + id);
      await eventually(() => Promise.resolve(scenario.loads.get(id) === 2),
        "CSS fixture did not naturally consume its single reload");
      const cssTabId = await currentOnlyTabId();
      await eventually(async () => {
        const status = await contentStatus(cssTabId);
        return status.state?.ready === true && status.state.reloadCount === 1;
      }, "CSS fixture did not initialize its persisted exhausted budget");
      const reloadRequest = (await messages()).filter(item => item.type === "reload-ad" &&
        item.url.includes("v=" + id)).at(-1);
      assert.ok(reloadRequest, "CSS fixture did not observe its natural reload request");
      // The worker intentionally shares its 1.5-second skip cooldown with the
      // preceding reload attempt. Measure CSS detection only after it expires.
      await sleep(Math.max(0, reloadRequest.at + 1600 - Date.now()));
      assert.equal(await cssPage.evaluate(() => window.fixtureClicks.length), 0);
      assert.equal((await messages()).filter(item => item.type === "skip-ad").length, 0);
      await cssPage.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = `
          .fixture-effect-skip { opacity: 0; transition: opacity 300ms linear; }
          .fixture-effect-skip.fixture-transition-visible { opacity: 1; }
          @keyframes fixture-skip-appear { from { opacity: 0; } to { opacity: 1; } }
          .fixture-effect-skip.fixture-animation-visible { animation: fixture-skip-appear 300ms linear forwards; }
          @keyframes fixture-progress-move { from { transform: scaleX(.1); } to { transform: scaleX(.9); } }
          .fixture-progress { width: 100px; height: 4px; pointer-events: none;
            animation: fixture-progress-move 200ms linear infinite; }
        `;
        document.head.append(style);
        const button = document.createElement("button");
        button.className = "ytp-skip-ad-button fixture-effect-skip";
        button.textContent = "Skip ad";
        window.fixtureCssEvents = [];
        for (const type of ["transitionstart", "transitionend", "animationstart", "animationend"]) {
          document.addEventListener(type, event => {
            if (event.target === button) window.fixtureCssEvents.push({
              type: event.type, trusted: event.isTrusted, at: performance.now()
            });
          }, true);
        }
        button.addEventListener("click", event => {
          window.fixtureClicks.push({ trusted: event.isTrusted, at: performance.now(),
            opacity: Number(getComputedStyle(button).opacity) });
          if (event.isTrusted) document.querySelector(".html5-video-player").classList.remove("ad-showing");
        });
        document.querySelector(".html5-video-player").append(button);
        window.fixtureInitialOpacity = Number(getComputedStyle(button).opacity);
      });
      assert.equal(await cssPage.evaluate(() => window.fixtureInitialOpacity), 0);
      return { page: cssPage, tabId: cssTabId, id };
    };
    const waitForFreshForegroundScan = async tabId => {
      // Start just after an observed scan, so the one-second backup cannot
      // accidentally satisfy the sub-700ms event-driven regression assertion.
      await eventually(async () => {
        const status = await contentStatus(tabId);
        return status.lastForeground?.focused === true && status.lastForeground.ageMs < 120;
      }, "Could not align CSS activation after a foreground scan", 3000);
    };
    const revealCssSkip = async (fixture, effect) => {
      await waitForFreshForegroundScan(fixture.tabId);
      const activation = await fixture.page.evaluate(async kind => {
        const button = document.querySelector(".fixture-effect-skip");
        // Commit the hidden style before changing it. The first mutation scan
        // must see opacity 0; only a real CSS lifecycle event can follow it.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.fixtureEffectStartedAt = performance.now();
        button.classList.add(kind === "transition" ? "fixture-transition-visible" : "fixture-animation-visible");
        return { at: window.fixtureEffectStartedAt, opacity: Number(getComputedStyle(button).opacity) };
      }, effect);
      assert.equal(activation.opacity, 0, "CSS activation did not start from opacity zero");
      await eventually(() => fixture.page.evaluate(() => window.fixtureClicks.some(item => item.trusted)),
        "CSS-visible skip button was not clicked using trusted input", 1800);
      const result = await fixture.page.evaluate(() => ({ clicks: window.fixtureClicks, events: window.fixtureCssEvents }));
      const click = result.clicks.find(item => item.trusted);
      assert.ok(click.at - activation.at < 700,
        `${effect} skip waited ${Math.round(click.at - activation.at)}ms; expected detection before the 1-second backup`);
      assert.ok(click.opacity > 0 && click.opacity <= 1);
      assert.ok(result.events.some(event => event.type === effect + "start" && event.trusted),
        "A browser-generated CSS start event was not observed");
      assert.equal(scenario.loads.get(fixture.id), 2, "CSS detection exceeded its naturally exhausted reload budget");
      return result;
    };

    let popup = await openPopup();
    await eventually(async () => (await popup.locator("#version").textContent()).includes(expectedVersion),
      "Popup did not display the current extension version");
    await popup.setViewportSize({ width: 352, height: 600 });
    const popupLayout = await popup.evaluate(() => ({
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      versionBottom: document.querySelector("#version").getBoundingClientRect().bottom,
      updateHintBottom: document.querySelector(".update-hint").getBoundingClientRect().bottom
    }));
    await fs.mkdir(path.join(extensionRoot, "dist"), { recursive: true });
    await popup.screenshot({ path: path.join(extensionRoot, "dist", `popup-${expectedVersion}.png`) });
    console.log("POPUP_LAYOUT " + JSON.stringify(popupLayout));
    assert.equal(await popup.locator("#max-reloads").inputValue(), "3");
    assert.equal(await popup.locator("#max-reloads").getAttribute("min"), "1");
    assert.equal(await popup.locator("#max-reloads").getAttribute("max"), "10");
    assert.equal(await savedLimit(), undefined);
    await popup.close();
    record(`popup shows version ${expectedVersion}, the default limit of 3 and the supported range 1 through 10`);

    let page = await reset();
    await go(page, "watch?v=fixture-default");
    await waitForSkip(page, "fixture-default", 3);
    record("buttonless ads trigger the default 3 spaced reloads, then a real trusted skip");

    await page.evaluate(() => {
      history.replaceState({}, "", "/watch?v=fixture-default&t=8&list=fixture");
      document.querySelector(".html5-video-player").classList.add("ad-showing");
    });
    await eventually(() => page.evaluate(() => window.fixtureClicks?.filter(item => item.trusted).length >= 2),
      "Same video with changed query parameters did not use skip fallback");
    assert.equal(scenario.loads.get("fixture-default"), 4);
    record("query changes on the same video do not reset its exhausted reload budget");

    page = await reset({ reloadsBeforeButton: 1 });
    await setLimitThroughPopup(1);
    await go(page, "watch?v=fixture-one");
    await waitForSkip(page, "fixture-one", 1);
    record("popup saves and reopens limit 1, and the real worker reloads exactly once");

    let cssFixture = await prepareCssSkip("fixture-css-transition");
    await revealCssSkip(cssFixture, "transition");
    record("a real 300ms opacity transition triggers trusted skip before the one-second backup");

    cssFixture = await prepareCssSkip("fixture-css-animation");
    await cssFixture.page.evaluate(() => {
      const progress = document.createElement("div");
      progress.className = "fixture-progress";
      document.querySelector(".html5-video-player").append(progress);
    });
    await sleep(1250);
    assert.equal(await cssFixture.page.evaluate(() => window.fixtureClicks.length), 0);
    assert.equal((await messages()).filter(item => item.type === "skip-ad").length, 0);
    assert.equal(scenario.loads.get(cssFixture.id), 2);
    record("unrelated progress animation never clicks an opacity-zero skip button");
    await revealCssSkip(cssFixture, "animation");
    record("a real CSS opacity animation triggers trusted skip before the one-second backup");

    page = await reset({ reloadsBeforeButton: 5 });
    await setLimitThroughPopup(5);
    await go(page, "watch?v=fixture-five");
    await waitForSkip(page, "fixture-five", 5);
    record("popup saves and reopens limit 5, and the real worker reloads exactly five times");

    popup = await openPopup();
    for (const invalid of ["0", "11", "2.5", ""]) {
      await popup.locator("#max-reloads").fill("5");
      await popup.locator("#max-reloads").press("Tab");
      await eventually(async () => await popup.locator("#max-reloads").getAttribute("aria-invalid") !== "true",
        "A corrected valid limit did not clear its accessible error");
      await popup.locator("#max-reloads").fill(invalid);
      await popup.locator("#max-reloads").press("Tab");
      await eventually(async () => await popup.locator("#max-reloads").getAttribute("aria-invalid") === "true",
        "Invalid limit did not receive an accessible error");
      assert.equal(await savedLimit(), 5);
    }
    await popup.close();
    record("popup rejects empty, fractional, and out-of-range limits without changing saved settings");

    page = await reset({ startMain: true });
    await setLimitThroughPopup(3);
    await go(page, "watch?v=fixture-resume");
    await page.waitForFunction(() => document.querySelector("video").readyState >= 1);
    await page.evaluate(() => {
      const video = document.querySelector("video");
      video.currentTime = 3;
      video.dispatchEvent(new Event("timeupdate"));
    });
    await sleep(250);
    await page.evaluate(() => {
      document.querySelector(".html5-video-player").classList.add("ad-showing");
      const video = document.querySelector("video");
      video.currentTime = 0;
      video.dispatchEvent(new Event("timeupdate"));
    });
    for (const count of [2, 3]) {
      await eventually(() => Promise.resolve(scenario.loads.get("fixture-resume") >= count),
        "Midroll did not reach reload document " + count, 12000);
      const records = await worker.evaluate(() => chrome.storage.session.get(null));
      const resumeRecord = Object.values(records).find(item => item?.videoId === "fixture-resume");
      assert.equal(resumeRecord?.resumeTime, 3, "An intermediate ad reload lost the original main-video position");
    }
    await waitForSkip(page, "fixture-resume", 3);
    await eventually(() => page.evaluate(() => Math.abs(document.querySelector("video").currentTime - 3) < 0.1),
      "Main playback position was not restored after repeated reloads");
    await eventually(async () => (await messages()).some(item => item.type === "ad-resume-complete"),
      "Successful playback restoration was not acknowledged");
    await eventually(async () => {
      const records = await worker.evaluate(() => chrome.storage.session.get(null));
      const item = Object.values(records).find(value => value?.videoId === "fixture-resume");
      return item && item.resumeTime === undefined;
    }, "Restored playback position was not cleared from session storage");
    assert.equal((await messages()).find(item => item.type === "reload-ad").resumeTime, 3);
    assert.equal(scenario.loads.get("fixture-resume"), 4);
    record("three midroll reloads preserve the original main time, restore it, and clear only the resume payload");

    page = await reset({ reloadsBeforeButton: 1 });
    await setLimitThroughPopup(1);
    let tabId = await currentOnlyTabId();
    await injectFirstSessionReadFailure(tabId);
    try {
      await go(page, "watch?v=fixture-state-recovery");
      await eventually(() => worker.evaluate(() => self.fixtureSessionReadFault?.failures === 1),
        "Initial state read did not receive the injected failure");
      await sleep(500);
      assert.equal(scenario.loads.get("fixture-state-recovery"), 1);
      await waitForStateRetry("fixture-state-recovery");
      await waitForSkip(page, "fixture-state-recovery", 1);
      const fault = await restoreSessionRead();
      assert.equal(fault.failures, 1);
      assert.equal(fault.restored, true);
    } finally {
      await restoreSessionRead();
    }
    record("a transient first state-read failure recovers after 3 seconds and resumes guarded reloads");

    page = await reset({ reloadsBeforeButton: 99 });
    await setLimitThroughPopup(3);
    tabId = await currentOnlyTabId();
    await worker.evaluate(id => chrome.storage.session.set({ ["ad-reload:" + id]: {
      videoId: "fixture-persisted-limit", reloadCount: 3, lastReloadAt: Date.now() - 10000,
      sourceDocumentId: "fixture-previous-document"
    } }), tabId);
    await injectFirstSessionReadFailure(tabId);
    try {
      await go(page, "watch?v=fixture-persisted-limit");
      await eventually(() => worker.evaluate(() => self.fixtureSessionReadFault?.failures === 1),
        "Persisted-limit state lookup did not receive its initial failure");
      await waitForStateRetry("fixture-persisted-limit");
      assert.equal(scenario.loads.get("fixture-persisted-limit"), 1);
      const records = await worker.evaluate(() => chrome.storage.session.get(null));
      assert.equal(records["ad-reload:" + tabId].reloadCount, 3);
      await page.evaluate(() => {
        const button = document.createElement("button");
        button.className = "ytp-skip-ad-button";
        button.textContent = "Skip ad";
        button.addEventListener("click", event => {
          window.fixtureClicks.push({ trusted: event.isTrusted });
          if (event.isTrusted) document.querySelector(".html5-video-player").classList.remove("ad-showing");
        });
        document.querySelector(".html5-video-player").append(button);
      });
      await eventually(() => page.evaluate(() => window.fixtureClicks.some(item => item.trusted)),
        "Recovered exhausted budget did not use trusted skip fallback");
      assert.equal(scenario.loads.get("fixture-persisted-limit"), 1);
      assert.equal((await messages()).filter(item => item.type === "reload-ad").length, 0);
    } finally {
      await restoreSessionRead();
    }
    record("state recovery preserves an exhausted persisted budget and skips without another reload");

    page = await reset({ reloadsBeforeButton: 1, pendingImage: true });
    await setLimitThroughPopup(1);
    tabId = await currentOnlyTabId();
    await worker.evaluate(id => {
      const original = chrome.tabs.get;
      self.fixtureLoadingChecks = [];
      chrome.tabs.get = function (...args) {
        return original.apply(this, args).then(tab => {
          if (args[0] === id) self.fixtureLoadingChecks.push({ at: Date.now(), active: tab.active, status: tab.status });
          return tab;
        });
      };
      self.fixtureRestoreTabGet = () => { chrome.tabs.get = original; delete self.fixtureRestoreTabGet; };
    }, tabId);
    try {
      await go(page, "watch?v=fixture-loading");
      await waitForSkip(page, "fixture-loading", 1);
      const tab = await worker.evaluate(id => chrome.tabs.get(id), tabId);
      assert.equal(tab.status, "loading");
      assert.ok(await worker.evaluate(() => self.fixtureLoadingChecks.some(item => item.active && item.status === "loading")));
      assert.equal(scenario.loads.get("fixture-loading"), 2);
    } finally {
      await worker.evaluate(() => { if (self.fixtureRestoreTabGet) self.fixtureRestoreTabGet(); });
    }
    record("a real Chrome tab kept loading by an unresolved image still reloads and skips a confirmed ad");

    page = await reset({ reloadsBeforeButton: 1 });
    await setLimitThroughPopup(1);
    tabId = await currentOnlyTabId();
    await injectDelayedCalls(tabId, "fixture-slow-apis", 2500, 2500);
    try {
      await go(page, "watch?v=fixture-slow-apis");
      await waitForSkip(page, "fixture-slow-apis", 1);
      const delay = await restoreDelayedCalls();
      assert.ok(delay.confirmation.resolvedAt - delay.confirmation.originalResolvedAt >= 2490);
      assert.ok(delay.write.resolvedAt - delay.write.committedAt >= 2490);
      assert.ok(delay.write.resolvedAt - delay.confirmation.startedAt >= 4990);
      assert.equal(scenario.loads.get("fixture-slow-apis"), 2);
    } finally {
      await restoreDelayedCalls();
    }
    record("2.5-second confirmation plus 2.5-second guard acknowledgment delay remains within the reload deadline");

    page = await reset({ reloadsBeforeButton: 1 });
    await setLimitThroughPopup(1);
    tabId = await currentOnlyTabId();
    await injectDelayedCalls(tabId, "fixture-refund", 0, 2500);
    try {
      await go(page, "watch?v=fixture-refund");
      await eventually(() => worker.evaluate(() => Boolean(self.fixtureDelay.write.committedAt)),
        "Guard reservation was not committed before cancellation");
      await page.evaluate(() => document.querySelector(".html5-video-player").classList.remove("ad-showing"));
      await eventually(async () => {
        const records = await worker.evaluate(() => chrome.storage.session.get(null));
        const status = await contentStatus(tabId);
        const completed = status.lastResult?.operation === "reload-ad" && status.lastResult.ok === false;
        return completed && !records["ad-reload:" + tabId];
      }, "Cancelled undispatched reload did not refund its committed reservation", 7000);
      assert.equal(scenario.loads.get("fixture-refund"), 1);
      await page.evaluate(() => document.querySelector(".html5-video-player").classList.add("ad-showing"));
      await waitForSkip(page, "fixture-refund", 1);
      const records = await worker.evaluate(() => chrome.storage.session.get(null));
      assert.equal(records["ad-reload:" + tabId].reloadCount, 1);
      assert.equal(scenario.loads.get("fixture-refund"), 2);
    } finally {
      await restoreDelayedCalls();
    }
    record("an undispatched cancellation refunds its budget and the next ad reloads automatically without toggling");

    await worker.evaluate(() => chrome.storage.local.set({ enabled: false }));
    page = await reset({ firstButton: true });
    await go(page, "watch?v=fixture-disabled");
    await sleep(1300);
    assert.equal(scenario.loads.get("fixture-disabled"), 1);
    assert.equal((await messages()).filter(item => ["reload-ad", "skip-ad"].includes(item.type)).length, 0);
    record("disabled setting prevents refresh and skip");

    const sessionBeforeDiagnosis = await worker.evaluate(() => chrome.storage.session.get(null));
    const actionsBeforeDiagnosis = (await messages()).filter(item => ["reload-ad", "skip-ad"].includes(item.type)).length;
    popup = await openPopup();
    await page.bringToFront();
    // A browser-action popup leaves its host tab active. This background
    // extension-page click reproduces that tab selection without clipboard I/O.
    await popup.locator("#diagnostic-check").evaluate(button => button.click());
    let diagnosis;
    await eventually(async () => {
      try { diagnosis = JSON.parse(await popup.locator("#diagnostic-report").inputValue()); }
      catch { return false; }
      return diagnosis.ok === true && diagnosis.content?.connected === true;
    }, "The real diagnostic popup did not connect to the active content script");
    assert.equal(diagnosis.version, expectedVersion);
    assert.equal(diagnosis.enabled, false);
    // Chrome can omit tab.url without the broad tabs permission. The pinned
    // content reply still establishes that this is a supported watch page.
    assert.ok([true, null].includes(diagnosis.page.supported));
    assert.equal(diagnosis.content.supported, true);
    assert.equal(diagnosis.content.enabled, false);
    const reportText = await popup.locator("#diagnostic-report").inputValue();
    assert.ok(!reportText.includes("v=fixture-"), "Diagnostic output exposed the viewing query");
    await fs.writeFile(path.join(extensionRoot, "dist", `browser-diagnostic-${expectedVersion}.json`),
      JSON.stringify(diagnosis, null, 2));
    // Observe the copy-handler payload without replacing the user's OS clipboard.
    await popup.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async value => { window.fixtureCopiedReport = value; }
      } });
    });
    await popup.locator("#diagnostic-copy").evaluate(button => button.click());
    await eventually(async () => await popup.evaluate(() => window.fixtureCopiedReport) === reportText,
      "Diagnostic copy handler did not receive the sanitized report");
    assert.equal(await popup.locator("#diagnostic-copy-status").textContent(), "복사했어요.");
    assert.deepEqual(await worker.evaluate(() => chrome.storage.session.get(null)), sessionBeforeDiagnosis);
    assert.equal((await messages()).filter(item => ["reload-ad", "skip-ad"].includes(item.type)).length, actionsBeforeDiagnosis);
    await popup.close();
    record("the real diagnostic popup reads and copies sanitized content state without changing automation or session data");

    await worker.evaluate(() => chrome.storage.local.set({ enabled: true }));
    page = await reset({ firstButton: true });
    await go(page, "shorts/fixture-invalid");
    await sleep(1300);
    assert.equal((await messages()).filter(item => ["reload-ad", "skip-ad"].includes(item.type)).length, 0);
    record("non-watch URL prevents refresh and skip");

    page = await reset({ startMain: true, firstButton: true });
    await go(page, "watch?v=fixture-hidden");
    await eventually(async () => (await messages()).some(item => item.type === "ad-reload-state"), "State was not initialized");
    const foreground = await context.newPage();
    await foreground.goto("about:blank");
    await foreground.bringToFront();
    await page.evaluate(() => document.querySelector(".html5-video-player").classList.add("ad-showing"));
    await sleep(1300);
    assert.equal(scenario.loads.get("fixture-hidden"), 1);
    // Headless visibility can lag a tab switch; the real worker must still
    // prevent any refresh or trusted input, even if a stale request is sent.
    assert.equal(await page.evaluate(() => window.fixtureClicks.length), 0);
    record("background tab prevents refresh and skip");

    for (const [name, expectedHash] of Object.entries(sourceHashes)) {
      assert.equal(crypto.createHash("sha256").update(await fs.readFile(path.join(extensionRoot, name))).digest("hex"),
        expectedHash, "Source changed during browser verification: " + name);
    }
    console.log(JSON.stringify({ checksPassed: checks, sourceHashes, sourceUnchanged: true,
      source: "isolated real Chromium + real extension worker + synthetic local fixtures", realYouTubeAdTest: false }));
  } finally {
    if (context) await context.close();
    assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(profile).startsWith("youtube-reload-browser-fixture-"));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

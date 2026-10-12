import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { compareVersions, deploy } from '../scripts/deploy-cws.mjs';
import { releaseVersion, prepareRelease } from '../scripts/prepare-release.mjs';

// Every credential and response is synthetic. No test uses the real fetch function.
const env = {
  CWS_CLIENT_ID: 'test-client-42', CWS_CLIENT_SECRET: 'test-secret&+=42',
  CWS_REFRESH_TOKEN: 'test-refresh-42', CWS_PUBLISHER_ID: 'publisher-42',
  CWS_EXTENSION_ID: 'a'.repeat(32), GITHUB_ACTIONS: 'true',
  GITHUB_RUN_ID: '123', GITHUB_SHA: 'abc123',
};
const name = `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;
const token = { access_token: 'test-access-token-42' };
const packageBytes = new Uint8Array([80, 75, 3, 4]);
const version = '1.0.0.17';

function runner(responses, additions = {}) {
  const requests = [], logs = [], waits = [], receipts = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const response = responses.shift();
    assert.ok(response, 'Unexpected mocked network request');
    return new Response(JSON.stringify(response.body ?? response), {
      status: response.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    requests, logs, waits, receipts,
    run: () => deploy({
      env, version, packageBytes, fetchImpl,
      log: (value) => logs.push(value), wait: async (value) => waits.push(value),
      persistReceipt: async (value) => receipts.push(value), ...additions,
    }),
  };
}

test('automatic version range and numeric comparisons', () => {
  assert.equal(releaseVersion('1.0.0', '17'), version);
  assert.equal(releaseVersion('1.0.0', '65535'), '1.0.0.65535');
  for (const bad of ['0', '-1', '65536', '01', undefined]) assert.throws(() => releaseVersion('1.0.0', bad));
  for (const bad of ['1.0', '1.0.0.2', '1.0.65536', '1.01.0']) assert.throws(() => releaseVersion(bad, '17'));
  assert.equal(compareVersions('1.0.0.10', '1.0.0.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0.0'), 0);
});

test('version preparation only mutates its temporary fixture', async () => {
  const sourceManifest = new URL('../manifest.json', import.meta.url);
  const original = await readFile(sourceManifest, 'utf8');
  const temporaryRoot = await realpath(tmpdir());
  const fixture = await mkdtemp(join(temporaryRoot, 'youtube-release-test-'));
  const fixtureAbsolute = await realpath(fixture);
  assert.ok(fixtureAbsolute.startsWith(temporaryRoot + sep));
  try {
    const manifest = join(fixtureAbsolute, 'manifest.json'), output = join(fixtureAbsolute, 'output');
    await writeFile(manifest, JSON.stringify({ manifest_version: 3, version: '1.0.0', name: 'Fixture' }));
    assert.equal(await prepareRelease(manifest, '17', output), version);
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, version);
    assert.equal(await readFile(output, 'utf8'), `version=${version}\n`);
    assert.equal(await readFile(sourceManifest, 'utf8'), original);
  } finally {
    // Delete only the absolute temporary directory verified above.
    await rm(fixtureAbsolute, { recursive: true });
  }
});

test('valid ZIP upload and review request', async () => {
  const r = runner([token, {}, { uploadState: 'SUCCEEDED', crxVersion: version }, { state: 'PENDING_REVIEW' }]);
  assert.equal((await r.run()).outcome, 'submitted');
  assert.equal(r.requests.length, 4);
  assert.equal(r.requests[0].options.body.get('client_secret'), env.CWS_CLIENT_SECRET);
  assert.equal(r.requests[2].url, `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`);
  assert.equal(r.requests[2].options.body, packageBytes);
  assert.deepEqual(JSON.parse(r.requests[3].options.body), { publishType: 'DEFAULT_PUBLISH', skipReview: false });
  assert.equal(r.logs[0], `::add-mask::${token.access_token}`);
  assert.deepEqual(r.receipts[0], { name, version, runId: '123', commit: 'abc123' });
});

test('v2 asynchronous upload polling', async () => {
  const r = runner([token, {}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
  await r.run();
  assert.equal(r.waits.length, 2);
  assert.equal(r.requests[3].options.method, undefined);
});

test('documented progress spelling accepted', async () => {
  const r = runner([token, {}, { uploadState: 'UPLOAD_IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
  await r.run();
  assert.equal(r.waits.length, 1);
});

test('failed upload cannot submit for review', async () => {
  const r = runner([token, {}, { uploadState: 'FAILED' }]);
  await assert.rejects(r.run(), /validation failed/);
  assert.equal(r.requests.length, 3);
  assert.equal(r.receipts.length, 0);
});

test('bounded polling cannot submit unvalidated ZIP', async () => {
  const r = runner([token, {}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' }], { maxPollAttempts: 2 });
  await assert.rejects(r.run(), /did not finish/);
  assert.equal(r.requests.length, 5);
});

test('missing secrets cause no HTTP request', async () => {
  const r = runner([], { env: { ...env, CWS_REFRESH_TOKEN: '' } });
  await assert.rejects(r.run(), /CWS_REFRESH_TOKEN/);
  assert.equal(r.requests.length, 0);
});

test('already submitted version causes no write request', async () => {
  const r = runner([token, { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: version }] } }]);
  assert.equal((await r.run()).outcome, 'skipped');
  assert.equal(r.requests.length, 2);
});

test('other review and newer remote version block writes', async () => {
  const other = runner([token, { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.0.16' }] } }]);
  await assert.rejects(other.run(), /Another version/);
  assert.equal(other.requests.length, 2);
  const newer = runner([token, { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0.18' }] } }]);
  await assert.rejects(newer.run(), /newer than/);
  assert.equal(newer.requests.length, 2);
});

test('matching receipt retries review without duplicate upload', async () => {
  const r = runner([token, {}, { state: 'PENDING_REVIEW' }], { receipt: { name, version, runId: '123', commit: 'abc123' } });
  await r.run();
  assert.equal(r.requests.length, 3);
  assert.ok(r.requests[2].url.endsWith(':publish'));
});

test('wrong run receipt cannot bypass upload', async () => {
  const r = runner([token, {}, { uploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }], { receipt: { name, version, runId: '122', commit: 'abc123' } });
  await r.run();
  assert.ok(r.requests[2].url.endsWith(':upload'));
});

test('expired OAuth token gives actionable failure', async () => {
  const r = runner([{ status: 400, body: { error: 'invalid_grant', error_description: 'expired' } }]);
  await assert.rejects(r.run(), /Renew CWS_REFRESH_TOKEN/);
  assert.equal(r.requests.length, 1);
});

test('HTTP errors redact credentials and access tokens', async () => {
  const r = runner([token, {}, { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: `bad ${env.CWS_CLIENT_SECRET} ${env.CWS_REFRESH_TOKEN} ${token.access_token}` } } }]);
  let failure;
  try { await r.run(); } catch (error) { failure = error.message; }
  assert.ok(failure?.includes('[redacted]'));
  for (const secret of [env.CWS_CLIENT_SECRET, env.CWS_REFRESH_TOKEN, token.access_token]) assert.ok(!failure.includes(secret));
  assert.equal(r.requests.length, 3);
});

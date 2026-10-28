import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiOrigin = 'https://chromewebstore.googleapis.com';
const pendingUploadStates = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
const activeSubmissionStates = new Set(['PENDING_REVIEW', 'STAGED']);
const acceptedPublishStates = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

export function deploymentConfig(env) {
  const keys = ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_ACCESS_TOKEN',
    'CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID', 'CWS_WORKLOAD_IDENTITY_PROVIDER', 'CWS_SERVICE_ACCOUNT_EMAIL'];
  const config = Object.fromEntries(keys.map((key) => [key, typeof env[key] === 'string' ? env[key].trim() : '']));
  const hasProvider = !!config.CWS_WORKLOAD_IDENTITY_PROVIDER;
  const hasServiceAccount = !!config.CWS_SERVICE_ACCOUNT_EMAIL;
  if (hasProvider !== hasServiceAccount) {
    throw new Error('Incomplete WIF configuration: set both CWS_WORKLOAD_IDENTITY_PROVIDER and CWS_SERVICE_ACCOUNT_EMAIL, or remove both to use OAuth refresh credentials.');
  }
  if (hasProvider && !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/.test(config.CWS_WORKLOAD_IDENTITY_PROVIDER)) {
    throw new Error('Invalid CWS_WORKLOAD_IDENTITY_PROVIDER. Use the complete provider resource name from Google Cloud.');
  }
  if (hasServiceAccount && !/^[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.CWS_SERVICE_ACCOUNT_EMAIL)) {
    throw new Error('Invalid CWS_SERVICE_ACCOUNT_EMAIL. Use the service account email linked to the store publisher.');
  }
  if (hasProvider && !config.CWS_ACCESS_TOKEN) {
    throw new Error('CWS_ACCESS_TOKEN is missing for WIF. Check the google-auth step; OAuth fallback is disabled while WIF is configured.');
  }
  if (config.CWS_ACCESS_TOKEN && /\s/.test(config.CWS_ACCESS_TOKEN)) {
    throw new Error('Invalid CWS_ACCESS_TOKEN: expected one access token without whitespace.');
  }
  const required = ['CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID'];
  if (!config.CWS_ACCESS_TOKEN) required.push('CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN');
  const missing = required.filter((key) => !config[key]);
  if (missing.length) throw new Error(`Missing GitHub Actions configuration: ${missing.join(', ')}. See store/automation-cws.txt.`);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.CWS_PUBLISHER_ID)) throw new Error('Invalid CWS_PUBLISHER_ID. Copy the Publisher ID from the store dashboard.');
  if (!/^[a-p]{32}$/.test(config.CWS_EXTENSION_ID)) throw new Error('Invalid CWS_EXTENSION_ID. Copy the 32-letter extension ID from the store dashboard.');
  config.name = `publishers/${config.CWS_PUBLISHER_ID}/items/${config.CWS_EXTENSION_ID}`;
  return config;
}

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) {
    throw new Error('Invalid numeric extension version.');
  }
  const parts = version.split('.').map(Number);
  if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) throw new Error('Extension version components must be 0..65535 and cannot all be zero.');
  while (parts.length < 4) parts.push(0);
  return parts;
}

export function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] !== rightParts[index]) return Math.sign(leftParts[index] - rightParts[index]);
  }
  return 0;
}

export async function deploy({
  env = process.env, version, packageBytes, receipt,
  persistReceipt = async () => {}, fetchImpl = fetch,
  wait = (duration) => new Promise((resolveWait) => setTimeout(resolveWait, duration)),
  log = console.log, maxPollAttempts = 30, pollIntervalMs = 10000,
}) {
  const config = deploymentConfig(env);
  versionParts(version);
  if (!(packageBytes instanceof Uint8Array) || !packageBytes.length) throw new Error('The upload ZIP is empty or missing.');
  const protectedValues = [config.CWS_CLIENT_ID, config.CWS_CLIENT_SECRET, config.CWS_REFRESH_TOKEN, config.CWS_ACCESS_TOKEN].filter(Boolean);
  const redact = (message) => [...protectedValues].sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join('[redacted]'), String(message));
  const safeLog = (message, maxLength = Infinity) => log(redact(message).slice(0, maxLength));
  async function request(label, url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(label === 'Package upload' ? 120000 : 60000) });
    } catch {
      throw new Error(`${label}: network request failed or timed out. Check the store dashboard before rerunning this workflow.`);
    }
    let data;
    try { data = await response.json(); } catch { throw new Error(`${label}: the server returned an invalid JSON response (HTTP ${response.status}).`); }
    if (!response.ok) {
      const description = typeof data.error === 'string'
        ? `${data.error}: ${data.error_description || ''}`
        : `${data.error?.status || ''}: ${data.error?.message || 'Request rejected'}`;
      const hint = data.error === 'invalid_grant' ? ' Renew CWS_REFRESH_TOKEN; a Testing consent screen expires refresh tokens after seven days.' : '';
      throw new Error(redact(`${label} failed (HTTP ${response.status}): ${description}${hint}`).slice(0, 1500));
    }
    return data;
  }

  let accessToken = config.CWS_ACCESS_TOKEN;
  if (!accessToken) {
    const token = await request('OAuth token refresh', 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.CWS_CLIENT_ID, client_secret: config.CWS_CLIENT_SECRET,
        refresh_token: config.CWS_REFRESH_TOKEN, grant_type: 'refresh_token',
      }),
    });
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('OAuth response did not contain an access token.');
    accessToken = token.access_token;
    protectedValues.push(accessToken);
  }
  if (env.GITHUB_ACTIONS === 'true') {
    const escapedToken = accessToken.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    // GitHub consumes this masking command; normal messages always use safeLog.
    log(`::add-mask::${escapedToken}`);
  }
  const headers = { Authorization: `Bearer ${accessToken}` };
  const statusUrl = `${apiOrigin}/v2/${config.name}:fetchStatus`;
  const status = await request('Store status', statusUrl, { headers });
  if (status.takenDown) throw new Error('This extension has been taken down. Resolve the issue in the store dashboard.');
  for (const revision of [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]) {
    for (const channel of revision?.distributionChannels || []) {
      if (channel.crxVersion && compareVersions(version, channel.crxVersion) < 0) {
        throw new Error(`Store version ${channel.crxVersion} is newer than ${version}. Increase the source base version before a new push.`);
      }
    }
  }
  const sameVersion = (revision) => revision?.distributionChannels?.some((channel) => channel.crxVersion && compareVersions(version, channel.crxVersion) === 0);
  if (sameVersion(status.publishedItemRevisionStatus)
      || (activeSubmissionStates.has(status.submittedItemRevisionStatus?.state) && sameVersion(status.submittedItemRevisionStatus))) {
    const state = sameVersion(status.publishedItemRevisionStatus) ? status.publishedItemRevisionStatus.state : status.submittedItemRevisionStatus.state;
    safeLog(`Version ${version} is already published or submitted (${state}); no upload or publish request sent.`);
    return { outcome: 'skipped', version, state: typeof state === 'string' ? redact(state) : state };
  }
  if (activeSubmissionStates.has(status.submittedItemRevisionStatus?.state)) {
    throw new Error('Another version is under review or staged. Wait for its result, then rerun this workflow. This script does not cancel an existing submission.');
  }
  if (pendingUploadStates.has(status.lastAsyncUploadState)) {
    throw new Error('A previous package upload is still processing. Wait and check the store dashboard before rerunning.');
  }

  // A receipt is restored only from an earlier attempt of this same workflow run.
  // fetchStatus does not expose the version of an uploaded, unsubmitted draft.
  const validReceipt = receipt?.name === config.name && receipt?.version === version
    && receipt?.runId === env.GITHUB_RUN_ID && receipt?.commit === env.GITHUB_SHA
    && !!env.GITHUB_RUN_ID && !!env.GITHUB_SHA;
  if (validReceipt) {
    safeLog(`Restored upload receipt for ${version}; retrying its review submission.`);
  } else {
    let uploaded = await request('Package upload', `${apiOrigin}/upload/v2/${config.name}:upload`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: packageBytes,
    });
    let state = uploaded.uploadState;
    for (let attempt = 0; pendingUploadStates.has(state) && attempt < maxPollAttempts; attempt += 1) {
      safeLog(`Waiting for package validation (${attempt + 1}/${maxPollAttempts}).`);
      await wait(pollIntervalMs);
      uploaded = await request('Upload status', statusUrl, { headers });
      state = uploaded.lastAsyncUploadState;
    }
    if (pendingUploadStates.has(state)) throw new Error('Package validation did not finish within five minutes. Check the store dashboard before rerunning.');
    if (state !== 'SUCCEEDED') throw new Error(redact(`Package validation failed (${state || 'missing upload state'}). Check the store dashboard; no review request was sent.`));
    if (uploaded.crxVersion && compareVersions(version, uploaded.crxVersion) !== 0) throw new Error('The uploaded version differs from the package version; no review request was sent.');
    await persistReceipt({ name: config.name, version, runId: env.GITHUB_RUN_ID, commit: env.GITHUB_SHA });
    safeLog(`Package ${version} uploaded and validated.`);
  }

  const published = await request('Review submission', `${apiOrigin}/v2/${config.name}:publish`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false }),
  });
  if (!acceptedPublishStates.has(published.state)) throw new Error(redact(`Unexpected submission state: ${published.state || 'missing state'}. Check the store dashboard.`));
  for (const warning of published.warningInfo?.warnings || []) {
    safeLog(`Store warning: ${warning.reason || ''} ${warning.description || ''}`, 1500);
  }
  safeLog(`Version ${version} submission accepted. Store state: ${published.state}. Updates become available after store approval.`);
  return { outcome: 'submitted', version, state: published.state };
}

async function main() {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  versionParts(manifest.version);
  const zipPath = new URL(`../dist/youtube-auto-skip-${manifest.version}.zip`, import.meta.url);
  const receiptPath = process.env.CWS_UPLOAD_RECEIPT;
  let receipt;
  if (receiptPath) {
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('The restored upload receipt is invalid. Check workflow artifacts before rerunning.'); }
  }
  const result = await deploy({
    version: manifest.version, packageBytes: await readFile(zipPath), receipt,
    persistReceipt: async (value) => {
      if (!receiptPath) return;
      await mkdir(dirname(resolve(receiptPath)), { recursive: true });
      await writeFile(receiptPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    },
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `Chrome Web Store: **${result.outcome}** version **${result.version}** (${result.state}).\n\nA successful submission requires store approval before users receive an update.\n`, 'utf8');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

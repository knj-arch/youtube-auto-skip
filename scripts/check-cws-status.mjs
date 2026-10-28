import { appendFile } from 'node:fs/promises';

// Read-only: one GET request, no upload, publish, cancellation, or API retries.
const itemStates = new Set([
  'ITEM_STATE_UNSPECIFIED', 'PENDING_REVIEW', 'STAGED', 'PUBLISHED',
  'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED',
]);
const uploadStates = new Set(['UPLOAD_STATE_UNSPECIFIED', 'SUCCEEDED', 'IN_PROGRESS', 'FAILED', 'NOT_FOUND']);
const enumValue = (value, allowed) => allowed.has(value) ? value :
  value === undefined || value === null ? 'NOT_RETURNED' : 'UNRECOGNIZED';

function versionValue(value) {
  return typeof value === 'string' && /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(value) &&
    value.split('.').every(part => Number(part) <= 65535) ? value : null;
}

function revisionValue(revision) {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) return null;
  return {
    state: enumValue(revision.state, itemStates),
    distributionChannels: Array.isArray(revision.distributionChannels) ?
      revision.distributionChannels.slice(0, 20).map(channel => ({
        crxVersion: versionValue(channel?.crxVersion),
        deployPercentage: Number.isInteger(channel?.deployPercentage) &&
          channel.deployPercentage >= 0 && channel.deployPercentage <= 100 ? channel.deployPercentage : null,
      })) : [],
  };
}

async function main() {
  const publisherId = process.env.CWS_PUBLISHER_ID?.trim();
  const extensionId = process.env.CWS_EXTENSION_ID?.trim();
  const accessToken = process.env.CWS_ACCESS_TOKEN?.trim();
  if (!publisherId || !/^[A-Za-z0-9_-]{1,128}$/.test(publisherId)) {
    throw new Error('CWS_PUBLISHER_ID is missing or invalid.');
  }
  if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('CWS_EXTENSION_ID is missing or invalid.');
  }
  if (!accessToken || /\s/.test(accessToken)) throw new Error('CWS_ACCESS_TOKEN is missing or invalid.');
  const name = `publishers/${publisherId}/items/${extensionId}`;
  let response;
  try {
    response = await fetch(`https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`, {
      method: 'GET', headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error', signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error('Chrome Web Store status request failed or timed out.');
  }
  if (!response.ok) throw new Error(`Chrome Web Store status request failed (HTTP ${response.status}).`);
  let data;
  try { data = await response.json(); } catch {
    throw new Error('Chrome Web Store returned an invalid JSON status response.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Chrome Web Store returned an invalid status object.');
  }
  if ((data.name !== undefined && data.name !== name) ||
      (data.itemId !== undefined && data.itemId !== extensionId)) {
    throw new Error('Chrome Web Store response does not match the configured item.');
  }
  const checkedAt = new Date();
  // Only documented status fields are copied. publicKey, free text and error
  // bodies are intentionally excluded; the timestamps below are our check time.
  const report = {
    checkedAtUtc: checkedAt.toISOString(),
    checkedAtKst: new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(checkedAt) + ' KST',
    name,
    itemId: extensionId,
    publishedItemRevisionStatus: revisionValue(data.publishedItemRevisionStatus),
    submittedItemRevisionStatus: revisionValue(data.submittedItemRevisionStatus),
    lastAsyncUploadState: enumValue(data.lastAsyncUploadState, uploadStates),
    takenDown: typeof data.takenDown === 'boolean' ? data.takenDown : data.takenDown === undefined ? false : null,
    warned: typeof data.warned === 'boolean' ? data.warned : data.warned === undefined ? false : null,
  };
  const safeJson = JSON.stringify(report, null, 2).split(accessToken).join('[redacted]');
  console.log(safeJson);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `## Chrome Web Store status\n\nRead-only fetchStatus GET.\n\n\`\`\`json\n${safeJson}\n\`\`\`\n`, 'utf8');
    } catch {
      throw new Error('Status was printed, but writing the GitHub step summary failed.');
    }
  }
}

main().catch(error => {
  // Every thrown message above is fixed text or an HTTP status number, never
  // an upstream response body, request headers, credentials, or a token.
  console.error(error.message);
  process.exitCode = 1;
});

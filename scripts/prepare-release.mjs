import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseVersion(baseVersion, runNumber) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(baseVersion)
      || baseVersion.split('.').some((part) => Number(part) > 65535)) {
    throw new Error('Source manifest.version must have three numeric components, each 0..65535.');
  }
  if (!/^[1-9]\d*$/.test(String(runNumber)) || Number(runNumber) > 65535) {
    throw new Error('GITHUB_RUN_NUMBER must be 1..65535. Increase the source base version and start a new workflow before this limit.');
  }
  return `${baseVersion}.${runNumber}`;
}

export async function prepareRelease(manifestPath, runNumber, outputPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const version = releaseVersion(manifest.version, runNumber);
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (outputPath) await appendFile(outputPath, `version=${version}\n`, 'utf8');
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true') {
      throw new Error('Run this version preparation step in GitHub Actions. Local packages use the source manifest version.');
    }
    const version = await prepareRelease(
      new URL('../manifest.json', import.meta.url),
      process.env.GITHUB_RUN_NUMBER,
      process.env.GITHUB_OUTPUT,
    );
    console.log(`Release package version: ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

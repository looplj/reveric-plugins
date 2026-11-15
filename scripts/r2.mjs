import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CDN_ORIGIN, cdnAssetKey, cdnAssetUrl } from './catalog.mjs';

export const DEFAULT_R2_BUCKET = 'reveric-releases';
export const R2_INDEX_KEY = 'plugins/index.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function defaultPutObject({ bucket, key, filePath, contentType, cacheControl }) {
  const args = [
    '--yes',
    'wrangler@4.160.1',
    'r2',
    'object',
    'put',
    `${bucket}/${key}`,
    `--file=${filePath}`,
    `--content-type=${contentType}`,
  ];
  if (cacheControl) {
    args.push(`--cache-control=${cacheControl}`);
  }
  args.push('--remote', '--force');
  execFileSync('npx', args, { stdio: 'inherit' });
}

async function isUploaded(cdnUrl, expectedSize, fetchImpl) {
  const response = await fetchImpl(cdnUrl, { method: 'HEAD' });
  if (!response.ok) return false;
  const length = response.headers.get('content-length');
  if (length && expectedSize != null && length !== String(expectedSize)) return false;
  return true;
}

export async function syncToR2({
  releases,
  indexPath,
  cdnOrigin = DEFAULT_CDN_ORIGIN,
  bucket = DEFAULT_R2_BUCKET,
  fetchImpl = fetch,
  putObject = defaultPutObject,
}) {
  const temporary = await mkdtemp(join(tmpdir(), 'reveric-plugins-r2-'));
  let uploadedArchives = 0;
  try {
    // Upload all missing plugin ZIPs before updating plugins/index.json so
    // clients reading the new index never hit 404s.
    for (const release of releases) {
      if (!release.slug || !release.asset || !release.url) {
        throw new Error(`Invalid published release metadata for R2 sync: ${release.id}@${release.version}`);
      }
      const key = cdnAssetKey(release);
      const cdnUrl = cdnAssetUrl(release, cdnOrigin);
      if (await isUploaded(cdnUrl, release.size, fetchImpl)) {
        continue;
      }
      const response = await fetchImpl(release.url);
      if (!response.ok) {
        throw new Error(`Failed to download GitHub Release asset ${release.url}: ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== release.size) {
        throw new Error(`Downloaded asset size mismatch for ${release.id}@${release.version}: ${bytes.length} !== ${release.size}`);
      }
      if (sha256(bytes) !== release.sha256) {
        throw new Error(`Downloaded asset SHA-256 mismatch for ${release.id}@${release.version}`);
      }
      const filePath = join(temporary, release.asset);
      await writeFile(filePath, bytes);
      putObject({
        bucket,
        key,
        filePath,
        contentType: 'application/zip',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      uploadedArchives += 1;
    }

    putObject({
      bucket,
      key: R2_INDEX_KEY,
      filePath: indexPath,
      contentType: 'application/json',
      cacheControl: 'public, max-age=60',
    });
    return { uploadedArchives, totalReleases: releases.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packPlugin } from 'reveric-plugin-sdk/build';
import { unzipSync, strFromU8 } from 'fflate';
import semver from 'semver';
import { sha256, nextVersion } from './catalog.mjs';
import { releaseBody, releaseMarker } from './github.mjs';

export function runTests(root, plugin) {
  const env = { ...process.env };
  // Nested node:test processes otherwise inherit the parent runner context and
  // silently skip the plugin's tests (including in our integration tests).
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--prefix', plugin.directory], {
    cwd: root, stdio: 'inherit', timeout: 180_000, env,
  });
}

export async function buildPackage(root, task, outFile) {
  const manifestPath = join(root, task.directory, 'plugin.json');
  const original = await readFile(manifestPath);
  try {
    await writeFile(manifestPath, `${JSON.stringify({ ...task.manifest, version: task.version }, null, 2)}\n`);
    await packPlugin({ root: join(root, task.directory), outFile });
    const bytes = await readFile(outFile);
    const files = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(files['plugin.json']));
    if (manifest.id !== task.manifest.id || manifest.version !== task.version || !files[manifest.main]) {
      throw new Error('Packed plugin identity does not match release');
    }
    return bytes;
  } finally {
    await writeFile(manifestPath, original);
  }
}

export async function checkPlugin(root, plugin) {
  runTests(root, plugin);
  const temporary = await mkdtemp(join(tmpdir(), 'reveric-plugin-check-'));
  try { await buildPackage(root, { ...plugin, version: plugin.manifest.version }, join(temporary, 'plugin.zip')); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function publishTask(root, task, github, releases, sourceCommit, { build = buildPackage, test = runTests } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) throw new Error('Publishing requires a full commit SHA');
  const drafts = releases.filter(r => r.draft && r.tag_name.startsWith(`${task.slug}/v`));
  const matching = drafts.find(r => {
    const info = releaseMarker(r);
    return info?.id === task.manifest.id && info.inputHash === task.inputHash
      && semver.valid(info.version) && semver.gte(info.version, task.version);
  });
  let version = task.version;
  let commit = sourceCommit;
  if (matching) {
    const info = releaseMarker(matching);
    version = info.version;
    commit = info.sourceCommit;
    if (!semver.valid(version) || semver.lt(version, task.version) || !/^[a-f0-9]{40}$/.test(commit)
      || matching.tag_name !== `${task.slug}/v${version}`) throw new Error('Invalid/stale pending release');
  } else {
    // A failed older input may have reserved a tag. Keep its draft intact and
    // allocate the next version rather than repointing a tag to different code.
    for (const draft of drafts) {
      const reserved = draft.tag_name.slice(`${task.slug}/v`.length);
      if (semver.valid(reserved) && semver.gte(reserved, version)) version = nextVersion(version, reserved);
    }
  }
  const tag = `${task.slug}/v${version}`;
  if (releases.some(r => r.tag_name === tag && !r.draft)) throw new Error(`Version already published: ${tag}`);
  await test(root, task);
  const temporary = await mkdtemp(join(tmpdir(), 'reveric-plugin-release-'));
  try {
    const asset = `${task.manifest.id}-${version}.zip`;
    const bytes = await build(root, { ...task, version }, join(temporary, asset));
    const identity = { id: task.manifest.id, version, inputHash: task.inputHash, sourceCommit: commit };
    let release = matching;
    if (!release) {
      // An unmanaged tag must never silently attach this release to old code.
      const refs = await github.request(`/git/matching-refs/tags/${encodeURIComponent(tag)}`);
      if (refs.some(ref => ref.ref === `refs/tags/${tag}`)) throw new Error(`Tag already exists without a matching draft: ${tag}`);
      release = await github.request('/releases', { method: 'POST', body: {
        tag_name: tag, target_commitish: commit, name: `${task.manifest.id} ${version}`,
        body: releaseBody(identity), draft: true, prerelease: false, make_latest: 'false',
      } });
    }
    const uploaded = await github.upload(release, asset, bytes, 'application/zip');
    const metadata = {
      schemaVersion: 1, slug: task.slug, ...identity,
      name: task.manifest.name, description: task.manifest.description ?? '', author: task.manifest.author ?? '',
      pluginApiVersion: task.manifest.pluginApiVersion, platforms: task.platforms,
      repository: `https://github.com/${github.repository}`,
      releaseUrl: `https://github.com/${github.repository}/releases/tag/${encodeURIComponent(tag)}`,
      asset, url: uploaded.browser_download_url, size: bytes.length, sha256: sha256(bytes),
    };
    if (uploaded.size !== bytes.length || (uploaded.digest && uploaded.digest !== `sha256:${metadata.sha256}`)) {
      throw new Error('Uploaded ZIP integrity mismatch');
    }
    await github.upload(release, 'release.json', Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`), 'application/json');
    await github.request(`/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'false' } });
    return metadata;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function writeIndex(directory, index) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(join(directory, '.nojekyll'), '');
}

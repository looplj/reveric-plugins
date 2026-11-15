import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const ignoredDirectories = new Set(['node_modules', '.git', 'build', 'dist', 'coverage']);

export async function filesUnder(root, relative = '') {
  let entries;
  try { entries = await readdir(join(root, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ignoredDirectories.has(entry.name)) continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Source symlinks are unsupported: ${path}`);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (!entry.name.endsWith('.zip')) files.push(path);
  }
  return files.sort();
}

export function isReleaseInput(path) {
  return !/(^|\/)(test|tests|__tests__|docs)\//.test(path)
    && !/(^|\/)(README|CHANGELOG)(\.[^/]*)?$/i.test(path)
    && !/\.(test|spec)\.[^/]+$/.test(path);
}

export async function discover(root) {
  let entries;
  try { entries = await readdir(join(root, 'plugins'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const plugins = [];
  const ids = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(`Invalid plugin directory: ${entry.name}`);
    }
    const directory = `plugins/${entry.name}`;
    const manifest = await readJson(join(root, directory, 'plugin.json'));
    if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id ?? '') || ids.has(manifest.id)) {
      throw new Error(`Invalid or duplicate plugin id: ${manifest.id}`);
    }
    if (semver.valid(manifest.version) !== manifest.version || semver.prerelease(manifest.version) || manifest.version.includes('+')) {
      throw new Error(`Use a stable semantic version: ${directory}`);
    }
    if (manifest.main !== 'dist/index.js' || !semver.validRange(manifest.pluginApiVersion)) {
      throw new Error(`Invalid entry or plugin API range: ${directory}`);
    }
    if (!(typeof manifest.name === 'string' && manifest.name.trim())
      && !(manifest.name && !Array.isArray(manifest.name) && typeof manifest.name === 'object'
        && Object.keys(manifest.name).length && Object.values(manifest.name).every(v => typeof v === 'string' && v.trim()))) {
      throw new Error(`Invalid plugin name: ${directory}`);
    }
    const platforms = manifest.platforms ?? ['windows', 'macos', 'android'];
    if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !['windows', 'macos', 'android'].includes(p))) {
      throw new Error(`Invalid platforms: ${directory}`);
    }
    const pkg = await readJson(join(root, directory, 'package.json'));
    if (!pkg.private || !pkg.scripts?.test) throw new Error(`${directory} needs private: true and a test script`);
    await readJson(join(root, directory, 'tsconfig.json'));
    await readFile(join(root, directory, 'src/index.ts'));
    ids.add(manifest.id);
    plugins.push({ slug: entry.name, directory, manifest, platforms });
  }
  return plugins;
}

// Hash all declared build inputs, not just this push's diff. A failed release
// therefore remains eligible on the next run.
export async function fingerprint(root, plugin) {
  const paths = [
    ...(await filesUnder(root, plugin.directory)).filter(isReleaseInput),
    ...(await filesUnder(root, 'vendor')).filter(isReleaseInput),
    ...(await filesUnder(root, 'scripts')).filter(isReleaseInput),
    ...(await filesUnder(root, '.github/workflows')).filter(isReleaseInput),
    'package.json', 'package-lock.json', '.nvmrc',
  ].sort();
  const hash = createHash('sha256');
  hash.update('reveric-plugin-inputs-v1\0');
  for (const path of paths) {
    const data = await readFile(join(root, path));
    hash.update(`${path}\0${data.length}\0`);
    hash.update(data);
  }
  return hash.digest('hex');
}

export function affectedPlugins(plugins, changedPaths) {
  const all = changedPaths.some(path =>
    /^(vendor\/|scripts\/|test\/|\.github\/workflows\/)/.test(path)
    || ['package.json', 'package-lock.json', '.nvmrc'].includes(path));
  return plugins.filter(plugin => all || changedPaths.some(path => path.startsWith(`${plugin.directory}/`)));
}

export function nextVersion(floor, previous) {
  return !previous || semver.gt(floor, previous) ? floor : semver.inc(previous, 'patch');
}

export async function plan(root, plugins, releases) {
  const tasks = [];
  for (const plugin of plugins) {
    const history = releases.filter(r => r.slug === plugin.slug);
    if (history.some(r => r.id !== plugin.manifest.id)) {
      throw new Error(`Published directory identity cannot change: ${plugin.slug}`);
    }
    if (releases.some(r => r.id === plugin.manifest.id && r.slug !== plugin.slug)) {
      throw new Error(`Published plugin directory cannot be renamed: ${plugin.manifest.id}`);
    }
    const previous = history.sort((a, b) => semver.rcompare(a.version, b.version))[0];
    const inputHash = await fingerprint(root, plugin);
    if (previous?.inputHash === inputHash) continue;
    tasks.push({ ...plugin, inputHash, version: nextVersion(plugin.manifest.version, previous?.version) });
  }
  return tasks;
}

export const DEFAULT_CDN_ORIGIN = 'https://downloads.reveric.app';

export function cdnAssetKey(release) {
  return `plugins/${release.slug}/v${release.version}/${release.asset}`;
}

export function cdnAssetUrl(release, origin = DEFAULT_CDN_ORIGIN) {
  const normalizedOrigin = origin.replace(/\/+$/, '');
  return `${normalizedOrigin}/${cdnAssetKey(release)}`;
}

export function buildIndex(releases, { cdnOrigin = DEFAULT_CDN_ORIGIN } = {}) {
  const plugins = new Map();
  const normalizedOrigin = typeof cdnOrigin === 'string' && cdnOrigin.trim()
    ? cdnOrigin.trim().replace(/\/+$/, '')
    : null;
  for (const release of [...releases].sort((a, b) => semver.rcompare(a.version, b.version))) {
    let plugin = plugins.get(release.id);
    if (!plugin) {
      plugin = { id: release.id, name: release.name, description: release.description,
        author: release.author, repository: release.repository, versions: [] };
      plugins.set(release.id, plugin);
    }
    if (plugin.versions.some(v => v.version === release.version)) throw new Error(`Duplicate published version: ${release.id}@${release.version}`);
    const useCdn = Boolean(normalizedOrigin && release.slug && release.asset);
    const url = useCdn ? cdnAssetUrl(release, normalizedOrigin) : release.url;
    const fallbackUrl = useCdn && release.url && release.url !== url ? release.url : undefined;
    plugin.versions.push({
      version: release.version,
      pluginApiVersion: release.pluginApiVersion,
      platforms: release.platforms,
      url,
      ...(fallbackUrl ? { fallbackUrl } : {}),
      size: release.size,
      sha256: release.sha256,
      releaseUrl: release.releaseUrl,
      sourceCommit: release.sourceCommit,
    });
  }
  return { schemaVersion: 1, plugins: [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

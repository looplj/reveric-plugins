import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { discover, fingerprint, affectedPlugins, nextVersion, plan, buildIndex } from '../scripts/catalog.mjs';
import { buildPackage, checkPlugin, writeIndex } from '../scripts/publisher.mjs';
import { unzipSync, strFromU8 } from 'fflate';

const require = createRequire(import.meta.url);
async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
}
async function fixture(t, names = ['alpha']) {
  const root = await mkdtemp(join(tmpdir(), 'reveric-catalog-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, 'package.json', { private: true });
  await put(root, 'package-lock.json', {});
  await put(root, '.nvmrc', '22');
  for (const slug of names) {
    const base = `plugins/${slug}`;
    await put(root, `${base}/plugin.json`, {
      id: `example.${slug}`, name: slug, version: '1.0.0', main: 'dist/index.js', pluginApiVersion: '^1',
    });
    await put(root, `${base}/package.json`, { private: true, scripts: { test: 'node --test test/*.mjs' } });
    await put(root, `${base}/tsconfig.json`, { extends: require.resolve('reveric-plugin-sdk/tsconfig.base.json'), include: ['src'] });
    await put(root, `${base}/src/index.ts`, 'export function apply() {}');
    await put(root, `${base}/test/plugin.mjs`, "import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('fixture executes', () => writeFileSync('test-ran', 'yes'));");
  }
  return root;
}

test('empty repository produces an empty plan and valid catalog', async t => {
  const root = await fixture(t, []);
  assert.deepEqual(await discover(root), []);
  assert.deepEqual(await plan(root, [], []), []);
  const index = buildIndex([]);
  await writeIndex(join(root, 'site'), index);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'site/index.json'))), { schemaVersion: 1, plugins: [] });
});

test('discovers directories and rejects duplicate identities and missing tests', async t => {
  const root = await fixture(t, ['alpha', 'beta']);
  assert.equal((await discover(root)).length, 2);
  const manifest = JSON.parse(await readFile(join(root, 'plugins/beta/plugin.json')));
  await put(root, 'plugins/beta/plugin.json', { ...manifest, id: 'example.alpha' });
  await assert.rejects(discover(root), /duplicate plugin id/);
  await put(root, 'plugins/beta/plugin.json', manifest);
  await put(root, 'plugins/beta/package.json', { private: true });
  await assert.rejects(discover(root), /test script/);
});

test('PR detection selects local changes, including test-only changes', async t => {
  const plugins = await discover(await fixture(t, ['alpha', 'beta']));
  assert.deepEqual(affectedPlugins(plugins, ['plugins/alpha/test/plugin.mjs']).map(p => p.slug), ['alpha']);
  assert.equal(affectedPlugins(plugins, ['vendor/reveric-plugin-sdk-0.1.1.tgz']).length, 2);
  assert.equal(affectedPlugins(plugins, ['package-lock.json']).length, 2);
  assert.equal(affectedPlugins(plugins, ['README.md']).length, 0);
});

test('release fingerprints ignore tests/readmes, include source/lockfile/sdk, isolate other plugins', async t => {
  const root = await fixture(t, ['alpha', 'beta']);
  const [alpha] = await discover(root);
  const first = await fingerprint(root, alpha);
  await put(root, 'plugins/alpha/README.md', 'new docs');
  await put(root, 'plugins/alpha/test/new.mjs', 'test');
  await put(root, 'plugins/beta/src/index.ts', 'changed other plugin');
  assert.equal(await fingerprint(root, alpha), first);
  await put(root, 'plugins/alpha/src/index.ts', 'changed own plugin');
  const own = await fingerprint(root, alpha);
  assert.notEqual(own, first);
  await put(root, 'package-lock.json', { changed: true });
  const locked = await fingerprint(root, alpha);
  assert.notEqual(locked, own);
  await put(root, 'vendor/sdk.tgz', 'sdk package bytes');
  const sdk = await fingerprint(root, alpha);
  assert.notEqual(sdk, locked);
  await put(root, 'vendor/sdk.tgz', 'changed sdk bytes');
  assert.notEqual(await fingerprint(root, alpha), sdk);
});

test('auto patch and explicit version floors do not repeatedly increment minor/major', () => {
  assert.equal(nextVersion('1.0.0'), '1.0.0');
  assert.equal(nextVersion('1.0.0', '1.0.8'), '1.0.9');
  assert.equal(nextVersion('1.1.0', '1.0.8'), '1.1.0');
  assert.equal(nextVersion('1.1.0', '1.1.0'), '1.1.1');
  assert.equal(nextVersion('2.0.0', '1.9.0'), '2.0.0');
});

test('failed publications remain eligible and successful inputs do not republish', async t => {
  const root = await fixture(t);
  const plugins = await discover(root);
  const [first] = await plan(root, plugins, []);
  const releases = [{ slug: first.slug, id: first.manifest.id, inputHash: first.inputHash, version: first.version }];
  assert.deepEqual(await plan(root, plugins, releases), []);
  await put(root, 'plugins/alpha/src/index.ts', 'export function apply() { return 1; }');
  const [second] = await plan(root, plugins, releases);
  assert.equal(second.version, '1.0.1');
  assert.equal((await plan(root, plugins, releases))[0].inputHash, second.inputHash);
  await assert.rejects(plan(root, plugins, [{ ...releases[0], id: 'example.other' }]), /identity cannot change/);
});

test('catalog keeps all versions, sorts semantically, emits CDN + fallback URLs, and rejects duplicates', () => {
  const base = {
    id: 'example.alpha',
    slug: 'alpha',
    name: 'Alpha',
    platforms: ['macos'],
    pluginApiVersion: '^1',
    size: 123,
    sha256: 'a'.repeat(64),
  };
  const index = buildIndex([
    {
      ...base,
      version: '1.0.9',
      asset: 'example.alpha-1.0.9.zip',
      url: 'https://github.com/looplj/reveric-plugins/releases/download/alpha%2Fv1.0.9/example.alpha-1.0.9.zip',
    },
    {
      ...base,
      version: '1.0.10',
      asset: 'example.alpha-1.0.10.zip',
      url: 'https://github.com/looplj/reveric-plugins/releases/download/alpha%2Fv1.0.10/example.alpha-1.0.10.zip',
    },
  ]);
  assert.deepEqual(index.plugins[0].versions.map(v => v.version), ['1.0.10', '1.0.9']);
  assert.equal(
    index.plugins[0].versions[0].url,
    'https://downloads.reveric.app/plugins/alpha/v1.0.10/example.alpha-1.0.10.zip',
  );
  assert.equal(
    index.plugins[0].versions[0].fallbackUrl,
    'https://github.com/looplj/reveric-plugins/releases/download/alpha%2Fv1.0.10/example.alpha-1.0.10.zip',
  );
  assert.throws(() => buildIndex([{ ...base, version: '1.0.0' }, { ...base, version: '1.0.0' }]), /Duplicate/);
});

test('installed SDK builds an installable ZIP with computed version and restores source', async t => {
  const root = await fixture(t);
  const [plugin] = await discover(root);
  const source = await readFile(join(root, plugin.directory, 'plugin.json'), 'utf8');
  const bytes = await buildPackage(root, { ...plugin, version: '1.0.7' }, join(root, 'plugin.zip'));
  const archive = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(archive['plugin.json']));
  assert.equal(manifest.version, '1.0.7');
  assert.equal(manifest.id, 'example.alpha');
  assert.ok(archive['dist/index.js']);
  assert.equal(await readFile(join(root, plugin.directory, 'plugin.json'), 'utf8'), source);
  await checkPlugin(root, plugin);
  assert.equal(await readFile(join(root, plugin.directory, 'test-ran'), 'utf8'), 'yes');
});

test('failed type checks restore the original manifest', async t => {
  const root = await fixture(t);
  const [plugin] = await discover(root);
  const source = await readFile(join(root, plugin.directory, 'plugin.json'), 'utf8');
  await put(root, 'plugins/alpha/src/index.ts', 'const x: number = "wrong"; export { x };');
  await assert.rejects(buildPackage(root, { ...plugin, version: '1.0.2' }, join(root, 'plugin.zip')));
  assert.equal(await readFile(join(root, plugin.directory, 'plugin.json'), 'utf8'), source);
});

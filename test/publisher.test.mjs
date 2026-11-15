import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, releaseBody, validateRelease } from '../scripts/github.mjs';
import { publishTask } from '../scripts/publisher.mjs';
import { sha256 } from '../scripts/catalog.mjs';

const commit = 'a'.repeat(40);
const task = { slug: 'alpha', directory: 'plugins/alpha', version: '1.0.0', inputHash: 'b'.repeat(64),
  manifest: { id: 'example.alpha', name: 'Alpha', pluginApiVersion: '^1' }, platforms: ['windows', 'macos', 'android'] };
const bytes = Buffer.from('fake ZIP for orchestration tests');
const hooks = { test: async () => {}, build: async () => bytes };

function fakeApi() {
  let failPublish = false;
  let sequence = 0;
  const contents = new Map();
  const api = {
    repository: 'example/plugins', releases: [], calls: [],
    set failPublish(value) { failPublish = value; },
    async request(path, options = {}) {
      this.calls.push([path, options]);
      if (path.startsWith('/git/matching-refs/')) return [];
      if (path === '/releases') {
        const release = { id: ++sequence, assets: [], ...options.body,
          html_url: `https://github.com/${this.repository}/releases/tag/${options.body.tag_name}` };
        this.releases.push(release);
        return release;
      }
      if (options.method === 'PATCH') {
        if (failPublish) throw new Error('temporary publish failure');
        const release = this.releases.find(r => path === `/releases/${r.id}`);
        Object.assign(release, options.body);
        if (release.draft === false) {
          for (const asset of release.assets) {
            asset.browser_download_url = `https://github.com/${this.repository}/releases/download/${release.tag_name}/${asset.name}`;
          }
        }
        return release;
      }
      throw new Error(`Unexpected request: ${path}`);
    },
    async upload(release, name, payload) {
      assert.equal(release.draft, true);
      const asset = { id: ++sequence, name, state: 'uploaded', size: payload.length, digest: `sha256:${sha256(payload)}`,
        browser_download_url: `https://github.com/${this.repository}/releases/download/untagged-0123456789abcdef/${name}` };
      release.assets = release.assets.filter(a => a.name !== name).concat(asset);
      contents.set(name, payload);
      return asset;
    },
    contents,
  };
  return api;
}

test('publish creates a draft, uploads matching metadata, then publishes; never overwrites a public version', async () => {
  const api = fakeApi();
  const metadata = await publishTask('.', task, api, [], commit, hooks);
  const [release] = api.releases;
  assert.equal(release.draft, false);
  assert.equal(release.tag_name, 'alpha/v1.0.0');
  assert.equal(release.target_commitish, commit);
  assert.equal(metadata.sha256, sha256(bytes));
  assert.deepEqual(JSON.parse(api.contents.get('release.json')), metadata);
  validateRelease(metadata, release, api.repository);
  await assert.rejects(publishTask('.', task, api, api.releases, commit, hooks), /already published/);
});

test('failure before publication resumes the same draft and version', async () => {
  const api = fakeApi();
  api.failPublish = true;
  await assert.rejects(publishTask('.', task, api, [], commit, hooks), /temporary publish failure/);
  assert.equal(api.releases[0].draft, true);
  api.failPublish = false;
  const metadata = await publishTask('.', task, api, api.releases, 'c'.repeat(40), hooks);
  assert.equal(api.releases.length, 1);
  assert.equal(metadata.version, '1.0.0');
  assert.equal(metadata.sourceCommit, commit);
  assert.equal(api.releases[0].draft, false);
});

test('new inputs do not repoint an older failed draft tag', async () => {
  const api = fakeApi();
  api.releases.push({ id: 99, tag_name: 'alpha/v1.0.0', draft: true, assets: [],
    body: releaseBody({ id: 'example.alpha', version: '1.0.0', inputHash: 'd'.repeat(64), sourceCommit: commit }) });
  const result = await publishTask('.', task, api, api.releases, commit, hooks);
  assert.equal(result.version, '1.0.1');
  assert.equal(api.releases[0].draft, true);
});

test('test/build failures create no release', async () => {
  const api = fakeApi();
  await assert.rejects(publishTask('.', task, api, [], commit, { ...hooks, test: async () => { throw new Error('tests failed'); } }), /tests failed/);
  await assert.rejects(publishTask('.', task, api, [], commit, { ...hooks, build: async () => { throw new Error('build failed'); } }), /build failed/);
  assert.equal(api.calls.length, 0);
});

test('index validation rejects changed bytes, foreign download URLs, and missing assets, while normalizing legacy draft URLs', async () => {
  const api = fakeApi();
  const metadata = await publishTask('.', task, api, [], commit, hooks);
  const release = api.releases[0];
  assert.equal(metadata.url, `https://github.com/${api.repository}/releases/download/alpha/v1.0.0/example.alpha-1.0.0.zip`);
  assert.doesNotThrow(() => validateRelease(
    { ...metadata, url: `https://github.com/${api.repository}/releases/download/untagged-306c9b2546576dc98e9f/${metadata.asset}` },
    release,
    api.repository,
  ));
  assert.throws(() => validateRelease({ ...metadata, sha256: '0'.repeat(64) }, release, api.repository), /Invalid/);
  assert.throws(() => validateRelease({ ...metadata, url: 'https://example.com/plugin.zip' }, release, api.repository), /Invalid/);
  assert.throws(() => validateRelease(metadata, { ...release, assets: [] }, api.repository), /Invalid/);

  const gh = new GitHub(api.repository, null, async () => new Response(JSON.stringify({
    ...metadata,
    url: `https://github.com/${api.repository}/releases/download/untagged-306c9b2546576dc98e9f/${metadata.asset}`,
  })));
  const [resolved] = await gh.published([release]);
  assert.equal(resolved.url, metadata.url);
});

test('GitHub pagination reads every page; published catalog excludes drafts and unrelated releases', async () => {
  const paths = [];
  const api = new GitHub('example/plugins', null, async url => {
    paths.push(url);
    return Response.json(url.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : []);
  });
  assert.equal((await api.listReleases()).length, 100);
  assert.equal(paths.length, 2);
  assert.deepEqual(await api.published([{ draft: true }, { prerelease: true }, { tag_name: 'v1.0.0' }]), []);
});

test('GitHub adapter never sends credentials to an unexpected host or replaces published assets', async () => {
  const api = new GitHub('example/plugins', 'test-token', async () => { throw new Error('network must not be reached'); });
  await assert.rejects(api.request('https://example.com/path'), /Unexpected GitHub API host/);
  await assert.rejects(api.upload({ draft: false }, 'plugin.zip', bytes, 'application/zip'), /published release/);
});

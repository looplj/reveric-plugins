import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncToR2 } from '../scripts/r2.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('syncToR2 uploads missing archives before index.json and skips existing ones', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'reveric-r2-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexPath = join(dir, 'index.json');
  await writeFile(indexPath, '{"schemaVersion":1,"plugins":[]}\n');

  const zipBytes = Buffer.from('fake-zip-archive');
  const existingBytes = Buffer.from('already-in-r2');
  const releases = [
    {
      id: 'reveric.one',
      slug: 'one',
      version: '1.0.0',
      asset: 'reveric.one-1.0.0.zip',
      url: 'https://github.com/looplj/reveric-plugins/releases/download/one%2Fv1.0.0/reveric.one-1.0.0.zip',
      size: existingBytes.length,
      sha256: sha256(existingBytes),
    },
    {
      id: 'reveric.two',
      slug: 'two',
      version: '1.0.1',
      asset: 'reveric.two-1.0.1.zip',
      url: 'https://github.com/looplj/reveric-plugins/releases/download/two%2Fv1.0.1/reveric.two-1.0.1.zip',
      size: zipBytes.length,
      sha256: sha256(zipBytes),
    },
  ];

  const uploaded = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'HEAD' && url.includes('/one/v1.0.0/')) {
      return new Response(null, { status: 200, headers: { 'content-length': String(existingBytes.length) } });
    }
    if (init.method === 'HEAD') {
      return new Response(null, { status: 404 });
    }
    if (url === releases[1].url) {
      return new Response(zipBytes, { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await syncToR2({
    releases,
    indexPath,
    fetchImpl,
    putObject: ({ key, contentType }) => uploaded.push({ key, contentType }),
  });

  assert.deepEqual(result, { uploadedArchives: 1, totalReleases: 2 });
  assert.deepEqual(uploaded, [
    { key: 'plugins/two/v1.0.1/reveric.two-1.0.1.zip', contentType: 'application/zip' },
    { key: 'plugins/index.json', contentType: 'application/json' },
  ]);
});

test('syncToR2 refuses to update index.json when downloaded release asset hash mismatches', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'reveric-r2-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexPath = join(dir, 'index.json');
  await writeFile(indexPath, '{"schemaVersion":1,"plugins":[]}\n');

  const bytes = Buffer.from('corrupt');
  const uploaded = [];
  await assert.rejects(
    syncToR2({
      releases: [{
        id: 'reveric.bad',
        slug: 'bad',
        version: '1.0.0',
        asset: 'reveric.bad-1.0.0.zip',
        url: 'https://github.com/looplj/reveric-plugins/releases/download/bad%2Fv1.0.0/reveric.bad-1.0.0.zip',
        size: bytes.length,
        sha256: 'f'.repeat(64),
      }],
      indexPath,
      fetchImpl: async (_url, init = {}) => (init.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : new Response(bytes, { status: 200 })),
      putObject: ({ key }) => uploaded.push(key),
    }),
    /SHA-256 mismatch/,
  );
  assert.deepEqual(uploaded, []);
});

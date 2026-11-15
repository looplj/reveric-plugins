import semver from 'semver';

const marker = /<!-- reveric-publish:(\{[^\n]+\}) -->/;
export const releaseBody = (metadata) => `Automated plugin release from ${metadata.sourceCommit}.\n\n<!-- reveric-publish:${JSON.stringify(metadata)} -->`;
export const releaseMarker = (release) => {
  const match = marker.exec(release.body ?? '');
  return match ? JSON.parse(match[1]) : null;
};

export class GitHub {
  constructor(repository, token, fetcher = fetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Set GITHUB_REPOSITORY to owner/repository');
    this.repository = repository;
    this.token = token;
    this.fetch = fetcher;
    this.base = `https://api.github.com/repos/${repository}`;
  }

  async request(path, { method = 'GET', body, raw = false, contentType } = {}) {
    const url = path.startsWith('https://') ? path : `${this.base}${path}`;
    if (!['api.github.com', 'uploads.github.com'].includes(new URL(url).hostname)) throw new Error('Unexpected GitHub API host');
    const response = await this.fetch(url, {
      method,
      signal: AbortSignal.timeout(120_000),
      headers: {
        Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': contentType ?? 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: contentType ? body : JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${new URL(url).pathname}: ${response.status} ${await response.text()}`);
    if (response.status === 204) return null;
    return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  async listReleases() {
    const releases = [];
    for (let page = 1; ; page++) {
      const batch = await this.request(`/releases?per_page=100&page=${page}`);
      releases.push(...batch);
      if (batch.length < 100) return releases;
    }
  }

  async published(releases) {
    const result = [];
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/v\d+\.\d+\.\d+$/.test(release.tag_name)) continue;
      const asset = release.assets.find(a => a.name === 'release.json');
      if (!asset || asset.size > 256 * 1024 || asset.state !== 'uploaded') throw new Error(`Missing/invalid release.json: ${release.tag_name}`);
      const data = JSON.parse((await this.request(`/releases/assets/${asset.id}`, { raw: true })).toString('utf8'));
      validateRelease(data, release, this.repository);
      result.push(data);
    }
    return result;
  }

  async upload(release, name, bytes, contentType) {
    // Only unpublished drafts may be repaired. Published bytes never change.
    if (!release.draft) throw new Error('Cannot replace assets on a published release');
    for (const asset of release.assets.filter(a => a.name === name)) {
      await this.request(`/releases/assets/${asset.id}`, { method: 'DELETE' });
    }
    const url = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`;
    return this.request(url, { method: 'POST', body: bytes, contentType });
  }
}

export function validateRelease(data, release, repository) {
  const zip = release.assets.find(a => a.name === data.asset);
  const expectedUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${data.asset}`;
  const actualUrl = zip?.browser_download_url;
  if (data.schemaVersion !== 1 || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(data.id ?? '')
    || !semver.valid(data.version) || semver.prerelease(data.version)
    || release.tag_name !== `${data.slug}/v${data.version}`
    || data.asset !== `${data.id}-${data.version}.zip`
    || data.repository !== `https://github.com/${repository}`
    || typeof data.releaseUrl !== 'string' || decodeURIComponent(data.releaseUrl) !== decodeURIComponent(release.html_url)
    || !zip || zip.state !== 'uploaded' || zip.size !== data.size
    || !Number.isSafeInteger(data.size) || data.size <= 0 || data.size > 10 * 1024 * 1024
    || !actualUrl || typeof data.url !== 'string' || decodeURIComponent(actualUrl) !== decodeURIComponent(data.url)
    || decodeURIComponent(actualUrl) !== decodeURIComponent(expectedUrl)
    || !/^[a-f0-9]{64}$/.test(data.sha256 ?? '')
    || (zip.digest && zip.digest !== `sha256:${data.sha256}`)
    || !/^[a-f0-9]{64}$/.test(data.inputHash ?? '')
    || !/^[a-f0-9]{40}$/.test(data.sourceCommit ?? '')
    || !semver.validRange(data.pluginApiVersion)
    || !Array.isArray(data.platforms) || !data.platforms.length
    || data.platforms.some(p => !['windows', 'macos', 'android'].includes(p))
    || !(typeof data.name === 'string' || (data.name && typeof data.name === 'object'))) {
    throw new Error(`Invalid published metadata: ${release.tag_name}`);
  }
}

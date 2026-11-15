import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { discover, affectedPlugins, plan, buildIndex, DEFAULT_CDN_ORIGIN } from './catalog.mjs';
import { GitHub } from './github.mjs';
import { checkPlugin, publishTask, writeIndex } from './publisher.mjs';
import { DEFAULT_R2_BUCKET, syncToR2 } from './r2.mjs';

const root = process.cwd();
const [command, ...args] = process.argv.slice(2);
const github = () => new GitHub(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN);
const git = (...values) => execFileSync('git', values, { cwd: root, encoding: 'utf8' }).trim();

async function main() {
  if (command === 'discover') {
    const plugins = await discover(root);
    const base = process.env.DIFF_BASE;
    const changed = base ? execFileSync('git', ['diff', '--name-only', '-z', base, 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean) : null;
    const selected = changed ? affectedPlugins(plugins, changed) : plugins;
    const result = { plugins: selected.map(p => p.slug), count: selected.length };
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `plugins=${JSON.stringify(result.plugins)}\ncount=${result.count}\n`);
    }
    return;
  }
  if (command === 'check') {
    let plugins = await discover(root);
    if (args.length) {
      if (args.length !== 1 || !plugins.some(p => p.slug === args[0])) throw new Error('Unknown plugin directory');
      plugins = plugins.filter(p => p.slug === args[0]);
    }
    for (const plugin of plugins) await checkPlugin(root, plugin);
    console.log(`Checked ${plugins.length} plugin(s).`);
    return;
  }
  if (command === 'plan') {
    const plugins = await discover(root);
    const api = args.includes('--offline') ? null : github();
    const releases = api ? await api.published(await api.listReleases()) : [];
    const tasks = await plan(root, plugins, releases);
    console.log(JSON.stringify(tasks.map(t => ({ plugin: t.slug, id: t.manifest.id, version: t.version, inputHash: t.inputHash })), null, 2));
    return;
  }
  if (command === 'index') {
    const api = github();
    const cdnOrigin = process.env.PLUGIN_CDN_ORIGIN === 'none'
      ? null
      : (process.env.PLUGIN_CDN_ORIGIN || DEFAULT_CDN_ORIGIN);
    const index = buildIndex(await api.published(await api.listReleases()), { cdnOrigin });
    await writeIndex(resolve(root, 'site'), index);
    console.log(`Indexed ${index.plugins.length} published plugin(s).`);
    return;
  }
  if (command === 'sync-r2') {
    if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
      throw new Error('sync-r2 requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
    }
    const cdnOrigin = process.env.PLUGIN_CDN_ORIGIN || DEFAULT_CDN_ORIGIN;
    const bucket = process.env.R2_BUCKET || DEFAULT_R2_BUCKET;
    const api = github();
    const releases = await api.published(await api.listReleases());
    const index = buildIndex(releases, { cdnOrigin });
    const siteDir = resolve(root, 'site');
    await writeIndex(siteDir, index);
    const result = await syncToR2({
      releases,
      indexPath: resolve(siteDir, 'index.json'),
      cdnOrigin,
      bucket,
    });
    console.log(`Synced ${result.uploadedArchives} new archive(s) and index (${result.totalReleases} release(s)) to R2.`);
    return;
  }
  if (command === 'publish') {
    if (!args.includes('--yes') || !process.env.GITHUB_TOKEN) throw new Error('Publishing requires --yes and GITHUB_TOKEN');
    const api = github();
    const releases = await api.listReleases();
    const tasks = await plan(root, await discover(root), await api.published(releases));
    const commit = git('rev-parse', 'HEAD');
    if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Publishing requires a clean checkout');
    const failures = [];
    for (const task of tasks) {
      try {
        const published = await publishTask(root, task, api, releases, commit);
        console.log(`Published ${published.id}@${published.version}`);
      } catch (error) {
        failures.push(task.slug);
        console.error(`${task.slug}: ${error.message}`);
      }
    }
    if (failures.length) throw new Error(`Failed plugins: ${failures.join(', ')}. Successful releases remain published; rerun to retry.`);
    console.log(`Published ${tasks.length} plugin(s).`);
    return;
  }
  throw new Error('Usage: node scripts/cli.mjs discover | check [plugin] | plan [--offline] | index | sync-r2 | publish --yes');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

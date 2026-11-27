import { createHash } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { COLLECTION_MAX_BVS, COLLECTION_MIN_BVS, fetchView } from '../lib/collections.js';
import { mergeCatalog } from '../lib/catalog.js';
import { buildScanPlan, normalizeSources } from '../lib/scan-plan.js';
import { readState, writeState } from '../lib/state.js';
import { HEADFUL_PLAYER_OPTIONS, launchPlayerBrowser, readPlayerPage } from '../lib/video-page.js';

const sourcesPath = process.env.SONG_SEARCH_SOURCES_PATH;
if (!sourcesPath) throw new Error('Set SONG_SEARCH_SOURCES_PATH to the source configuration file');
const directory = resolve(process.env.SONG_SEARCH_STATE_DIR || 'output');
const measure = process.argv.includes('--measure');
const preflight = process.argv.includes('--preflight');
const exportBatch = process.argv.includes('--export');
const headful = process.argv.includes('--headful');
const MAX_WORKERS = 4;

async function mapBounded(items, action) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_WORKERS, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await action(items[index]);
    }
  }));
  return results;
}

async function measuredView(bvid) {
  try {
    const view = (await fetchView(bvid)).stat?.view;
    if (!Number.isInteger(view) || view < 0) throw new Error('缺少有效播放量');
    return { view, at: new Date().toISOString(), error: null };
  } catch (error) {
    return { view: null, at: new Date().toISOString(), error: error.message };
  }
}

async function openBilibiliHomepage(browser) {
  const page = await browser.newPage();
  const receipt = { url: 'https://www.bilibili.com/', httpStatus: null };
  try {
    const response = await page.goto(receipt.url, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    receipt.httpStatus = response?.status() ?? null;
    if (response?.ok()) await page.waitForNetworkIdle({ idleTime: 500, timeout: 2_500 }).catch(() => {});
  } catch (error) {
    receipt.error = error.message;
  } finally {
    await page.close();
  }
  console.log(JSON.stringify({ event: 'browser-homepage', ...receipt }));
  return receipt;
}

async function main() {
  const startedAt = new Date().toISOString();
  const executablePath = process.env.CHROME_PATH;
  if (!executablePath) throw new Error('请设置 CHROME_PATH');
  await access(executablePath);
  await mkdir(directory, { recursive: true });
  const rawConfig = await readFile(sourcesPath);
  const configSha256 = createHash('sha256').update(rawConfig).digest('hex');
  const sources = normalizeSources(JSON.parse(rawConfig.toString('utf8')));
  const entries = [...new Set(sources.filter(source => !source.archived).flatMap(source => source.bvids))];
  const inventory = new Map(await mapBounded(entries, async bvid => {
    try {
      return [bvid, { data: await fetchView(bvid) }];
    } catch (error) {
      return [bvid, { error: error.message }];
    }
  }));
  const { scanned, ranked } = buildScanPlan(sources, inventory);
  for (const result of scanned) {
    console.log(JSON.stringify({ event: 'selection', ...result, members: undefined }));
  }

  const visits = new Map();
  let browserHomepage = null;
  if (ranked.size > 0) {
    const browser = await launchPlayerBrowser(puppeteer, {
      executablePath,
      headless: !headful,
      ...(headful ? HEADFUL_PLAYER_OPTIONS : {})
    });
    try {
      browserHomepage = await openBilibiliHomepage(browser);
      const results = await mapBounded([...ranked], async ([bvid, rankView]) => {
        const before = measure ? await measuredView(bvid) : { view: null, at: null, error: null };
        let page;
        let result;
        try {
          page = await browser.newPage();
          result = await readPlayerPage(page, bvid);
        } catch (error) {
          result = { ok: false, navigationAttempts: 0, error: error.message };
        } finally {
          if (page) await page.close().catch(() => {});
        }
        const { video, ...receipt } = result;
        const visit = {
          ...receipt, bvid, video, rankView, pageView: video?.viewCount ?? null,
          beforeView: before.view, beforeAt: before.at, beforeError: before.error
        };
        console.log(JSON.stringify({ event: 'visit', ...visit, video: undefined, parts: video?.parts.length }));
        return [bvid, visit];
      });
      results.forEach(([bvid, visit]) => visits.set(bvid, visit));
    } finally {
      await browser.close();
    }
  }

  if (measure && visits.size) {
    await wait(30_000);
    for (const visit of visits.values()) {
      const after = await measuredView(visit.bvid);
      visit.afterView = after.view;
      visit.afterAt = after.at;
      visit.afterError = after.error;
      visit.viewDelta = visit.beforeView !== null && after.view !== null ? after.view - visit.beforeView : null;
      console.log(JSON.stringify({
        event: 'measurement', bvid: visit.bvid, beforeView: visit.beforeView,
        afterView: after.view, viewDelta: visit.viewDelta, error: after.error
      }));
    }
  }

  const finishedAt = new Date().toISOString();
  for (const source of scanned) {
    source.ok = source.archived === true || (source.total !== null && source.selected.every(bvid => visits.get(bvid)?.ok));
  }
  const allVisits = [...visits.values()];
  const measurementComplete = !measure || allVisits.every(visit => visit.viewDelta !== null);
  const status = {
    startedAt, finishedAt, preflight, measure, measurementComplete, browserHomepage,
    configSha256, minimumCollectionSize: COLLECTION_MIN_BVS, maximumVideosPerCollection: COLLECTION_MAX_BVS,
    ok: scanned.every(source => source.ok) && measurementComplete,
    sources: scanned.map(({ members, ...source }) => source),
    visits: allVisits.map(({ video, ...visit }) => ({ ...visit, parts: video?.parts.length ?? 0 }))
  };
  if (exportBatch) {
    await writeState(directory, 'batch.json', { status, scanned, visits: allVisits });
  } else if (preflight) {
    await writeState(directory, 'preflight.json', status);
  } else {
    const previous = await readState(directory, 'catalog.json', { updatedAt: null, rows: [] });
    await writeState(directory, 'catalog.json', mergeCatalog(previous, scanned, visits, finishedAt));
    await writeState(directory, 'latest-run.json', status);
  }
  console.log(JSON.stringify({ event: 'finished', ok: status.ok, finishedAt, visits: visits.size, measurementComplete }));
  if (!status.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

import { setTimeout as wait } from 'node:timers/promises';

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const PLAYER_ORIGIN = 'https://player.bilibili.com';
const PLAYER_PATH = '/player.html';
const DETAIL_ORIGIN = 'https://api.bilibili.com';
const DETAIL_PATH = /^\/x\/web-interface\/(?:wbi\/)?view(?:\/detail)?$/;
const DESKTOP_REJECTION_TEXT = [
  '请求被拦截', '请求被阻断', '访问被阻断', '安全验证', '访问过于频繁', '请求过于频繁',
  '异常请求', '非正常访问', '请求被拒绝', '访问受限', '拒绝访问', '请稍后再试',
  '网络环境', '访问环境', '安全风控策略', 'Precondition Failed', 'Request was blocked',
  'Access Denied', 'Too Many Requests'
];

export const HEADFUL_PLAYER_OPTIONS = {
  ignoreDefaultArgs: true,
  args: ['--no-first-run', '--no-default-browser-check', 'about:blank'],
  defaultViewport: null
};

export async function launchPlayerBrowser(puppeteer, options) {
  const launchOptions = { ...options, timeout: 30_000 };
  try {
    return await puppeteer.launch(launchOptions);
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    console.warn('Chrome startup timed out before opening any site page. Retrying once.');
    return puppeteer.launch(launchOptions);
  }
}

export function parseBvid(input) {
  const value = String(input).trim();
  if (BVID_PATTERN.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`无效的 BV 号或 B 站视频链接：${value}`);
  }
  const match = url?.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
  if (url?.protocol !== 'https:' || url.hostname !== 'www.bilibili.com' || !match) {
    throw new Error(`无效的 BV 号或 B 站视频链接：${value}`);
  }
  return match[1];
}

export function normalizeVideo(video, expectedBvid) {
  if (!video || video.bvid !== expectedBvid) {
    throw new Error('页面结构化数据的 BV 与请求不一致');
  }
  const title = String(video.title ?? '').trim();
  const pages = video.pages;
  if (!title || !Array.isArray(pages) || !pages.length
    || !Number.isInteger(video.videos) || video.videos !== pages.length) {
    throw new Error('页面结构缺少标题或完整分 P 列表');
  }
  const parts = pages.map((part, index) => {
    const cid = Number(part?.cid);
    const name = String(part?.part ?? '').trim();
    if (part?.page !== index + 1 || !Number.isSafeInteger(cid) || cid <= 0 || !name) {
      throw new Error(`第 ${index + 1} 个分 P 缺少有效编号、CID 或标题`);
    }
    return { page: part.page, cid, title: name };
  });

  const season = video.ugc_season;
  return {
    bvid: expectedBvid,
    title,
    uploader: video.owner?.name ?? null,
    viewCount: Number.isInteger(video.stat?.view) ? video.stat.view : null,
    season: season?.id ? {
      id: season.id,
      title: season.title ?? null,
      bvids: [...new Set((season.sections ?? [])
        .flatMap(section => (section.episodes ?? []).map(episode => episode.bvid))
        .filter(bvid => BVID_PATTERN.test(bvid)))]
    } : null,
    parts
  };
}

export const PLAYBACK_METHOD = 'played-range';

function observedPlaybackSeconds(minimum = 0) {
  let longestRange = 0;
  for (const player of document.querySelectorAll('video, bwp-video')) {
    const played = player.played;
    for (let index = 0; index < (played?.length ?? 0); index += 1) {
      longestRange = Math.max(longestRange, played.end(index) - played.start(index));
    }
  }
  return minimum > 0 ? longestRange >= minimum : longestRange;
}

export async function readPlayerPage(page, bvid) {
  if (!BVID_PATTERN.test(bvid)) throw new Error('无效的 BV 号');
  const url = `${PLAYER_ORIGIN}${PLAYER_PATH}?bvid=${bvid}`;
  const receipt = {
    url, navigationAttempts: 1, httpStatus: null, visitedAt: null,
    metadataHttpStatus: null, metadataResponses: [], playbackMethod: PLAYBACK_METHOD, playbackSeconds: null
  };
  let acceptVideo;
  const playerVideo = new Promise(resolve => { acceptVideo = resolve; });
  let metadataError;
  let accepted = false;

  // Read the detail response the player requests during normal page loading.
  const observeDetail = async response => {
    const address = new URL(response.url());
    if (address.origin !== DETAIL_ORIGIN || !DETAIL_PATH.test(address.pathname)) return;
    const status = response.status();
    receipt.metadataResponses.push({ path: address.pathname, httpStatus: status });
    if (accepted) return;
    receipt.metadataHttpStatus = status;
    try {
      if (!response.ok()) throw new Error(`播放器数据 HTTP ${status}`);
      const payload = await response.json();
      const video = payload.data?.View ?? payload.data;
      if (payload.code !== 0 || !video || !Number.isInteger(video.videos)) {
        throw new Error('播放器未提供可核对总数的分 P 数据');
      }
      const verified = normalizeVideo(video, bvid);
      if (!accepted) {
        accepted = true;
        receipt.metadataHttpStatus = status;
        acceptVideo(verified);
      }
    } catch (error) {
      metadataError = error.message;
    }
  };

  page.on('response', observeDetail);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    receipt.httpStatus = response?.status() ?? null;
    if (!response?.ok()) throw new Error(`播放器网页 HTTP ${receipt.httpStatus ?? '无响应'}`);
    const location = new URL(page.url());
    if (location.origin !== PLAYER_ORIGIN || location.pathname !== PLAYER_PATH
      || location.searchParams.get('bvid') !== bvid) throw new Error('未打开指定稿件的官方播放器');
    receipt.visitedAt = new Date().toISOString();

    const [video, playbackSeconds] = await Promise.all([
      Promise.race([playerVideo, wait(15_000, null, { ref: false })]),
      page.waitForFunction(observedPlaybackSeconds, { timeout: 15_000 }, 5)
        .catch(() => null)
        .then(() => page.evaluate(observedPlaybackSeconds).catch(() => null))
    ]);
    receipt.playbackSeconds = playbackSeconds;
    if (!video) throw new Error(metadataError || '播放器未加载完整分 P 数据');
    return { ...receipt, ok: true, video };
  } catch (error) {
    return { ...receipt, ok: false, bvid, error: error.message };
  } finally {
    page.off('response', observeDetail);
  }
}

export async function readVideoPage(page, bvid, { compareHeaders = false, chromeDetails = true } = {}) {
  if (!BVID_PATTERN.test(bvid)) throw new Error('无效的 BV 号');
  const url = `https://www.bilibili.com/video/${bvid}/`;
  const receipt = { url, navigationAttempts: 1, httpStatus: null, visitedAt: null };

  try {
    const navigation = { waitUntil: 'domcontentloaded', timeout: 25_000 };
    if (compareHeaders) {
      await page.setExtraHTTPHeaders({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' });
      navigation.referer = 'https://www.bilibili.com/';
    }
    const response = await page.goto(url, navigation);
    receipt.httpStatus = response?.status() ?? null;
    const responseHeaders = response?.headers();
    if (response) {
      const finalUrl = new URL(response.url());
      const request = response.request();
      receipt.navigation = {
        responseUrl: finalUrl.origin + finalUrl.pathname,
        resourceType: chromeDetails ? request.resourceType() : null,
        isNavigation: request.isNavigationRequest(),
        contentType: responseHeaders['content-type'] ?? null
      };
    }
    if (receipt.httpStatus === 412) {
      const security = chromeDetails ? response.securityDetails() : null;
      const retryAfter = responseHeaders['retry-after']?.trim() ?? '';
      const [body, visibleSignals] = await Promise.all([
        response.text().catch(() => null),
        page.evaluate(phrases => {
          const text = document.body?.innerText.replace(/\s+/g, ' ') ?? '';
          return phrases.filter(phrase => text.toLowerCase().includes(phrase.toLowerCase()));
        }, DESKTOP_REJECTION_TEXT).catch(() => null)
      ]);
      receipt.rejection = {
        tls: security ? { issuer: security.issuer(), protocol: security.protocol() } : null,
        fromCache: response.fromCache(),
        fromServiceWorker: chromeDetails ? response.fromServiceWorker() : null,
        retryAfter: /^(?:\d{1,12}|[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)$/.test(retryAfter)
          ? retryAfter : null,
        bodyRead: body !== null,
        title: body?.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1].trim() ?? null,
        signals: DESKTOP_REJECTION_TEXT.filter(signal => body?.includes(signal)),
        visibleSignals
      };
    }
    if (!response?.ok()) throw new Error(`视频页 HTTP ${receipt.httpStatus ?? '无响应'}`);
    receipt.visitedAt = new Date().toISOString();
    if (parseBvid(page.url()) !== bvid) throw new Error('视频页已重定向到其他稿件');
    try {
      await page.waitForFunction(
        wantedBvid => {
          const video = globalThis.__INITIAL_STATE__?.videoData;
          return video?.bvid === wantedBvid && Array.isArray(video.pages) && video.pages.length > 0;
        },
        { timeout: 10_000 },
        bvid
      );
    } catch (error) {
      const state = await page.evaluate(() => {
        const state = globalThis.__INITIAL_STATE__;
        return {
          hasState: !!state,
          bvid: state?.videoData?.bvid ?? null,
          pages: Array.isArray(state?.videoData?.pages) ? state.videoData.pages.length : null,
          code: state?.error?.code ?? null
        };
      }).catch(() => null);
      throw new Error(`${error.message}（页面结构：${JSON.stringify(state)}）`, { cause: error });
    }
    const video = await page.evaluate(() => globalThis.__INITIAL_STATE__?.videoData);
    return { ...receipt, ok: true, video: normalizeVideo(video, bvid) };
  } catch (error) {
    return { ...receipt, ok: false, bvid, error: error.message };
  }
}

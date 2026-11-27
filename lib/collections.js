import { parseBvid } from './video-page.js';

export const COLLECTION_MIN_BVS = 10;
export const COLLECTION_MAX_BVS = 6;

export async function fetchView(bvid, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: 'https://www.bilibili.com',
      Referer: `https://www.bilibili.com/video/${bvid}`
    },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`B 站元数据 HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== 0 || result.data?.bvid !== bvid) {
    throw new Error(`B 站元数据无法核对 ${bvid}（code=${result.code}）`);
  }
  return result.data;
}

export function readCollectionMetadata(data, expectedSeasonId) {
  const season = data.ugc_season;
  const entryBvid = parseBvid(data.bvid);
  if (!season && expectedSeasonId === undefined) {
    return { key: `bvid:${entryBvid}`, seasonId: null, title: data.title ?? null,
      candidates: [{ bvid: entryBvid, view: data.stat?.view ?? 0 }], sections: [] };
  }
  if (!Number.isSafeInteger(season?.id) || season.id <= 0 || !Array.isArray(season.sections)
    || (expectedSeasonId !== undefined && season.id !== expectedSeasonId)) {
    throw new Error(expectedSeasonId === undefined ? '合集 ID 或分节无法核对' : `合集 ID 无法核对（预期 ${expectedSeasonId}）`);
  }
  if (!season.sections.every(section => Array.isArray(section.episodes))) {
    throw new Error('合集分节元数据不完整');
  }
  const sections = season.sections.map(({ id, title, episodes }) => ({
    id: id ?? null,
    title: title ?? null,
    episodes: episodes.map(episode => ({ bvid: parseBvid(episode.bvid), view: episode.arc?.stat?.view }))
  }));
  const episodes = sections.flatMap(section => section.episodes);
  const byVideo = new Map();
  for (const { bvid, view } of episodes) {
    if (!Number.isInteger(view) || view < 0) throw new Error(`稿件 ${bvid} 缺少有效播放量`);
    if (byVideo.has(bvid) && byVideo.get(bvid) !== view) {
      throw new Error(`稿件 ${bvid} 的合集播放量不一致`);
    }
    byVideo.set(bvid, view);
  }
  if (!byVideo.has(entryBvid) || (Number.isInteger(season.ep_count)
    && season.ep_count !== episodes.length && season.ep_count !== byVideo.size)) {
    throw new Error('合集成员元数据不完整');
  }
  const candidates = [...byVideo].map(([bvid, view]) => ({ bvid, view }));
  candidates.sort((a, b) => a.view - b.view || a.bvid.localeCompare(b.bvid, 'en'));
  return {
    key: `season:${season.id}`, seasonId: season.id, title: season.title ?? null, candidates,
    sections: sections.map(({ id, title, episodes }) => ({ id, title,
      members: [...new Set(episodes.map(({ bvid }) => bvid))] }))
  };
}

export function pickCollection(data, expectedSeasonId) {
  const { candidates, sections } = readCollectionMetadata(data, expectedSeasonId);
  const selected = candidates.length < COLLECTION_MIN_BVS ? [] : candidates.slice(0, COLLECTION_MAX_BVS);
  const selectedBvids = new Set(selected.map(({ bvid }) => bvid));
  return {
    members: candidates.map(({ bvid }) => bvid),
    selected,
    sections: sections.map(({ id, title, members }) => ({ id, title, candidates: members.length,
      selected: members.filter(bvid => selectedBvids.has(bvid)) }))
  };
}

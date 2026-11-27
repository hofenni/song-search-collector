import { COLLECTION_MAX_BVS, COLLECTION_MIN_BVS, readCollectionMetadata } from './collections.js';
import { parseBvid } from './video-page.js';

function normalizedTitles(...values) {
  return new Set(values.flat(Infinity).filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean));
}

export function normalizeSources(configs) {
  if (!Array.isArray(configs)) throw new Error('来源配置必须是数组');
  const ids = new Set();
  return configs.map(config => {
    const uniqueBvids = new Map();
    for (const bvid of (config.bvids ?? []).map(parseBvid)) {
      const key = bvid.toLowerCase();
      if (!uniqueBvids.has(key)) uniqueBvids.set(key, bvid);
    }
    const bvids = [...uniqueBvids.values()];
    const archived = config.archived === true || config.skipUpdate === true || config.frozen === true;
    const label = config.alias || config.file || bvids[0] || 'unknown';
    const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const id = config.file || slug || (bvids[0] || 'source').toLowerCase();
    if (ids.has(id)) throw new Error(`重复来源 ID：${id}`);
    if (!archived && !bvids.length) throw new Error(`来源没有入口 BV：${label}`);
    ids.add(id);
    return { id, label, bvids, archived, archiveReason: config.archiveReason,
      include: normalizedTitles(config.sectionTitle, config.sectionTitles),
      exclude: normalizedTitles(config.excludeSectionTitle, config.excludeSectionTitles),
      excludedBvids: new Set((config.excludeBvids ?? []).map(parseBvid).map(bvid => bvid.toLowerCase())) };
  });
}

function eligibleForSource(collection, source) {
  const title = section => String(section.title ?? '').trim();
  const titles = new Set(collection.sections.map(title));
  const missing = [...source.include].filter(name => !titles.has(name));
  if (missing.length) throw new Error(`缺少配置小节：${missing.join('、')}`);

  const permitsBvid = bvid => !source.excludedBvids.has(bvid.toLowerCase());
  const sections = collection.sections.filter(section =>
    (!source.include.size || source.include.has(title(section))) && !source.exclude.has(title(section)))
    .map(section => ({ ...section, members: section.members.filter(permitsBvid) }));
  const members = new Set(collection.seasonId === null
    ? collection.candidates.map(({ bvid }) => bvid).filter(permitsBvid)
    : sections.flatMap(section => section.members));
  return { members, sections };
}

export function buildScanPlan(sources, inventory) {
  const byEntry = new Map();
  const groups = new Map();
  for (const [entry, receipt] of inventory) {
    try {
      if (!receipt.data) throw new Error(receipt.error || '缺少入口元数据');
      const collection = readCollectionMetadata(receipt.data);
      if (!groups.has(collection.key)) groups.set(collection.key, { collection, eligible: new Set(), selected: [] });
      byEntry.set(entry, { key: collection.key });
    } catch (error) {
      byEntry.set(entry, { error: error.message });
    }
  }

  const assignments = new Map();
  const scanned = sources.map(source => {
    const result = { id: source.id, label: source.label, entries: source.bvids, total: null,
      members: [], selected: [], sections: [], groups: [], ok: false };
    if (source.archived) return { ...result, state: 'archived', archived: true, archiveReason: source.archiveReason };

    try {
      const matches = new Map();
      for (const entry of source.bvids) {
        const match = byEntry.get(entry);
        if (!match?.key) throw new Error(`${entry}：${match?.error || '缺少入口回执'}`);
        if (matches.has(match.key)) continue;
        const group = groups.get(match.key);
        matches.set(match.key, { group, ...eligibleForSource(group.collection, source) });
      }
      assignments.set(source.id, matches);
      for (const { group, members } of matches.values()) {
        for (const bvid of members) group.eligible.add(bvid);
      }
    } catch (error) {
      result.state = 'selection-error';
      result.error = error.message;
    }
    return result;
  });

  const ranked = new Map();
  for (const group of groups.values()) {
    const { candidates } = group.collection;
    if (candidates.length < COLLECTION_MIN_BVS) continue;
    group.selected = candidates.filter(({ bvid }) => group.eligible.has(bvid)).slice(0, COLLECTION_MAX_BVS);
    for (const { bvid, view } of group.selected) ranked.set(bvid, view);
  }

  for (const source of scanned) {
    const matches = assignments.get(source.id);
    if (!matches) continue;
    const members = new Set();
    const selected = new Set();
    for (const [key, match] of matches) {
      const { collection, selected: groupSelected } = match.group;
      const sourceSelection = groupSelected.map(({ bvid }) => bvid).filter(bvid => match.members.has(bvid));
      const selectionSet = new Set(sourceSelection);
      sourceSelection.forEach(bvid => selected.add(bvid));
      for (const { bvid } of collection.candidates) {
        if (match.members.has(bvid)) members.add(bvid);
      }
      source.groups.push({ key, seasonId: collection.seasonId, title: collection.title,
        total: collection.candidates.length, candidates: match.members.size, selected: sourceSelection });
      source.sections.push(...match.sections.map(({ id, title, members }) => ({ groupKey: key, id, title,
        candidates: members.length, selected: members.filter(bvid => selectionSet.has(bvid)) })));
    }
    source.total = members.size;
    source.members = [...members];
    source.selected = [...selected];
    source.state = selected.size ? 'selected'
      : source.groups.every(group => group.total < COLLECTION_MIN_BVS) ? 'below-threshold' : 'not-selected';
  }
  return { scanned, ranked };
}

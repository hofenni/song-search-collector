export function partRows(sourceId, video) {
  return video.parts.map(part => {
    const title = part.title.trim();
    const matches = [...title.matchAll(/\s+[-－–—]\s+/gu)];
    const separator = matches.at(-1);
    const fields = separator
      ? [title.slice(0, separator.index).trim(), title.slice(separator.index + separator[0].length).trim()]
      : null;
    return {
      sourceId,
      title: fields?.[0] || title,
      artist: fields?.[1] || '',
      rawTitle: part.title,
      videoTitle: video.title,
      bvid: video.bvid,
      page: part.page,
      cid: part.cid,
      url: `https://www.bilibili.com/video/${video.bvid}/?p=${part.page}`
    };
  });
}

export function mergeCatalog(previous, scanned, visits, finishedAt) {
  const rows = [...previous.rows];
  let hasPublished = false;
  for (const source of scanned) {
    if (source.total === null) continue;
    const selected = new Set(source.selected.filter(bvid => visits.get(bvid)?.ok));
    if (selected.size > 0) hasPublished = true;
    const members = new Set(source.members);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.sourceId === source.id && (selected.has(row.bvid) || !members.has(row.bvid))) {
        rows.splice(index, 1);
        hasPublished = true;
      }
    }
    for (const bvid of selected) rows.push(...partRows(source.id, visits.get(bvid).video));
  }
  return {
    updatedAt: hasPublished ? finishedAt : previous.updatedAt,
    sources: scanned.map(({ id, label }) => ({ id, label })),
    rows
  };
}

'use strict';

function makeSalesArea({ id = null, label, available = false, source = null }) {
  return {
    id: id == null ? null : String(id),
    label: String(label).trim(),
    available: Boolean(available),
    source,
  };
}

function mergeSalesAreas(areas) {
  const merged = new Map();

  for (const area of areas) {
    if (!area?.label) continue;
    const key = area.label.trim();
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, area);
      continue;
    }

    merged.set(key, {
      ...previous,
      ...area,
      id: area.id ?? previous.id,
      available: previous.available || area.available,
      source: area.available ? area.source : previous.source,
    });
  }

  return [...merged.values()];
}

module.exports = { makeSalesArea, mergeSalesAreas };

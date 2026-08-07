'use strict';

function areaComponents(value) {
  return [...new Set(String(value || '').match(/\d+/g) || [])]
    .sort((left, right) => Number(left) - Number(right));
}

function normalizeAreaLabel(value) {
  const components = areaComponents(value);
  return components.length ? components.join(',') : String(value || '').trim();
}

function makeSalesArea({ id = null, label, available = false, source = 'manual' }) {
  const normalized = normalizeAreaLabel(label);
  return {
    id: id == null ? null : String(id),
    label: normalized,
    components: areaComponents(normalized),
    available: Boolean(available),
    source,
  };
}

function mergeSalesAreas(areas) {
  const merged = [];
  for (const input of areas) {
    const area = makeSalesArea(input);
    if (!area.label) continue;

    const existing = merged.find(candidate =>
      (area.id && candidate.id === area.id) || candidate.label === area.label
    );
    if (!existing) {
      merged.push(area);
      continue;
    }

    existing.available ||= area.available;
    existing.id ||= area.id;
    if (existing.source !== 'dom' && area.source === 'dom') existing.source = 'dom';
  }
  return merged;
}

function resolveAreaTarget(target, areas) {
  const label = normalizeAreaLabel(target);
  const exact = areas.find(area => area.label === label);
  if (exact) return exact;

  const components = areaComponents(label);
  if (!components.length) return null;
  const matches = areas.filter(area =>
    components.every(component => area.components.includes(component))
  );
  return matches.length === 1 ? matches[0] : null;
}

module.exports = {
  normalizeAreaLabel,
  areaComponents,
  makeSalesArea,
  mergeSalesAreas,
  resolveAreaTarget,
};

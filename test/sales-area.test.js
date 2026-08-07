'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAreaLabel,
  areaComponents,
  makeSalesArea,
  mergeSalesAreas,
  resolveAreaTarget,
} = require('../bot/sales-area');

test('normalizes one combined sales area without splitting its purchase identity', () => {
  assert.equal(normalizeAreaLabel(' 24 / 22 '), '22,24');
  assert.deepEqual(areaComponents('22,24'), ['22', '24']);
  assert.deepEqual(makeSalesArea({ id: 900, label: '24, 22', available: true, source: 'dom' }), {
    id: '900',
    label: '22,24',
    components: ['22', '24'],
    available: true,
    source: 'dom',
  });
});

test('preserves a non-numeric named sales area', () => {
  assert.equal(normalizeAreaLabel(' VIP '), 'VIP');
  assert.deepEqual(areaComponents('VIP'), []);
});

test('merges map and DOM records into one available canonical area', () => {
  assert.deepEqual(mergeSalesAreas([
    makeSalesArea({ label: '22,24', available: false, source: 'svg' }),
    makeSalesArea({ id: '900', label: '24 / 22', available: true, source: 'dom' }),
  ]), [{
    id: '900',
    label: '22,24',
    components: ['22', '24'],
    available: true,
    source: 'dom',
  }]);
});

test('resolves a component or reordered manual target to one canonical area', () => {
  const areas = [makeSalesArea({ id: 900, label: '22,24', available: false, source: 'svg' })];
  assert.equal(resolveAreaTarget('22', areas).label, '22,24');
  assert.equal(resolveAreaTarget('24', areas).label, '22,24');
  assert.equal(resolveAreaTarget('24,22', areas).label, '22,24');
});

test('does not guess when a manual target is absent from the map', () => {
  const areas = [makeSalesArea({ id: 900, label: '22,24', available: false, source: 'svg' })];
  assert.equal(resolveAreaTarget('31', areas), null);
});

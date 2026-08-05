'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('deployment requires Node 24 for node:sqlite', () => {
  assert.equal(pkg.engines?.node, '>=24');
});

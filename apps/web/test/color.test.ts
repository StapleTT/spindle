import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexToHsl, hslToHex, isHexColor } from '../src/color.js';

test('custom account colors preserve RGB across hue boundaries, grays and extremes', () => {
  for (const hex of [
    '#000000',
    '#ffffff',
    '#808080',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#ffff00',
    '#00ffff',
    '#ff00ff',
    '#3e56c2',
    '#c85a3c',
    '#123456',
  ]) {
    assert.equal(hslToHex(hexToHsl(hex)), hex);
  }
  assert.equal(hslToHex([359, 100, 50]), '#ff0004');
  for (const hex of [
    'red',
    '#fff',
    '#fffffff',
    'url(https://example.test)',
    '#12345g',
    '',
  ]) {
    assert.equal(isHexColor(hex), false);
    assert.throws(() => hexToHsl(hex));
  }
});

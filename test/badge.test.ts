import assert from 'node:assert/strict';
import { test } from 'vitest';
import { badgeFor } from '../src/badge';

test('the spec badge code APPROVED shows as verified', () => {
  assert.equal(badgeFor('APPROVED')?.label, '인증됨');
});

test('suspected and unverified codes map to their own badges regardless of case', () => {
  assert.equal(badgeFor('suspected')?.tone, 'suspected');
  assert.equal(badgeFor('NONE')?.tone, 'unverified');
});

test('a missing or unknown code shows no badge instead of a guessed one', () => {
  assert.equal(badgeFor(undefined), null);
  assert.equal(badgeFor(null), null);
  assert.equal(badgeFor(''), null);
  assert.equal(badgeFor('SOMETHING_NEW'), null);
});

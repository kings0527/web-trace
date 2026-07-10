import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/mcp/tools/dom-inspection.ts', import.meta.url),
  'utf8',
);

function visibilityPredicateBodies() {
  return Array.from(
    source.matchAll(/function visible\(el: Element\): boolean \{([\s\S]*?)\n      \}/g),
    (match) => match[1],
  );
}

test('DOM visibility predicates reject zero-size elements and hidden ancestors', () => {
  const predicates = visibilityPredicateBodies();

  assert.equal(predicates.length, 2, 'snapshot and query DOM should share the visibility rules');

  for (const predicate of predicates) {
    assert.doesNotMatch(predicate, /textOf\(el\)/, 'text content must not make a zero-size element visible');
    assert.match(predicate, /for \(let current: Element \| null = el;/);
    assert.match(predicate, /current = current\.parentElement/);
    assert.match(predicate, /style\.display === 'none'/);
    assert.match(predicate, /style\.visibility === 'hidden'/);
    assert.match(predicate, /Number\.parseFloat\(style\.opacity\) === 0/);
    assert.match(predicate, /rect\.width > 0 && rect\.height > 0/);
  }
});

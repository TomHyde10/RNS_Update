// The frontend has no framework and no build step, so the one failure it can
// have silently is a reference to an element that isn't on the page: init()
// throws on the first missing id and nothing renders at all. This walks the
// two files against each other instead, which costs nothing and catches it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('every element app.js looks up exists in index.html', () => {
  const html = read('index.html');
  const app = read('app.js');

  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];

  assert.ok(referenced.length > 0, 'expected app.js to look elements up by id');
  const missing = referenced.filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `app.js references ids that are not in the page: ${missing.join(', ')}`);
});

test('the id-scoped selectors app.js uses point at tables that exist', () => {
  const html = read('index.html');
  const app = read('app.js');

  const scoped = [...new Set([...app.matchAll(/querySelectorAll?\('#([a-z-]+)[^']*'\)/g)].map((m) => m[1]))];
  for (const id of scoped) {
    assert.match(html, new RegExp(`id="${id}"`), `selector uses #${id}, which is not in the page`);
  }
});

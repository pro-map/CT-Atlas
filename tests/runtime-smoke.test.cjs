const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const expected = JSON.parse(fs.readFileSync('ct-atlas-runtime.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/live-smoke.yml', 'utf8');
const script = workflow.match(/node - <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/)[1];

function check(runtime) {
  const files = {
    '/tmp/runtime.json': JSON.stringify(runtime),
    'ct-atlas-runtime.json': JSON.stringify(expected),
    '/tmp/quiz.json': JSON.stringify({options: ['A', 'B', 'C'], correct_index: 0}),
    '/tmp/index.html': fs.readFileSync('index.html', 'utf8'),
    '/tmp/pdf-export.js': fs.readFileSync('pdf-export.js', 'utf8'),
  };
  const context = vm.createContext({
    require: name => {
      assert.equal(name, 'fs');
      return {readFileSync: path => {
        assert.ok(Object.hasOwn(files, path), 'Unexpected smoke fixture: ' + path);
        return files[path];
      }};
    }, console: {log() {}},
  });
  vm.runInContext(script, context, {timeout: 1000});
}

test('live smoke accepts the canonical language list including Chinese variants', () => {
  assert.ok(expected.language_codes.includes('zh'));
  check(structuredClone(expected));
});

test('live smoke rejects missing languages and same-length language substitution', () => {
  const missing = structuredClone(expected);
  missing.language_codes = missing.language_codes.slice(0, 12);
  assert.throws(() => check(missing), /Runtime language drift/);
  const changed = structuredClone(expected);
  changed.language_codes[0] = 'invalid';
  assert.throws(() => check(changed), /Runtime language drift/);
});

test('live smoke still rejects threshold drift', () => {
  assert.throws(() => check({...expected, ai_selection_threshold: -1}), /Runtime threshold drift/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const pkgUrl = new URL('../package.json', import.meta.url);
const clientUrl = new URL('../client.js', import.meta.url);

test('package exposes the web client half', async () => {
  const pkg = JSON.parse(await readFile(pkgUrl, 'utf8'));
  assert.equal(pkg.exports['./client'], './client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.ok(pkg.files.includes('client.js'));
});

test('client registers a module and keeps the auto-fill contract', async () => {
  const source = await readFile(clientUrl, 'utf8');
  assert.match(source, /__ModuleLoader__\.load\(/);
  assert.match(source, /id: MODULE_ID/);
  assert.match(source, /data-fastload-autoloaded/);
  assert.match(source, /data-step-process-content/);
  assert.match(source, /conversation\.chat\.flow/);
  assert.match(source, /beginPaging|加载更早|Load older|olderButtonOf/);
});


const readmeZhUrl = new URL('../README.md', import.meta.url);
const readmeEnUrl = new URL('../README.en.md', import.meta.url);

// DSH_FASTLOAD_ENABLED=0 only turns off the host half; the web client still
// fills one page after the first paint. Both READMEs must scope the switch
// that way instead of promising a total disable (audit FL-02).
test('READMEs scope DSH_FASTLOAD_ENABLED=0 to the host half', async () => {
  const zh = await readFile(readmeZhUrl, 'utf8');
  const en = await readFile(readmeEnUrl, 'utf8');
  const rowOf = (source) =>
    source.split('\n').find((line) => line.startsWith('| `DSH_FASTLOAD_ENABLED`'));
  const zhRow = rowOf(zh);
  const enRow = rowOf(en);
  assert.ok(zhRow, 'Chinese README documents DSH_FASTLOAD_ENABLED');
  assert.ok(enRow, 'English README documents DSH_FASTLOAD_ENABLED');
  assert.match(zhRow, /Host/);
  assert.match(zhRow, /Web/);
  assert.doesNotMatch(zhRow, /完全关闭/);
  assert.match(enRow, /Host/);
  assert.match(enRow, /Web client/);
});

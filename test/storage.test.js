// Direct IssueStore regressions (TEST-API, specs/issue-tracker.md): on-disk
// format, reload across instances, corruption refusal, write serialization and
// store-level write guards. Every test uses an isolated temp directory; no
// live data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueStore, StoreError } from '../src/store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function storePathOf(dir) {
  return join(dir, 'issues.json');
}

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'issue-store-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('create persists a contract-shaped file and list reads newest first', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const first = await store.create({ title: 'First', description: 'one' });
    const second = await store.create({ title: 'Second' });

    assert.match(first.id, UUID);
    assert.deepEqual(
      (await store.list()).map((issue) => issue.id),
      [second.id, first.id],
      'list is newest first',
    );

    const raw = await readFile(storePathOf(dir), 'utf8');
    assert.ok(raw.endsWith('\n'), 'store file ends with a newline');
    const stored = JSON.parse(raw);
    assert.deepEqual(Object.keys(stored), ['issues']);
    assert.equal(stored.issues.length, 2);
    for (const issue of stored.issues) {
      assert.deepEqual(
        Object.keys(issue).sort(),
        ['createdAt', 'description', 'id', 'status', 'title', 'updatedAt'],
      );
    }
    assert.deepEqual(await readdir(dir), ['issues.json'], 'no temp files remain');
  });
});

test('a store reloads its file in a later instance', async () => {
  await withDir(async (dir) => {
    const original = new IssueStore(dir);
    const created = await original.create({ title: 'Kept', description: 'persisted text' });
    await original.update(created.id, { status: 'done' });

    const reloaded = new IssueStore(dir);
    const items = await reloaded.list();
    assert.deepEqual(
      items.map((issue) => ({ id: issue.id, status: issue.status, description: issue.description })),
      [{ id: created.id, status: 'done', description: 'persisted text' }],
    );
  });
});

test('update patches only the given fields; createdAt and id never change', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const created = await store.create({ title: 'Original', description: 'original text' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.update(created.id, { title: 'Renamed' });
    assert.equal(updated.id, created.id);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.title, 'Renamed');
    assert.equal(updated.description, 'original text', 'untouched fields are kept');
    assert.ok(updated.updatedAt > created.updatedAt, 'updatedAt advances');
    assert.equal(await store.update('00000000-0000-4000-8000-000000000000', { title: 'x' }), null);
    const bytes = await readFile(storePathOf(dir), 'utf8');
    assert.equal(JSON.parse(bytes).issues.length, 1, 'the 404 attempt wrote nothing');
  });
});

test('corrupt store files are refused, reported and never rewritten', async () => {
  await withDir(async (dir) => {
    const record = (overrides = {}) =>
      JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Stored item',
        description: '',
        status: 'open',
        createdAt: '2026-02-28T12:34:56Z',
        updatedAt: '2026-02-28T12:34:56Z',
        ...overrides,
      });
    const corruptFiles = [
      ['not json', '{"issues": ['],
      ['extra top-level key', '{"issues": [], "extra": 1}'],
      ['status outside the enum', `{"issues": [${record({ status: 'closed' })}]}`],
      ['duplicate ids', `{"issues": [${record()}, ${record({ title: 'Copy' })}]}`],
      ['non-string field', `{"issues": [${record({ title: 7 })}]}`],
    ];
    for (const [label, content] of corruptFiles) {
      await writeFile(storePathOf(dir), content, 'utf8');
      const store = new IssueStore(dir);
      await assert.rejects(store.list(), (err) => {
        assert.ok(err instanceof StoreError, label);
        assert.equal(err.code, 'STORE_ERROR');
        assert.ok(err.message.includes('Corrupt issue store'), label);
        return true;
      }, label);
      await assert.rejects(store.create({ title: 'Nope' }), StoreError, label);
      assert.equal(await readFile(storePathOf(dir), 'utf8'), content, 'bytes untouched: ' + label);
      const files = await readdir(dir);
      assert.deepEqual(files, ['issues.json'], 'no temp files: ' + label);
    }
  });
});

test('store-level guards reject contract-breaking writes before touching disk', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const created = await store.create({ title: 'Baseline' });
    const before = await readFile(storePathOf(dir), 'utf8');

    const rejections = [
      ['create with a non-contract status', () => store.create({ title: 'Bad status', status: 'closed' })],
      ['create with a non-string title', () => store.create({ title: 42 })],
      ['create with an untrimmed title', () => store.create({ title: ' padded ' })],
      ['create with a whitespace-only title', () => store.create({ title: '   ' })],
      ['create with a 121-character title', () => store.create({ title: 't'.repeat(121) })],
      ['create with a 4001-character description', () => store.create({ title: 'ok', description: 'd'.repeat(4001) })],
      ['update patching id', () => store.update(created.id, { id: '22222222-2222-4222-8222-222222222222' })],
      ['update patching createdAt', () => store.update(created.id, { createdAt: '2020-01-01T00:00:00Z' })],
      ['update with a non-string description', () => store.update(created.id, { description: null })],
      ['update with a non-contract status', () => store.update(created.id, { status: 'later' })],
      ['update with an untrimmed title', () => store.update(created.id, { title: ' padded ' })],
      ['update with a 121-character title', () => store.update(created.id, { title: 'u'.repeat(121) })],
      ['update with a 4001-character description', () => store.update(created.id, { description: 'x'.repeat(4001) })],
      ['update with an empty patch', () => store.update(created.id, {})],
    ];
    for (const [label, attempt] of rejections) {
      await assert.rejects(attempt(), (err) => {
        assert.ok(err instanceof StoreError, label);
        assert.equal(err.code, 'STORE_ERROR', label);
        return true;
      }, label);
    }

    assert.equal(await readFile(storePathOf(dir), 'utf8'), before, 'no rejected write reached the disk');
    assert.deepEqual((await store.list()).map((issue) => issue.title), ['Baseline']);

    // The boundaries the loader accepts stay writable: 120-char title and
    // 4000-char description, on both create and update.
    const boundary = await store.create({ title: 'b'.repeat(120), description: 'y'.repeat(4000) });
    const bumped = await store.update(boundary.id, { title: 'c'.repeat(120), description: 'z'.repeat(4000) });
    assert.equal(bumped.title.length, 120);
    assert.equal(bumped.description.length, 4000);
    const reloaded = new IssueStore(dir);
    assert.equal((await reloaded.list()).length, 2, 'Baseline plus the boundary record reload cleanly');
    const next = await store.create({ title: 'Still works' });
    assert.equal(next.title, 'Still works');
    assert.equal(JSON.parse(await readFile(storePathOf(dir), 'utf8')).issues.length, 3);
  });
});

test('concurrent writes are serialized with nothing lost', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const created = await Promise.all(
      Array.from({ length: 40 }, (_, index) => store.create({ title: 'Item ' + index })),
    );
    assert.equal(new Set(created.map((issue) => issue.id)).size, 40, 'unique ids');

    const patches = await Promise.all(
      Array.from({ length: 15 }, (_, index) => store.update(created[0].id, { description: 'd' + index })),
    );
    assert.ok(patches.every((issue) => issue.id === created[0].id));

    const listed = await store.list();
    assert.equal(listed.length, 40);
    const stored = JSON.parse(await readFile(storePathOf(dir), 'utf8'));
    assert.equal(stored.issues.length, 40, 'every create reached the file exactly once');
    assert.ok(stored.issues[0].description.startsWith('d'), 'a committed patch is visible');
    assert.deepEqual(await readdir(dir), ['issues.json'], 'no temp files left behind');
  });
});

test('concurrent first touches share a single load', async () => {
  await withDir(async (dir) => {
    await writeFile(storePathOf(dir), JSON.stringify({
      issues: [{
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Preloaded',
        description: '',
        status: 'open',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }],
    }), 'utf8');
    const store = new IssueStore(dir);
    const [firstList, created, secondList] = await Promise.all([
      store.list(),
      store.create({ title: 'Added' }),
      store.list(),
    ]);
    assert.equal(firstList.length, 1);
    assert.equal(secondList.length, 1, 'in-flight list sees only committed items');
    const final = await store.list();
    assert.deepEqual(final.map((issue) => issue.title), ['Added', 'Preloaded']);
    assert.equal(JSON.parse(await readFile(storePathOf(dir), 'utf8')).issues.length, 2);
  });
});

test('a failed persist leaves the previous snapshot committed and recoverable', { skip: isRoot }, async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const good = await store.create({ title: 'Committed', description: 'stays' });
    const bytesBefore = await readFile(storePathOf(dir), 'utf8');

    await chmod(dir, 0o555);
    try {
      await assert.rejects(store.create({ title: 'Lost' }), (err) => {
        assert.ok(err instanceof StoreError);
        assert.equal(err.code, 'STORE_ERROR');
        return true;
      });
      await assert.rejects(store.update(good.id, { title: 'Also lost' }), StoreError);
      assert.deepEqual((await store.list()).map((issue) => issue.title), ['Committed']);
    } finally {
      await chmod(dir, 0o755);
    }

    assert.equal(await readFile(storePathOf(dir), 'utf8'), bytesBefore, 'failed writes changed no bytes');
    const recovered = await store.create({ title: 'After recovery' });
    const stored = JSON.parse(await readFile(storePathOf(dir), 'utf8'));
    assert.deepEqual(stored.issues.map((issue) => issue.title), ['Committed', 'After recovery']);
    assert.equal(recovered.title, 'After recovery');
    assert.deepEqual(await readdir(dir), ['issues.json']);
  });
});

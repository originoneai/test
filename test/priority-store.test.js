// Direct IssueStore coverage for the four-level issue priority: on-disk
// shape, write guards, corruption refusal, atomic and failed writes,
// concurrency and reload across instances. The second-use compatibility
// section pins the six-field pre-priority migration: legacy records read as
// 'normal' without rewriting the file and upgrade atomically on the next
// successful write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueStore, StoreError } from '../src/store.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const EIGHT_FIELDS = ['completions', 'createdAt', 'description', 'id', 'priority', 'status', 'title', 'updatedAt'];
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const storePathOf = (dir) => join(dir, 'issues.json');

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'priority-store-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Case-unique seven-field fixture: unlike the legacy fixtures elsewhere, this
// one always carries a valid priority.
const priorityRecord = (overrides = {}) =>
  ({
    id: '55555555-5555-4555-8555-555555555555',
    title: 'Stored priority item',
    description: 'fixture text',
    status: 'open',
    priority: 'normal',
    createdAt: '2026-02-28T12:34:56Z',
    updatedAt: '2026-02-28T12:34:56Z',
    ...overrides,
  });

test('create writes the eight-field contract shape with the given priority', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const first = await store.create({ title: 'First', priority: 'urgent' });
    const second = await store.create({ title: 'Second' });

    assert.equal(first.priority, 'urgent');
    assert.equal(second.priority, 'normal', 'omitted priority defaults to normal');

    const raw = await readFile(storePathOf(dir), 'utf8');
    assert.ok(raw.endsWith('\n'), 'store file ends with a newline');
    const stored = JSON.parse(raw);
    assert.deepEqual(Object.keys(stored), ['issues']);
    assert.equal(stored.issues.length, 2);
    for (const issue of stored.issues) {
      assert.deepEqual(
        Object.keys(issue).sort(),
        EIGHT_FIELDS,
      );
    }
    assert.equal(stored.issues[0].priority, 'urgent');
    assert.equal(stored.issues[1].priority, 'normal');
    assert.deepEqual(await readdir(dir), ['issues.json'], 'no temp files remain');
  });
});

test('update patches priority alone; id, createdAt and siblings never move', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const created = await store.create({ title: 'Original', description: 'text', priority: 'low' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.update(created.id, { priority: 'high' });

    assert.equal(updated.priority, 'high');
    assert.equal(updated.title, 'Original');
    assert.equal(updated.description, 'text');
    assert.equal(updated.status, 'open');
    assert.equal(updated.id, created.id);
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(updated.updatedAt > created.updatedAt, 'updatedAt advances');

    const stored = JSON.parse(await readFile(storePathOf(dir), 'utf8'));
    assert.equal(stored.issues[0].priority, 'high', 'the disk copy carries the new priority');
  });
});

test('store guards reject non-contract priorities before touching disk', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const created = await store.create({ title: 'Baseline', priority: 'normal' });
    const before = await readFile(storePathOf(dir), 'utf8');

    const rejections = [
      ['create with an enum-external priority', () => store.create({ title: 'Bad', priority: 'critical' })],
      ['create with a case-mangled priority', () => store.create({ title: 'Bad', priority: 'URGENT' })],
      ['create with a non-string priority', () => store.create({ title: 'Bad', priority: 7 })],
      ['create with a null priority', () => store.create({ title: 'Bad', priority: null })],
      ['create with a hostile-toString priority', () => store.create({ title: 'Bad', priority: { toString: null } })],
      ['update with an enum-external priority', () => store.update(created.id, { priority: 'whenever' })],
      ['update with a non-string priority', () => store.update(created.id, { priority: false })],
    ];
    for (const [label, attempt] of rejections) {
      await assert.rejects(attempt(), (err) => {
        assert.ok(err instanceof StoreError, label);
        assert.equal(err.code, 'STORE_ERROR', label);
        return true;
      }, label);
    }

    assert.equal(await readFile(storePathOf(dir), 'utf8'), before, 'no rejected priority write reached the disk');
    assert.deepEqual((await store.list()).map((issue) => issue.priority), ['normal']);
  });
});

test('the loader accepts every stored priority value and refuses a broken one', async () => {
  await withDir(async (dir) => {
    await writeFile(
      storePathOf(dir),
      JSON.stringify({
        issues: [
          priorityRecord({ id: '55555555-5555-4555-8555-555555555556', priority: 'low' }),
          priorityRecord({ id: '55555555-5555-4555-8555-555555555557', priority: 'normal' }),
          priorityRecord({ id: '55555555-5555-4555-8555-555555555558', priority: 'high' }),
          priorityRecord({ id: '55555555-5555-4555-8555-555555555559', priority: 'urgent' }),
        ],
      }, null, 2) + '\n',
      'utf8',
    );
    const store = new IssueStore(dir);
    assert.deepEqual(
      (await store.list()).map((issue) => issue.priority),
      ['urgent', 'high', 'normal', 'low'],
      'a valid store reloads with every priority value, newest first',
    );

    const broken = JSON.stringify({ issues: [priorityRecord({ priority: 'critical' })] }, null, 2) + '\n';
    await writeFile(storePathOf(dir), broken, 'utf8');
    const refusing = new IssueStore(dir);
    await assert.rejects(refusing.list(), (err) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err.code, 'STORE_ERROR');
      assert.ok(err.message.includes('priority'), 'the refusal names the priority field');
      return true;
    });
    assert.equal(await readFile(storePathOf(dir), 'utf8'), broken, 'the refused file is never rewritten');
    assert.deepEqual(await readdir(dir), ['issues.json'], 'no temp files on refusal');
  });
});

test('a failed priority write stays uncommitted and is never smuggled later', { skip: isRoot }, async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const good = await store.create({ title: 'Committed', priority: 'low' });
    const bytesBefore = await readFile(storePathOf(dir), 'utf8');

    await chmod(dir, 0o555);
    try {
      await assert.rejects(store.create({ title: 'Lost', priority: 'urgent' }), (err) => {
        assert.ok(err instanceof StoreError);
        assert.equal(err.code, 'STORE_ERROR');
        return true;
      });
      await assert.rejects(store.update(good.id, { priority: 'urgent' }), StoreError);
      assert.deepEqual(
        (await store.list()).map((issue) => [issue.title, issue.priority]),
        [['Committed', 'low']],
        'readers never see the failed priority write',
      );
    } finally {
      await chmod(dir, 0o755);
    }

    assert.equal(await readFile(storePathOf(dir), 'utf8'), bytesBefore, 'failed writes changed no bytes');
    const recovered = await store.create({ title: 'After recovery', priority: 'high' });
    assert.equal(recovered.priority, 'high');
    const stored = JSON.parse(await readFile(storePathOf(dir), 'utf8'));
    assert.deepEqual(
      stored.issues.map((issue) => [issue.title, issue.priority]),
      [['Committed', 'low'], ['After recovery', 'high']],
      'the failed urgent write is not carried into the next successful write',
    );
    assert.deepEqual(await readdir(dir), ['issues.json']);
  });
});

test('concurrent priority writes serialize with nothing lost or torn', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const created = await Promise.all(
      Array.from({ length: 40 }, (_, index) => store.create({ title: 'Item ' + index, priority: PRIORITIES[index % 4] })),
    );
    assert.equal(new Set(created.map((issue) => issue.id)).size, 40, 'unique ids');

    const perPriority = { low: 0, normal: 0, high: 0, urgent: 0 };
    for (const issue of created) perPriority[issue.priority] += 1;
    assert.deepEqual(perPriority, { low: 10, normal: 10, high: 10, urgent: 10 });

    const patches = await Promise.all(
      Array.from({ length: 15 }, (_, index) => store.update(created[0].id, { priority: PRIORITIES[index % 4] })),
    );
    assert.ok(patches.every((issue) => issue.id === created[0].id));

    const listed = await store.list();
    assert.equal(listed.length, 40);
    assert.ok(PRIORITIES.includes(listed[39].priority), 'the target holds a committed priority: ' + listed[39].priority);

    const stored = JSON.parse(await readFile(storePathOf(dir), 'utf8'));
    assert.equal(stored.issues.length, 40, 'every create reached the file exactly once');
    assert.equal(stored.issues[0].priority, listed[39].priority, 'disk matches memory for the contested record');
    assert.deepEqual(await readdir(dir), ['issues.json'], 'no temp files left behind');
  });
});

test('priority survives reload in a later store instance', async () => {
  await withDir(async (dir) => {
    const original = new IssueStore(dir);
    const created = await original.create({ title: 'Kept', priority: 'urgent' });
    await original.update(created.id, { priority: 'low' });

    const reloaded = new IssueStore(dir);
    assert.deepEqual(
      (await reloaded.list()).map((issue) => ({ title: issue.title, priority: issue.priority })),
      [{ title: 'Kept', priority: 'low' }],
      'a fresh instance serves the durable priority',
    );

    const next = await reloaded.update(created.id, { priority: 'high' });
    assert.equal(next.priority, 'high');
    assert.equal((await new IssueStore(dir).list())[0].priority, 'high', 'and the new value reloads too');
  });
});

// ---------------------------------------------------------------------------
// Six-field legacy migration (second-use feedback)
// ---------------------------------------------------------------------------

// Case-unique pre-priority fixture: exactly the six fields a pre-priority
// writer persisted, with its own UUID namespace, leap-day instant, mixed
// timestamp precision and an empty description.
const LEGACY_ID_A = 'b1a2c3d4-5e6f-4a7b-8c9d-0f1e2a3b4c5d';
const LEGACY_ID_B = 'b1a2c3d4-5e6f-4a7b-8c9d-0f1e2a3b4c5e';
const legacyRecord = (overrides = {}) =>
  ({
    id: LEGACY_ID_A,
    title: 'Legacy triage card',
    description: 'written before priorities existed',
    status: 'open',
    createdAt: '2024-02-29T08:00:00Z',
    updatedAt: '2024-02-29T09:30:00.250Z',
    ...overrides,
  });
const legacyFileBytes = (records) => JSON.stringify({ issues: records });

test('legacy six-field records load as normal and reads never rewrite the file', async () => {
  await withDir(async (dir) => {
    const bytes = legacyFileBytes([
      legacyRecord(),
      legacyRecord({ id: LEGACY_ID_B, title: 'Second legacy card', description: '', status: 'in_progress' }),
    ]);
    await writeFile(storePathOf(dir), bytes, 'utf8');

    const store = new IssueStore(dir);
    const listed = await store.list();
    assert.equal(listed.length, 2, 'both legacy records load');
    assert.ok(listed.every((issue) => issue.priority === 'normal'), 'legacy records read as normal');
    assert.equal(listed[1].id, LEGACY_ID_A, 'creation order and ids survive');
    assert.equal(listed[0].status, 'in_progress', 'legacy fields keep their values');

    const filtered = await store.list({ priority: 'normal' });
    assert.equal(filtered.length, 2, 'the defaulted normal composes with the priority filter');
    const none = await store.list({ priority: 'urgent' });
    assert.equal(none.length, 0, 'an urgent filter is honestly empty for legacy data');
    const searched = await store.list({ query: 'legacy' });
    assert.equal(searched.length, 2, 'legacy text stays searchable');

    assert.equal(await readFile(storePathOf(dir), 'utf8'), bytes, 'reads and filters leave the file byte-identical');
    assert.deepEqual(await readdir(dir), ['issues.json'], 'reads leave no temp files');

    // A fresh instance reads the same untouched bytes again.
    const again = new IssueStore(dir);
    assert.deepEqual(
      (await again.list()).map((issue) => issue.priority),
      ['normal', 'normal'],
      'a second reader still sees the legacy records as normal',
    );
    assert.equal(await readFile(storePathOf(dir), 'utf8'), bytes, 'repeated reads still rewrite nothing');
  });
});

test('a mixed valid file of legacy and seven-field records loads each correctly', async () => {
  await withDir(async (dir) => {
    await writeFile(
      storePathOf(dir),
      legacyFileBytes([
        legacyRecord(),
        priorityRecord({ id: '55555555-5555-4555-8555-55555555557a', priority: 'urgent' }),
        legacyRecord({ id: LEGACY_ID_B, title: 'Second legacy card', description: '', status: 'done' }),
      ]),
      'utf8',
    );
    const store = new IssueStore(dir);
    const listed = await store.list(); // newest first: file order reversed
    assert.deepEqual(
      listed.map((issue) => [issue.id, issue.priority]),
      [
        [LEGACY_ID_B, 'normal'],
        ['55555555-5555-4555-8555-55555555557a', 'urgent'],
        [LEGACY_ID_A, 'normal'],
      ],
      'each record keeps its own shape: legacy defaults to normal, modern keeps its value',
    );
    const onlyUrgent = await store.list({ priority: 'urgent' });
    assert.deepEqual(onlyUrgent.map((issue) => issue.id), ['55555555-5555-4555-8555-55555555557a']);
  });
});

test('the next successful write upgrades every legacy record atomically and keeps untouched timestamps', async () => {
  await withDir(async (dir) => {
    const bytes = legacyFileBytes([
      legacyRecord(),
      legacyRecord({ id: LEGACY_ID_B, title: 'Second legacy card', description: '', status: 'in_progress' }),
    ]);
    await writeFile(storePathOf(dir), bytes, 'utf8');

    const store = new IssueStore(dir);
    await store.update(LEGACY_ID_B, { title: 'Second legacy card, renamed' });

    const stored = JSON.parse(await readFile(storePathOf(dir), 'utf8'));
    assert.equal(stored.issues.length, 2, 'the upgrade loses no record');
    for (const issue of stored.issues) {
      assert.deepEqual(
        Object.keys(issue).sort(),
        EIGHT_FIELDS,
        'every record now persists in the eight-field shape',
      );
    }
    assert.deepEqual(
      stored.issues.map((issue) => issue.priority),
      ['normal', 'normal'],
      'both legacy records upgraded to normal in the same single write',
    );
    const untouched = stored.issues.find((issue) => issue.id === LEGACY_ID_A);
    assert.equal(untouched.createdAt, '2024-02-29T08:00:00Z', 'the untouched record keeps createdAt');
    assert.equal(untouched.updatedAt, '2024-02-29T09:30:00.250Z', 'the migration never bumps updatedAt');
    assert.equal(untouched.title, 'Legacy triage card', 'and keeps its content');

    // The upgrade is durable: a fresh instance serves the eight-field file.
    const reloaded = new IssueStore(dir);
    assert.deepEqual(
      (await reloaded.list({ priority: 'normal' })).map((issue) => issue.id),
      [LEGACY_ID_B, LEGACY_ID_A],
      'a later instance reloads the upgraded records as normal, newest first',
    );
  });
});

test('a failed write against a legacy file leaves it byte-identical and still usable', { skip: isRoot }, async () => {
  await withDir(async (dir) => {
    const bytes = legacyFileBytes([legacyRecord()]);
    await writeFile(storePathOf(dir), bytes, 'utf8');

    const store = new IssueStore(dir);
    await chmod(dir, 0o555);
    try {
      await assert.rejects(store.update(LEGACY_ID_A, { priority: 'urgent' }), (err) => {
        assert.ok(err instanceof StoreError);
        assert.equal(err.code, 'STORE_ERROR');
        return true;
      });
      await assert.rejects(store.create({ title: 'Lost', priority: 'low' }), StoreError);
      assert.deepEqual(
        (await store.list()).map((issue) => [issue.title, issue.priority]),
        [['Legacy triage card', 'normal']],
        'readers keep seeing the legacy record as normal after the failed write',
      );
    } finally {
      await chmod(dir, 0o755);
    }

    assert.equal(await readFile(storePathOf(dir), 'utf8'), bytes, 'the failed write changed no bytes');
    assert.equal(JSON.parse(bytes).issues[0].updatedAt, '2024-02-29T09:30:00.250Z', 'the failed write left updatedAt untouched');
    assert.deepEqual(await readdir(dir), ['issues.json'], 'the failed write left no temp file');

    // Recovery: the next successful write upgrades the still-legacy file and
    // advances updatedAt, as every successful update must.
    await store.update(LEGACY_ID_A, { priority: 'high' });
    const stored = JSON.parse(await readFile(storePathOf(dir), 'utf8'));
    assert.deepEqual(
      Object.keys(stored.issues[0]).sort(),
      EIGHT_FIELDS,
      'the first successful write after the failure performs the upgrade',
    );
    assert.equal(stored.issues[0].priority, 'high', 'the chosen priority wins over the normal default');
    assert.equal(stored.issues[0].createdAt, '2024-02-29T08:00:00Z', 'createdAt is preserved across the upgrade');
    assert.ok(
      Date.parse(stored.issues[0].updatedAt) > Date.parse('2024-02-29T09:30:00.250Z'),
      'the successful recovery update advances updatedAt',
    );
  });
});

test('corrupt or mixed-invalid legacy-shaped data is still refused and never rewritten', async () => {
  await withDir(async (dir) => {
    const badFiles = [
      ['legacy record with an unknown field', legacyFileBytes([legacyRecord({ assignee: 'zoe' })])],
      ['legacy record missing a second field', legacyFileBytes([
        { id: LEGACY_ID_A, title: 'Short', description: '', status: 'open', createdAt: '2024-02-29T08:00:00Z' },
      ])],
      ['legacy record with a bad status', legacyFileBytes([legacyRecord({ status: 'closed' })])],
      ['legacy record with a bad title', legacyFileBytes([legacyRecord({ title: ' padded ' })])],
      ['valid legacy record beside a corrupt one', legacyFileBytes([legacyRecord(), 'not even an object'])],
    ];
    for (const [label, content] of badFiles) {
      await writeFile(storePathOf(dir), content, 'utf8');
      const store = new IssueStore(dir);
      await assert.rejects(store.list(), (err) => {
        assert.ok(err instanceof StoreError, label);
        assert.equal(err.code, 'STORE_ERROR', label);
        assert.ok(err.message.includes('Corrupt issue store'), label);
        return true;
      }, label);
      await assert.rejects(store.create({ title: 'Nope' }), StoreError, label);
      assert.equal(await readFile(storePathOf(dir), 'utf8'), content, 'refusal rewrites nothing: ' + label);
      assert.deepEqual(await readdir(dir), ['issues.json'], 'refusal leaves no temp files: ' + label);
    }
  });
});

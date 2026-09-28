// Frontend-module coverage for issue priority in the board module
// (public/app.js). The board talks to an API that stores priority, so these
// checks use the module's existing surface: form validation, the expected
// shape of a confirmed create, save-confirmation strictness and the live HTTP
// adapter. public/app.js does not implement priority support yet, so the
// checks describing that behavior currently fail; rendering of badges and
// controls is page-level behavior covered by the browser UI suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';
import {
  ApiError, confirmSaved, createHttpAdapter, expectedCreate,
  isValidIssue, matchesSubmitted, validateIssueInput,
} from '../public/app.js';

const NO_UI_YET = 'public/app.js has no priority support yet';

test('form validation accepts the four priority values and rejects others', () => {
  for (const priority of ['low', 'normal', 'high', 'urgent']) {
    const { errors } = validateIssueInput({ title: 'T', description: 'd', priority });
    assert.deepEqual(errors, {}, 'accepted on create: ' + priority + ' (' + NO_UI_YET + ')');
  }
  const partial = validateIssueInput({ priority: 'urgent' }, { partial: true });
  assert.deepEqual(partial.errors, {}, 'an edit may change priority alone (' + NO_UI_YET + ')');
  for (const bad of ['critical', 'HIGH', '', null, 3]) {
    const { errors } = validateIssueInput({ title: 'T', priority: bad });
    assert.ok(Object.keys(errors).includes('priority'), 'rejected: ' + JSON.stringify(bad));
  }
});

test('a confirmed create must show the submitted priority and the normal default', () => {
  assert.deepEqual(
    expectedCreate({ title: ' T ', priority: 'high' }),
    { title: 'T', description: '', status: 'open', priority: 'high' },
    'the submitted priority travels with a create (' + NO_UI_YET + ')',
  );
  assert.equal(
    expectedCreate({ title: 'T' }).priority,
    'normal',
    'an omitted priority defaults to normal (' + NO_UI_YET + ')',
  );
});

test('save confirmation is strict about the submitted priority', () => {
  const saved = {
    id: 'ui-check-0001', title: 'Strict', description: '', status: 'open',
    priority: 'urgent', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
  };
  assert.equal(isValidIssue(saved), true, 'a served record carrying priority stays readable');
  assert.equal(matchesSubmitted(saved, { priority: 'urgent' }), true, 'a matching priority confirms the save');
  assert.equal(
    matchesSubmitted(saved, { priority: 'low' }),
    false,
    'a different priority must not count as saved (' + NO_UI_YET + ': priority is currently ignored)',
  );
  assert.throws(
    () => confirmSaved(saved, { priority: 'low' }),
    (err) => err instanceof ApiError && err.code === 'UNCONFIRMED_RESULT' && err.outcomeUnknown === true,
    'a save whose echo shows another priority keeps an unknown outcome (' + NO_UI_YET + ')',
  );
});

async function withLiveServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'priority-ui-'));
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const adapter = createHttpAdapter({ base: 'http://127.0.0.1:' + server.address().port });
    await run(adapter);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(dataDir, { recursive: true, force: true });
    resetApiStore();
    delete process.env.DATA_DIR;
  }
}

test('the adapter forwards the priority filter, composed with search', async () => {
  await withLiveServer(async (adapter) => {
    await adapter.create({ title: 'Needle low', description: 'shared text', priority: 'low' });
    await adapter.create({ title: 'Needle high', description: 'shared text', priority: 'high' });

    const onlyHigh = await adapter.list({ priority: 'high' });
    assert.deepEqual(
      onlyHigh.map((issue) => issue.title),
      ['Needle high'],
      'the priority filter reaches the server (' + NO_UI_YET + ': the adapter drops the parameter today)',
    );

    const composed = await adapter.list({ priority: 'low', q: 'shared' });
    assert.deepEqual(
      composed.map((issue) => issue.title),
      ['Needle low'],
      'priority composes with q (' + NO_UI_YET + ')',
    );
  });
});

test('the adapter round-trips priority on create and edit and reports definite rejections', async () => {
  await withLiveServer(async (adapter) => {
    const created = await adapter.create({ title: 'Priority create', priority: 'urgent' });
    assert.equal(created.priority, 'urgent', 'the created record echoes the submitted priority');

    const edited = await adapter.update(created.id, { priority: 'low' });
    assert.equal(edited.priority, 'low', 'the edited record echoes the new priority');

    await assert.rejects(
      adapter.create({ title: 'Bad priority', priority: 'critical' }),
      (err) => err instanceof ApiError && err.code === 'VALIDATION_ERROR' && err.status === 400 && err.outcomeUnknown === false,
      'an invalid priority is a definite rejection, not an unknown outcome',
    );
  });
});

process.on('exit', () => {
  resetApiStore();
  delete process.env.DATA_DIR;
});

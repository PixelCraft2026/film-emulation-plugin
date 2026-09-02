import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDocumentLifecycle,
  shouldScheduleActivatedDocumentPreview,
} from '../../src/ui/documentLifecycle.js';

test('initial document is activated once and the first poll cannot clear its preview', () => {
  const lifecycle = createDocumentLifecycle();
  assert.deepEqual(lifecycle.transition({ id: 42 }), { changed: true, id: 42, hasDocument: true });
  assert.deepEqual(lifecycle.transition({ id: 42 }), { changed: false, id: 42, hasDocument: true });
  assert.equal(lifecycle.currentId(), 42);
});

test('real document changes and document close still activate once', () => {
  const lifecycle = createDocumentLifecycle();
  lifecycle.transition(1);
  assert.equal(lifecycle.transition(2).changed, true);
  assert.deepEqual(lifecycle.transition(null), { changed: true, id: null, hasDocument: false });
  assert.equal(lifecycle.transition(null).changed, false);
});

test('loaded state automatically schedules a preview only for the still-active document', () => {
  assert.equal(shouldScheduleActivatedDocumentPreview(true, 42, 42), true);
  assert.equal(shouldScheduleActivatedDocumentPreview(false, 42, 42), false);
  assert.equal(shouldScheduleActivatedDocumentPreview(true, 43, 42), false);
  assert.equal(shouldScheduleActivatedDocumentPreview(true, null, null), false);
});

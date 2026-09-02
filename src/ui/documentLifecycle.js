// @ts-nocheck

function documentId(value) {
  if (value && typeof value === 'object') return value.id ?? null;
  return value ?? null;
}

/**
 * Tracks active-document transitions without treating the first polling tick
 * as a second activation. The caller owns cancellation/cache cleanup and runs
 * it only when `changed` is true.
 */
export function createDocumentLifecycle() {
  const UNINITIALIZED = Symbol('uninitialized-document');
  let activeId = UNINITIALIZED;
  return {
    transition(nextDocumentOrId) {
      const nextId = documentId(nextDocumentOrId);
      const changed = activeId === UNINITIALIZED || activeId !== nextId;
      activeId = nextId;
      return { changed, id: nextId, hasDocument: nextId !== null };
    },
    currentId() {
      return activeId === UNINITIALIZED ? null : activeId;
    },
  };
}

/**
 * A loaded document may publish its first preview only while it is still the
 * active document. Keeping this policy pure makes the startup/state-restore
 * gate testable without a Photoshop host.
 */
export function shouldScheduleActivatedDocumentPreview(loadSucceeded, activeDocumentId, activatedDocumentId) {
  return loadSucceeded === true
    && activeDocumentId !== null
    && activeDocumentId !== undefined
    && activeDocumentId === activatedDocumentId;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { planUiLocaleChange } from '../../src/ui/languageTransition.js';

test('language switching is presentation-only and never requests a preview render', () => {
  const graph = [{ id: 'grain-main', params: { seed: 0x12345678 } }];
  const bindings = { sourceLayer: { id: 7 }, targetLayer: { id: 8 } };
  const renderState = {
    filmDocument: { graph },
    documentState: { bindings },
    previewRequestId: 19,
  };

  const transition = planUiLocaleChange('en', 'zh-CN', renderState);
  assert.equal(transition.changed, true);
  assert.equal(transition.uiLocale, 'zh-CN');
  assert.equal(transition.renderPreview, false);
  assert.equal(transition.renderState, renderState);
  assert.equal(transition.renderState.filmDocument.graph, graph);
  assert.equal(transition.renderState.filmDocument.graph[0].params.seed, 0x12345678);
  assert.equal(transition.renderState.documentState.bindings, bindings);
  assert.equal(transition.renderState.previewRequestId, 19);
});

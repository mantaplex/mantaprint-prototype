import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRenderedThumbnail } from './useStudioDocument.js';

test('Scan Studio thumbnail merge preserves concurrent edits and annotations', async (t) => {
  await t.test('preserves edits and annotations added while thumbnail was rendering and flags stale thumb', () => {
    const renderedSnapshot = {
      id: 'pg_1',
      edits: { rotation: 0, contrast: 1.2, brightness: 1.0 },
      annotations: [{ id: 'a1', kind: 'pen' }],
      role: 'normal',
      thumb: null
    };
    const latestPage = {
      ...renderedSnapshot,
      edits: { rotation: 0, contrast: 1.5, brightness: 1.1 },
      annotations: [{ id: 'a1', kind: 'pen' }, { id: 'a2', kind: 'pen' }],
      ocr: { text: 'invoice' }
    };
    const thumbBlob = { size: 1024 };

    const { next, stale } = mergeRenderedThumbnail(latestPage, renderedSnapshot, thumbBlob);
    assert.equal(stale, true, 'should detect that edits/annotations changed while thumbnail rendered');
    assert.equal(next.edits.contrast, 1.5, 'must keep latest contrast edit');
    assert.equal(next.edits.brightness, 1.1, 'must keep latest brightness edit');
    assert.equal(next.annotations.length, 2, 'must keep second stroke added during render');
    assert.deepEqual(next.ocr, { text: 'invoice' }, 'must keep OCR results added during render');
    assert.equal(next.thumb, thumbBlob, 'must attach rendered thumbnail');
  });

  await t.test('does not flag stale when edits and annotations references are unchanged', () => {
    const edits = { rotation: 90, contrast: 1.0 };
    const annotations = [{ id: 'a1', kind: 'box' }];
    const renderedSnapshot = { id: 'pg_1', edits, annotations, thumb: null };
    const latestPage = { ...renderedSnapshot };
    const thumbBlob = { size: 512 };

    const { next, stale } = mergeRenderedThumbnail(latestPage, renderedSnapshot, thumbBlob);
    assert.equal(stale, false);
    assert.equal(next.edits, edits);
    assert.equal(next.annotations, annotations);
    assert.equal(next.thumb, thumbBlob);
  });
});

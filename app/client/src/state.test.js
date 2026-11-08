import { describe, expect, it } from 'vitest';
import { filterPhotos, quotaLabel, selectedPhotoCount, submissionPayload } from './state.js';

describe('client selection helpers', () => {
  it('filters photos by selected and partner visibility', () => {
    const photos = [{ id: 1, selected: true, others: [{ name: '阿杰' }] }, { id: 2, selected: false, others: [] }];
    expect(filterPhotos(photos, 'mine')).toHaveLength(1);
    expect(filterPhotos(photos, 'partner')).toHaveLength(1);
  });
  it('formats merged quota and overage', () => {
    expect(quotaLabel(23, 20)).toEqual({ count: 23, quota: 20, over: 3, amount: 60 });
  });
  it('counts the current selector photos from the server payload', () => {
    expect(selectedPhotoCount({ quota: { selected: 2 }, photos: [{ selected: true }, { selected: false }, { selected: true }] })).toBe(2);
    expect(selectedPhotoCount({ quota: { selected: 0 }, photos: [{ selected: true }, { selected: false }] })).toBe(1);
    expect(selectedPhotoCount({ photos: [{ selected: true }, { selected: false }] })).toBe(1);
  });
  it('accepts overage only when the client explicitly confirms it', () => {
    expect(submissionPayload({ over: 0 })).toEqual({ accept_overage: false });
    expect(submissionPayload({ over: 3 }, true)).toEqual({ accept_overage: true });
    expect(submissionPayload({ over: 3 }, false)).toEqual({ accept_overage: false });
  });
});

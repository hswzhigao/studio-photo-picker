import { describe, expect, it } from 'vitest';
import { filterPhotos, quotaLabel } from '../client/src/state.js';

describe('client selection helpers', () => {
  it('filters photos by selected and partner visibility', () => {
    const photos = [
      { id: 1, selected: true, others: [{ name: '阿杰' }] },
      { id: 2, selected: false, others: [] },
    ];
    expect(filterPhotos(photos, 'mine')).toHaveLength(1);
    expect(filterPhotos(photos, 'partner')).toHaveLength(1);
  });

  it('formats the merged quota and overage', () => {
    expect(quotaLabel(23, 20)).toEqual({ count: 23, quota: 20, over: 3, amount: 60 });
  });
});

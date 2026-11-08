import { describe, expect, it } from 'vitest';
import {
  canSeeComment,
  canSeeEvent,
  canSeeSelection,
  visibleSelectionCount,
} from '../src/services/visibility.js';

describe('visibility service', () => {
  it('centralizes comment visibility for staff, owner, audience, and public comments', () => {
    const comment = { visibility: 'studio_only', audience_selector_id: 7, author_type: 'customer', author_id: 9 };
    expect(canSeeComment(comment, { actor_type: 'staff', actor_id: 1 })).toBe(true);
    expect(canSeeComment(comment, { actor_type: 'selector', actor_id: 7 })).toBe(true);
    expect(canSeeComment(comment, { actor_type: 'selector', actor_id: 9 })).toBe(true);
    expect(canSeeComment(comment, { actor_type: 'selector', actor_id: 8 })).toBe(false);
    expect(canSeeComment({ ...comment, visibility: 'all' }, { actor_type: 'selector', actor_id: 8 })).toBe(true);
  });

  it('centralizes event visibility and shared selection visibility', () => {
    expect(canSeeEvent({ kind: 'selection.created', actor_id: 2, payload: { selector_id: 2, share_selection: 0 } }, { actor_type: 'selector', actor_id: 2 })).toBe(true);
    expect(canSeeEvent({ kind: 'selection.created', actor_id: 2, payload: { selector_id: 2, share_selection: 0 } }, { actor_type: 'selector', actor_id: 3 })).toBe(false);
    expect(canSeeEvent({ kind: 'selection.created', actor_id: 2, payload: { selector_id: 2, share_selection: 1 } }, { actor_type: 'selector', actor_id: 3 })).toBe(true);
    expect(canSeeEvent({ kind: 'job.status', actor_id: 2, payload: {} }, { actor_type: 'selector', actor_id: 3 })).toBe(true);
    expect(canSeeSelection({ selector_id: 2, share_selection: 0 }, 3)).toBe(false);
    expect(canSeeSelection({ selector_id: 2, share_selection: 1 }, 3)).toBe(true);
  });

  it('counts only the selections a viewer is allowed to see', () => {
    const db = { prepare: (sql) => ({ get: (...args) => {
      expect(sql).toContain('count(*)');
      expect(args).toEqual([4]);
      return { count: 3 };
    }}) };
    expect(visibleSelectionCount(db, 4)).toBe(3);
  });
});

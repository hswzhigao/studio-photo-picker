import { describe, expect, it } from 'vitest';
import { routes } from './router.js';

describe('client router', () => {
  it('maps client, selected-photo, and admin paths to view components', () => {
    const paths = routes.map((route) => route.path);
    expect(paths).toEqual(expect.arrayContaining(['/', '/jobs/:id', '/jobs/:id/selected', '/admin']));
  });
});

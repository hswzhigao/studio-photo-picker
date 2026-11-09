import { describe, expect, it } from 'vitest';
import { routes } from './router.js';

function flatten(list, parent = '') {
  const result = [];
  for (const route of list) {
    const full = route.path.startsWith('/') ? route.path : `${parent.replace(/\/$/, '')}/${route.path}`;
    result.push(full);
    if (route.children) result.push(...flatten(route.children, full));
  }
  return result;
}

describe('client router', () => {
  it('maps client, selected-photo, review, and admin paths to view components', () => {
    const paths = flatten(routes);
    expect(paths).toEqual(expect.arrayContaining(['/', '/jobs/:id', '/jobs/:id/selected', '/jobs/:id/review', '/admin']));
    expect(paths).toEqual(expect.arrayContaining(['/admin/jobs/:id/photos', '/admin/jobs/:id/summary', '/admin/jobs/:id/comments']));
  });
});

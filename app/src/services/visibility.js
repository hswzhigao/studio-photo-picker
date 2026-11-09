export function canSeeComment(comment, actor) {
  return actor.actor_type === 'staff' || comment.visibility === 'all' || comment.audience_selector_id === actor.actor_id || (comment.author_type === 'customer' && comment.author_id === actor.actor_id);
}

export function canSeeSelection(selection, selectorId) {
  return selection.selector_id === selectorId || selection.share_selection === 1 || selection.share_selection === true;
}

export function visiblePhotoCondition(alias = 'p') {
  return `${alias}.hidden=0 and ${alias}.deleted_at is null and ${alias}.import_status='ready'`;
}

export function canSeeEvent(event, actor) {
  if (actor.actor_type === 'staff') return true;
  let payload;
  try { payload = typeof event.payload === 'string' ? JSON.parse(event.payload || '{}') : (event.payload || {}); } catch { return false; }
  if (event.kind.startsWith('comment.')) return payload.visibility === 'all' || payload.audience_selector_id === actor.actor_id || payload.selector_id === actor.actor_id;
  if (event.kind.startsWith('selection.')) return payload.selector_id === actor.actor_id || payload.share_selection === 1 || payload.share_selection === true;
  if (event.kind === 'share.changed') return payload.selector_id === actor.actor_id;
  if (event.kind.startsWith('photo.')) return true;
  if (event.kind === 'job.status' || event.kind === 'submit' || event.kind === 'withdraw' || event.kind === 'slot.changed') return true;
  return event.actor_id === actor.actor_id;
}

export function visibleSelectionCount(db, selectorId) {
  return db.prepare(`select count(*) count from selection s join photo p on p.id=s.photo_id where s.selector_id=? and ${visiblePhotoCondition('p')}`).get(selectorId).count;
}

export function filterVisibleComments(comments, actor) {
  return comments.filter(comment => canSeeComment(comment, actor));
}

export function filterVisibleEvents(events, actor) {
  return events.filter(event => canSeeEvent(event, actor));
}

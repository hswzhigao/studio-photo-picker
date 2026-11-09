export function filterPhotos(photos, filter) {
  if (filter === 'mine') return photos.filter((p) => p.selected);
  if (filter === 'unpicked') return photos.filter((p) => !p.selected);
  if (filter === 'partner') return photos.filter((p) => (p.others || []).length > 0);
  if (filter === 'print') return photos.filter((p) => (p.slots || []).length > 0 || p.slot);
  if (filter === 'commented') return photos.filter((p) => Number(p.comment_count || 0) > 0);
  return photos;
}

export function quotaLabel(count, quota, unitPrice = 20) {
  const over = Math.max(0, count - quota);
  return { count, quota, over, amount: over * unitPrice };
}

export function selectedPhotoCount(data = {}) {
  if (Number.isFinite(data.quota?.selected)) return data.quota.selected;
  return (data.photos || []).filter((photo) => photo.selected).length;
}

export function submissionPayload(quota = {}, acceptsOverage = false) {
  return { accept_overage: quota.over > 0 && acceptsOverage === true };
}

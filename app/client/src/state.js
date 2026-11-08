export function filterPhotos(photos, filter) {
  if (filter === 'mine') return photos.filter((p) => p.selected);
  if (filter === 'unpicked') return photos.filter((p) => !p.selected);
  if (filter === 'partner') return photos.filter((p) => (p.others || []).length > 0);
  if (filter === 'print') return photos.filter((p) => p.slot);
  return photos;
}

export function quotaLabel(count, quota) {
  const over = Math.max(0, count - quota);
  return { count, quota, over, amount: over * 20 };
}

export function selectedPhotoCount(data = {}) {
  const photoCount = (data.photos || []).filter((photo) => photo.selected).length;
  return photoCount || (Number.isFinite(data.quota?.selected) ? data.quota.selected : 0);
}

export function submissionPayload(quota = {}, acceptsOverage = false) {
  return { accept_overage: quota.over > 0 && acceptsOverage === true };
}

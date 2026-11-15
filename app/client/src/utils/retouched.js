export function canEditFeedback(comment, type, id, now = Date.now()) {
  const age = now - Date.parse(comment.created_at);
  return (
    id != null &&
    comment.author_type === type &&
    Number(comment.author_id) === Number(id) &&
    age >= 0 &&
    age <= 300000
  );
}
export function uploadUrl(base, assetId, photoId) {
  const query = new URLSearchParams();
  if (assetId) query.set("asset_id", assetId);
  else if (photoId) query.set("photo_id", String(photoId));
  return `${base}${query.size ? `?${query}` : ""}`;
}
export function latestRequest() {
  let sequence = 0;
  return { next: () => ++sequence, isCurrent: (token) => token === sequence };
}
export async function runUploadQueue(rows, upload, isCurrent = () => true) {
  const waiting = rows.filter((row) => row.status === "queued");
  async function worker() {
    while (waiting.length && isCurrent()) {
      const row = waiting.shift();
      row.status = "uploading";
      row.error = "";
      try {
        await upload(row);
        row.status = "done";
      } catch (error) {
        row.status = "failed";
        row.error = error.message || "上传失败";
      }
    }
  }
  await Promise.all([worker(), worker()]);
}
export function duplicateNames(files, photos) {
  const seen = new Set(photos.map((photo) => photo.filename.toLowerCase()));
  const duplicates = new Set();
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (seen.has(name)) duplicates.add(file.name);
    seen.add(name);
  }
  return [...duplicates];
}
export function batchIds(versions, selected, action) {
  return versions
    .filter(
      (row) =>
        selected.includes(row.id) &&
        row.status === (action === "publish" ? "ready" : "published"),
    )
    .map((row) => row.id);
}

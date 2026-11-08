#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/srv/studio-photo-picker/app/app}"
SERVICE="${SERVICE:-studio-photo-picker.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
BRANCH="${BRANCH:-main}"
DATA_DIR="${DATA_DIR:-/srv/studio-photo-picker/data}"
cd "$APP_DIR"

old_rev="$(git rev-parse HEAD)"
rollback() {
  echo "部署失败，尝试回滚到 ${old_rev}" >&2
  git reset --hard "$old_rev" || true
  npm ci || true
  npm run build || true
  sudo systemctl restart "$SERVICE" || true
}
trap rollback ERR

git fetch origin "$BRANCH"
DATA_DIR="$DATA_DIR" node scripts/backup.js
unset DATA_DIR
git merge --ff-only "origin/$BRANCH"
npm ci
npm test -- --run
npm run build
sudo systemctl restart "$SERVICE"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --fail --silent --show-error "$HEALTH_URL"; then
    echo
    trap - ERR
    exit 0
  fi
  sleep 1
done
>&2 echo "健康检查失败：$HEALTH_URL"
exit 1

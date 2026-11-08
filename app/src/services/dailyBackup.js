function nextThreeAm(now) {
  const current = new Date(now());
  const next = new Date(current);
  next.setHours(3, 0, 0, 0);
  if (next <= current) next.setDate(next.getDate() + 1);
  return Math.max(0, next.getTime() - current.getTime());
}

export function scheduleDailyBackup({ now = () => new Date(), backup, prune, timerApi = globalThis } = {}) {
  if (typeof backup !== 'function' || typeof prune !== 'function') throw new Error('daily backup handlers are required');
  let intervalId;
  const run = async () => {
    try {
      await backup({ kind: 'daily' });
      prune('daily', 14);
    } catch (error) {
      console.error(`每日备份失败：${error.message}`);
    }
  };
  const timeoutId = timerApi.setTimeout(() => {
    void run();
    intervalId = timerApi.setInterval(() => { void run(); }, 24 * 60 * 60 * 1000);
  }, nextThreeAm(now));
  return () => {
    timerApi.clearTimeout(timeoutId);
    if (intervalId !== undefined) timerApi.clearInterval(intervalId);
  };
}

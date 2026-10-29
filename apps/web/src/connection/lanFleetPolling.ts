const INTERVAL_MS = 5 * 60 * 1000;
// After three failures in a row, checks slow down rather than stop, so a share or peer that comes
// back is picked up, renewals with it, without anyone choosing Sync now.
const SLOW_INTERVAL_MS = 30 * 60 * 1000;

export function startFleetPolling(sync: () => Promise<boolean>, onFailing: () => void) {
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    const ok = await sync().catch(() => false);
    if (stopped) return;
    failures = ok ? 0 : failures + 1;
    if (failures === 3) onFailing();
    timer = setTimeout(() => void tick(), failures >= 3 ? SLOW_INTERVAL_MS : INTERVAL_MS);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function startFleetPolling(sync: () => Promise<boolean>, pause: () => void) {
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    const ok = await sync().catch(() => false);
    if (stopped) return;
    failures = ok ? 0 : failures + 1;
    if (failures < 3) timer = setTimeout(() => void tick(), 5 * 60 * 1000);
    else pause();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Timing for tests that check how work grows with its input. */

/** The CPU milliseconds one `work` call costs, its own threads' included: unlike the wall clock, it does not grow when other processes hold the cores. Calls repeat until several timer ticks pass, because a coarser clock (Windows' ~15 ms) reads one call as zero. */
async function cpuOf(work: () => unknown): Promise<number> {
  const started = process.cpuUsage();
  for (let reps = 0; ;) {
    reps += 1;
    const done = work();
    if (done instanceof Promise) await done;
    const spent = process.cpuUsage(started);
    const used = (spent.user + spent.system) / 1000;
    if (used >= 64 || reps >= 100_000) return used / reps;
  }
}

/** The least CPU time of `runs` timings of `small` and of `large` in milliseconds, taken in turns after a warm-up so what slows one slows both. */
export async function fastestInTurns(
  small: () => unknown,
  large: () => unknown,
  runs = 7,
): Promise<[small: number, large: number]> {
  const work = [small, large];
  const best = [Infinity, Infinity];
  await small();
  await large();
  for (let i = 0; i < runs; i += 1)
    for (const which of i % 2 === 0 ? [0, 1] : [1, 0]) best[which] = Math.min(best[which], await cpuOf(work[which]));
  return [best[0], best[1]];
}

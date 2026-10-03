import { mapLimit } from "./common";

/**
 * Walks `candidates` in order until nothing in `unresolved` is left, loading a batch at a time
 * rather than one file per round-trip. `onLoaded` is called in candidate order, so the first file
 * to define a name still wins the way it did when the scan was serial, and `onLoaded` is where the
 * caller removes the names it has accounted for. A candidate whose `load` throws is skipped; the
 * scan goes on with the rest.
 */
export async function scanCandidatesUntilResolved<T>(
	candidates: readonly string[],
	unresolved: ReadonlySet<string>,
	load: (candidate: string) => Promise<T>,
	onLoaded: (candidate: string, value: T) => void,
	batchSize = 16,
): Promise<void> {
	const effectiveBatchSize = Math.max(1, batchSize);
	for (
		let start = 0;
		start < candidates.length && unresolved.size > 0;
		start += effectiveBatchSize
	) {
		const batch = candidates.slice(start, start + effectiveBatchSize);
		const loaded = await mapLimit(batch, effectiveBatchSize, async (candidate) => {
			try {
				return { ok: true as const, value: await load(candidate) };
			} catch {
				return { ok: false as const };
			}
		});
		for (let i = 0; i < batch.length; i++) {
			const result = loaded[i];
			if (result?.ok) {
				onLoaded(batch[i]!, result.value);
			}
		}
	}
}

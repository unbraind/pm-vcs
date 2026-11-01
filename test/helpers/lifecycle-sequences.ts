/** One reproducible native lifecycle action and its independent fixture input. */
export interface LifecycleAction { readonly op: number; readonly index: number; readonly noise?: number }

/** Generate bounded histories using high bits rather than the alternating low LCG bit. */
export function lifecycleSequence(seed: number): LifecycleAction[] {
 let state = seed; const next = (): number => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
 const choices = [0, 1, 2, 3, 4, 5, 6, 7, ...Array.from({ length: 4 }, () => (next() >>> 16) % 8)];
 for (let end = choices.length - 1; end > 0; end--) { const other = (next() >>> 16) % (end + 1); [choices[end], choices[other]] = [choices[other], choices[end]]; }
 return choices.map(op => ({ op, index: (next() >>> 16) % 2, ...(op === 6 || op === 7 ? { noise: next() >>> 16 } : {}) }));
}

/**
 * Caches the most recent result of a pure function by argument identity (Object.is). Used for
 * derived song data in views so results keep a stable identity across renders — effects keyed on
 * them (e.g. Studio stem rendering) only re-run when an input really changes.
 */
export function memoLast<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let lastArgs: A | null = null
  let lastResult: R
  return (...args: A) => {
    if (lastArgs && lastArgs.length === args.length && lastArgs.every((a, i) => Object.is(a, args[i]))) return lastResult
    lastArgs = args
    lastResult = fn(...args)
    return lastResult
  }
}

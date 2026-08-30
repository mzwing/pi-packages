/** Drops undefined values, so `exactOptionalPropertyTypes` sees omission rather than an undefined slot. */
export function compact<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T
}

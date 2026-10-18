/** Small fail-closed JSON boundary decoder; business code receives typed values, not casts. */
export interface Schema<T> {
  parse(value: unknown): T;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;
type Shape = Record<string, Schema<unknown>>;
type RequiredKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Infer<S[K]> ? never : K;
}[keyof S];
type ObjectValue<S extends Shape> = { [K in RequiredKeys<S>]: Infer<S[K]> } & {
  [K in Exclude<keyof S, RequiredKeys<S>>]?: Infer<S[K]>;
};
export function invalid(): never {
  // Do not include untrusted content, image bytes or provider descriptions.
  throw new Error('Invalid workbench protocol value');
}
export const schema = <T>(parse: (value: unknown) => T): Schema<T> => ({ parse });
export const string = schema((v) =>
  typeof v === 'string' &&
  !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(v)
    ? v
    : invalid(),
);
export const boolean = schema((v) => (typeof v === 'boolean' ? v : invalid()));
export const integer = schema((v) =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : invalid(),
);
export const uint = schema((v) => {
  const n = integer.parse(v);
  return n >= 0 ? n : invalid();
});
export const literal = <const T extends string | number>(expected: T) =>
  schema((v): T => (v === expected ? expected : invalid()));
export const oneOf = <const T extends readonly string[]>(...choices: T) =>
  schema((v): T[number] => (typeof v === 'string' && choices.includes(v) ? v : invalid()));
export const optional = <T>(s: Schema<T>) =>
  schema((v) => (v === undefined ? undefined : s.parse(v)));
export const nullable = <T>(s: Schema<T>) =>
  schema((v) => (v === null || v === undefined ? null : s.parse(v)));
export const array = <T>(s: Schema<T>) =>
  schema((v) => (Array.isArray(v) ? v.map((item) => s.parse(item)) : invalid()));
function recordValue(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalid();
}
export const object = <S extends Shape>(shape: S): Schema<ObjectValue<S>> =>
  schema((v) => {
    const value = recordValue(v);
    if (Object.keys(value).some((key) => !Object.hasOwn(shape, key))) invalid();
    return Object.fromEntries(
      Object.entries(shape).map(([key, s]) => [key, s.parse(value[key])]),
    ) as ObjectValue<S>;
  });
export const record = <T>(s: Schema<T>, key?: Schema<string>) =>
  schema(
    (v): Record<string, T> =>
      Object.fromEntries(
        Object.entries(recordValue(v)).map(([k, value]) => [
          key ? key.parse(k) : k,
          s.parse(value),
        ]),
      ),
  );
/** Serde's externally tagged enum: unit strings, otherwise a single-key object. */
export const variants = <S extends Record<string, Schema<unknown> | null>>(shape: S) =>
  schema(
    (
      v,
    ): {
      [K in keyof S]: S[K] extends Schema<infer T> ? { [P in K]: T } : K;
    }[keyof S] => {
      if (typeof v === 'string' && Object.hasOwn(shape, v) && shape[v] === null) return v as never;
      const value = recordValue(v),
        keys = Object.keys(value),
        key = keys[0];
      if (keys.length !== 1 || !Object.hasOwn(shape, key) || shape[key] === null) invalid();
      return { [key]: shape[key]!.parse(value[key]) } as never;
    },
  );
/** Serde's internally tagged IPC enum. */
export const tagged = <S extends Shape>(tag: string, shape: S) =>
  schema((v): Infer<S[keyof S]> => {
    const value = recordValue(v),
      name = value[tag];
    return typeof name === 'string' && Object.hasOwn(shape, name)
      ? (shape[name].parse(value) as Infer<S[keyof S]>)
      : invalid();
  });
export const checked = <T>(s: Schema<T>, check: (value: T) => boolean) =>
  schema((v) => {
    const value = s.parse(v);
    return check(value) ? value : invalid();
  });

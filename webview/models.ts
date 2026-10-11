/** Visibility affects the compact picker only; the current model remains usable. */
export function visibleModelSelector<
  T extends { kind: string; current: string; options: { id: string; name: string }[] },
>(control: T, visible?: string[]): T {
  return control.kind === 'model' && visible
    ? {
        ...control,
        options: control.options.filter((o) => o.id === control.current || visible.includes(o.id)),
      }
    : control;
}

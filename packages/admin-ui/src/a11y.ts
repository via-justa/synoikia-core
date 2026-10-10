const STEP: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

/** The role a message takes: errors are alerts, anything else is a polite status. */
export const messageRole = (kind: string) => (kind === 'error' ? 'alert' : 'status');

/** The item that takes Tab in a tab list or radio group: the chosen one while enabled, else the first enabled. */
export function tabStop<T>(items: readonly T[], chosen: T | undefined, disabled: (item: T) => boolean = () => false) {
  return chosen !== undefined && items.includes(chosen) && !disabled(chosen) ? chosen : items.find((i) => !disabled(i));
}

/** Arrows, Home and End on a tablist or radiogroup: focus the next enabled item and, with `choose`, click it. */
export function rovingKeydown(event: KeyboardEvent, choose = true) {
  const group = event.currentTarget as HTMLElement;
  const items = [...group.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')].filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
  const at = items.indexOf(event.target as HTMLElement);
  // A tab list leaves Up and Down to page scrolling.
  const vertical = group.getAttribute('role') !== 'tablist';
  let to: number;
  if (event.key === 'Home') to = 0;
  else if (event.key === 'End') to = items.length - 1;
  else if (STEP[event.key] && (vertical || /Left|Right/.test(event.key))) to = at + STEP[event.key]!;
  else return;
  if (at < 0) return;
  event.preventDefault();
  const next = items[(to + items.length) % items.length]!;
  next.focus();
  if (choose) next.click();
}

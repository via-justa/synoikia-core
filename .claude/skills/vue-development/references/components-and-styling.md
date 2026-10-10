# Components, styling and accessibility

## Components

- Order the `<script setup>` block: imports, props, emits and models, composables and state, computeds, functions, lifecycle hooks.
- Type-based props, emits and models: `defineProps<{ instance: Instance }>()`, `defineEmits<{ close: [] }>()`, `defineModel<string[]>({ required: true })`. Use `withDefaults` for defaults.
- **Views** (`views/`) own data: they call the query and mutation composables and pass values down. **Components** (`components/`) render and emit; they don't fetch. A component that edits a value uses `defineModel`.
- Extract a component when a template block repeats or a page gets hard to read. Keep one-off handlers and formatting in the view.
- Use slots for layout (`ModalDialog` has a default and a `footer` slot) instead of props that toggle markup.
- Use the shared pieces before writing new ones: `PageHeader`, `ModalDialog`, `InfoTip`, `ChipsInput`, `SchemaForm`, `RegistryPicker`, `MarkdownLite`, and the formatters in `format.ts` (`formatDate`, `ago`, `pretty`, label maps).

## Composables

- Name them `use*`, one responsibility each, in `src/composables/`. Return a plain object of refs, computeds and functions.
- Extract a composable as soon as a second view needs the same logic (a confirm flow, a copy-to-clipboard, a polling timer).
- A UI-state composable doesn't fetch; a data composable wraps vue-query (see `data-and-state.md`).
- Register DOM listeners in `onMounted` and remove them in `onBeforeUnmount`, as `ModalDialog` does.
- Use discriminated unions for state with more than one mode.

## Forms

- Plain `v-model` on native inputs inside `.field` / `.form-grid`. A `<label>` wraps or points to every input.
- Check only what the UI can know (required, two passwords match) and disable submit until it passes. Core validates the rest and its message, with details, comes back through `errorText`.
- Submit with a mutation. Disable the button while the mutation is pending.

## Dialogs

- Confirms, prompts and form popups use `ModalDialog`. Never `window.confirm`, `window.prompt` or `window.alert`.
- Use the shared confirm composable in `src/composables/` for yes/no questions, so each view doesn't hold its own open/close state.
- Destructive actions use `btn-danger` and name the thing in the question ("Delete the role Ops?").

## Styling

- Colors, fonts, radii and shadows are tokens on `:root` in `src/styles.css`, defined for light and dark (the OS setting, or `data-theme` from `theme.ts`). Components use `var(--token)` only. No hex, `rgb()`, named colors or literal shadows in a component; add a token for both themes instead.
- Use the global classes before writing CSS: `.page`, `.card`, `.stack`, `.row`, `.grow`, `.actions`, `.field`, `.form-grid`, `.table`, `.table-card`, `.tabs`, `.segmented`, `.btn` (`-primary`, `-danger`, `-link`, `-sm`), `.pill`, `.dot`, `.alert`, `.empty`, `.muted`, `.small`, `.mono`.
- A pattern used by two views moves to `styles.css`. Scoped `<style>` is for what is specific to one component.
- No inline `style="…"` for anything themeable.
- Mobile layout uses `@media (max-width: 720px)`, the breakpoint `styles.css` and `AppShell` use. Don't add another breakpoint without a reason.

## Accessibility

- Use real elements: `<button type="button">` for actions, `<a>`/`RouterLink` for navigation, native inputs. No click-only `<div>`.
- Errors are announced (`role="alert"`), notices and loading states use `role="status"`.
- Icon-only buttons carry `aria-label` (see the `×` close button in `ModalDialog`).
- Dialogs: `role="dialog"`, `aria-modal`, a label, Escape closes, focus moves in on open and returns to the trigger on close.
- Don't show state by color alone; pair the `.dot` or `.pill` color with text.
- Never remove a focus outline without a visible replacement (`--focus-ring`).
- `v-for` keys are entity ids, not indexes.

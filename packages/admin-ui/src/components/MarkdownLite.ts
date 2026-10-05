import { defineComponent, h } from 'vue';
import type { VNode } from 'vue';

/** Renders the Markdown subset manifests use for setup help, as elements, never HTML strings. */

type Block = { kind: 'p'; text: string } | { kind: 'ol' | 'ul'; items: string[] };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of source.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = chunk.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const ordered = lines.every((l) => /^\s*\d+\.\s+/.test(l));
    const bullets = lines.every((l) => /^\s*[-*]\s+/.test(l));
    if (ordered || bullets) {
      blocks.push({
        kind: ordered ? 'ol' : 'ul',
        items: lines.map((l) => l.replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, '')),
      });
    } else {
      blocks.push({ kind: 'p', text: lines.join(' ') });
    }
  }
  return blocks;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;

function renderInline(text: string): (string | VNode)[] {
  return text
    .split(INLINE)
    .filter((part) => part !== '')
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return h('code', part.slice(1, -1));
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return h('strong', part.slice(2, -2));
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return h('em', part.slice(1, -1));
      return part;
    });
}

export default defineComponent({
  name: 'MarkdownLite',
  props: { source: { type: String, required: true } },
  setup(props) {
    return () =>
      h(
        'div',
        { class: 'markdown-lite' },
        parseBlocks(props.source).map((b) =>
          b.kind === 'p'
            ? h('p', renderInline(b.text))
            : h(
                b.kind,
                b.items.map((item) => h('li', renderInline(item))),
              ),
        ),
      );
  },
});

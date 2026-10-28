import postcss, { type Container } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser, { type Node } from 'postcss-value-parser';

export const EMAIL_BODY_CLASS = 'spindle-email-body';
export type RewriteImage = (source: string) => string | null;

const properties = new Set(
  `color background background-color background-image background-position background-size background-repeat background-origin background-clip
  font font-family font-size font-style font-weight font-variant font-stretch line-height letter-spacing word-spacing text-align text-align-last text-decoration text-decoration-color text-decoration-line text-decoration-style text-transform text-indent text-shadow text-overflow text-size-adjust -webkit-text-size-adjust -ms-text-size-adjust
  white-space word-break overflow-wrap word-wrap vertical-align direction unicode-bidi
  display visibility opacity width min-width max-width height min-height max-height box-sizing
  margin margin-top margin-right margin-bottom margin-left margin-inline margin-inline-start margin-inline-end margin-block margin-block-start margin-block-end
  padding padding-top padding-right padding-bottom padding-left padding-inline padding-inline-start padding-inline-end padding-block padding-block-start padding-block-end
  border border-width border-style border-color border-top border-right border-bottom border-left border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color border-radius border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius border-collapse border-spacing box-shadow outline outline-color outline-style outline-width outline-offset
  table-layout caption-side empty-cells list-style list-style-type list-style-position list-style-image
  float clear position top right bottom left z-index overflow overflow-x overflow-y
  flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap align-items align-content align-self justify-content justify-items justify-self order gap row-gap column-gap
  grid grid-template-columns grid-template-rows grid-column grid-row grid-column-start grid-column-end grid-row-start grid-row-end grid-auto-flow grid-auto-columns grid-auto-rows
  object-fit object-position -webkit-font-smoothing -moz-osx-font-smoothing mso-hide mso-line-height-rule mso-table-lspace mso-table-rspace`.split(
    /\s+/,
  ),
);
const functions = new Set([
  '',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'calc',
  'min',
  'max',
  'clamp',
  'var',
  'env',
  'linear-gradient',
  'radial-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'fit-content',
  'minmax',
  'repeat',
]);
const imageProperties = new Set([
  'background',
  'background-image',
  'list-style',
  'list-style-image',
]);

function unescapeCss(value: string) {
  return value.replace(
    /\\(?:([0-9a-f]{1,6})\s?|([^\r\n\f0-9a-f]))/gi,
    (_all, hex: string | undefined, char: string | undefined) => {
      if (!hex) return char ?? '';
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '\ufffd';
    },
  );
}

function cleanValue(input: string, rewrite: RewriteImage | null) {
  if (input.length > 4096 || /[<>]/.test(input) || input.includes('\0'))
    return null;
  const ast = valueParser(input);
  function clean(nodes: Node[], depth: number): boolean {
    if (depth > 16) return false;
    for (const node of nodes) {
      if (node.type === 'comment') continue;
      if (node.type !== 'function') continue;
      if (node.unclosed) return false;
      const name = unescapeCss(node.value).toLowerCase();
      if (name === 'url') {
        if (!rewrite) return false;
        const meaningful = node.nodes.filter(
          (item) => item.type !== 'space' && item.type !== 'comment',
        );
        if (
          meaningful.length !== 1 ||
          !['word', 'string'].includes(meaningful[0]?.type ?? '')
        )
          return false;
        const image = rewrite(unescapeCss(meaningful[0]?.value ?? ''));
        node.value = 'url';
        if (image)
          node.nodes = [
            {
              type: 'string',
              quote: '"',
              value: image.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
              sourceIndex: 0,
              sourceEndIndex: 0,
            },
          ];
        else {
          Object.assign(node, { type: 'word', value: 'none' });
          delete (node as Partial<typeof node>).nodes;
        }
      } else {
        if (!functions.has(name) || !clean(node.nodes, depth + 1)) return false;
        node.value = name;
      }
    }
    return true;
  }
  if (!clean(ast.nodes, 0)) return null;
  return ast.toString();
}

function cleanSelectors(source: string) {
  if (
    source.length > 2048 ||
    (source.match(/\(/g)?.length ?? 0) > 16 ||
    /[<>]/.test(source) ||
    source.includes('\0')
  )
    return null;
  try {
    return selectorParser((root) => {
      root.walkAttributes((attribute) => {
        // Generated src/style attributes contain private content grants.
        if (
          ['src', 'srcset', 'style'].includes(
            unescapeCss(attribute.attribute).toLowerCase(),
          )
        )
          throw new Error('Sensitive selector');
      });
      root.walkTags((tag) => {
        if (tag.value.toLowerCase() === 'body')
          tag.replaceWith(
            selectorParser.className({ value: EMAIL_BODY_CLASS }),
          );
        if (tag.value.toLowerCase() === 'html')
          tag.replaceWith(selectorParser.pseudo({ value: ':root' }));
      });
    }).processSync(source);
  } catch {
    return null;
  }
}

export function sanitizeCss(
  source: string,
  rewrite: RewriteImage,
  inline = false,
) {
  if (source.length > (inline ? 16384 : 256 * 1024)) return '';
  try {
    const root = postcss.parse(inline ? `email{${source}}` : source, {
      from: undefined,
    });
    if (
      inline &&
      (root.nodes.length !== 1 ||
        root.first?.type !== 'rule' ||
        root.first.selector !== 'email')
    )
      return '';
    let nodes = 0;
    function clean(container: Container, depth: number) {
      for (const node of [...(container.nodes ?? [])]) {
        if (++nodes > 10000 || depth > 4) {
          node.remove();
          continue;
        }
        if (node.type === 'comment') {
          node.remove();
          continue;
        }
        if (node.type === 'decl') {
          const property = unescapeCss(node.prop).toLowerCase();
          if (
            !properties.has(property) &&
            !/^--[a-z0-9_-]{1,100}$/.test(property)
          ) {
            node.remove();
            continue;
          }
          const value = cleanValue(
            node.value,
            imageProperties.has(property) || property.startsWith('--')
              ? rewrite
              : null,
          );
          if (value === null) {
            node.remove();
            continue;
          }
          node.prop = property;
          node.value = value;
        } else if (node.type === 'rule') {
          if (inline && node.parent !== root) {
            node.remove();
            continue;
          }
          const selector = cleanSelectors(node.selector);
          if (!selector) {
            node.remove();
            continue;
          }
          node.selector = selector;
          clean(node, depth + 1);
        } else if (node.type === 'atrule') {
          if (
            inline ||
            !['media', 'supports'].includes(node.name.toLowerCase()) ||
            !node.nodes ||
            node.params.length > 512 ||
            cleanValue(node.params, null) === null
          ) {
            node.remove();
            continue;
          }
          node.name = node.name.toLowerCase();
          clean(node, depth + 1);
        }
      }
    }
    clean(root, 0);
    const result =
      inline && root.first?.type === 'rule'
        ? root.first.nodes.map((node) => node.toString()).join(';')
        : inline
          ? ''
          : root.toString();
    // Style blocks are inserted only after HTML sanitization. Never permit an HTML closing tag.
    return result.replaceAll('<', '\\3c ');
  } catch {
    return '';
  }
}

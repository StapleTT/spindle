import { Parser } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';
import { EMAIL_BODY_CLASS, type RewriteImage, sanitizeCss } from './css.js';
import { remoteImageUrl } from './media.js';

export type ImageResource =
  | { kind: 'remote'; url: string }
  | { kind: 'inline'; cid: string };

export const SANITIZER_VERSION = 2;

function stylesFrom(html: string) {
  const styles: string[] = [];
  let current: string | null = null;
  let bytes = 0;
  const parser = new Parser(
    {
      onopentag: (name) => {
        if (name === 'style') current = '';
      },
      ontext: (text) => {
        if (current !== null) {
          bytes += text.length;
          if (bytes <= 256 * 1024) current += text;
        }
      },
      onclosetag: (name) => {
        if (name === 'style' && current !== null) {
          if (styles.length < 64) styles.push(current);
          current = null;
        }
      },
    },
    { decodeEntities: false },
  );
  parser.end(html);
  return styles;
}

function layoutAttributes(
  attrs: Record<string, string>,
  rewrite: RewriteImage,
) {
  const result = { ...attrs };
  if (result.style) result.style = sanitizeCss(result.style, rewrite, true);
  if (result.background) {
    const image = rewrite(result.background);
    if (image)
      result.style = `${result.style ?? ''};background-image:url("${image}")`;
    delete result.background;
  }
  for (const name of ['class', 'id', 'face'])
    if (result[name]) result[name] = result[name].slice(0, 1000);
  for (const name of ['width', 'height']) {
    const value = result[name];
    if (
      value &&
      (!/^\d{1,4}%?$/.test(value) ||
        Number.parseInt(value, 10) > (value.endsWith('%') ? 100 : 4096))
    )
      delete result[name];
  }
  for (const name of ['cellpadding', 'cellspacing', 'border'])
    if (result[name] && !/^\d{1,3}$/.test(result[name])) delete result[name];
  for (const name of ['bgcolor', 'color'])
    if (result[name] && !/^(?:#[0-9a-f]{3,8}|[a-z]{1,30})$/i.test(result[name]))
      delete result[name];
  return result;
}

const policy: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'div',
    'span',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'blockquote',
    'pre',
    'code',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'a',
    'img',
    'dl',
    'dt',
    'dd',
    'sup',
    'sub',
    'font',
    'center',
    'colgroup',
    'col',
  ],
  allowedAttributes: {
    '*': ['dir', 'class', 'id', 'style'],
    a: ['href', 'target', 'rel'],
    img: ['data-spindle-image', 'alt', 'width', 'height'],
    table: [
      'width',
      'height',
      'align',
      'bgcolor',
      'border',
      'cellpadding',
      'cellspacing',
      'role',
    ],
    tr: ['align', 'valign', 'bgcolor'],
    td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor'],
    th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor'],
    col: ['width', 'span'],
    colgroup: ['width', 'span'],
    font: ['face', 'color', 'size'],
    div: ['align'],
    p: ['align'],
  },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: [
    'script',
    'style',
    'textarea',
    'option',
    'svg',
    'math',
    'iframe',
    'object',
    'template',
  ],
  nestingLimit: 40,
  // Style attributes have already passed our CSS parser; do not parse/serialize them again.
  parseStyleAttributes: false,
  transformTags: {
    a: (_tag, attrs) => ({
      tagName: 'a',
      attribs: {
        ...attrs,
        href: attrs.href ?? '',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    }),
  },
};

export function sanitizeMessage(html: string) {
  const resources: ImageResource[] = [];
  const rewrite: RewriteImage = (src) => {
    src = src.trim();
    const cid = src.toLowerCase().startsWith('cid:')
      ? src.slice(4).replace(/^<|>$/g, '')
      : null;
    const url = remoteImageUrl(src);
    const resource: ImageResource | null =
      cid && cid.length <= 320
        ? { kind: 'inline', cid }
        : url
          ? { kind: 'remote', url }
          : null;
    if (!resource) return null;
    const existing = resources.findIndex(
      (item) =>
        item.kind === resource.kind &&
        (item.kind === 'remote' && resource.kind === 'remote'
          ? item.url === resource.url
          : item.kind === 'inline' &&
            resource.kind === 'inline' &&
            item.cid === resource.cid),
    );
    if (existing >= 0) return `spindle-image:${existing}`;
    if (resources.length >= 20) return null;
    return `spindle-image:${resources.push(resource) - 1}`;
  };
  const css = stylesFrom(html)
    .map((style) => sanitizeCss(style, rewrite))
    .join('\n');
  let hasBody = false;
  const safe = sanitizeHtml(html, {
    ...policy,
    transformTags: {
      ...policy.transformTags,
      '*': (tag, attrs) => ({
        tagName: tag,
        attribs: layoutAttributes(attrs, rewrite),
      }),
      body: (_tag, attrs) => {
        hasBody = true;
        return {
          tagName: 'div',
          attribs: {
            ...attrs,
            class: `${EMAIL_BODY_CLASS} ${attrs.class ?? ''}`,
            style: `${attrs.style ?? ''};${attrs.bgcolor ? `background-color:${attrs.bgcolor}` : ''}`,
          },
        };
      },
      img: (_tag, attrs) => {
        const image = rewrite(attrs.src ?? '');
        if (!image)
          return {
            tagName: 'span',
            attribs: {},
            text: attrs.alt ?? '[Image omitted]',
          };
        const index = image.slice('spindle-image:'.length);
        return {
          tagName: 'img',
          attribs: {
            ...attrs,
            'data-spindle-image': index,
            alt: (attrs.alt ?? 'Email image').slice(0, 500),
          },
        };
      },
    },
  });
  return {
    html: `${css ? `<style>${css}</style>` : ''}${hasBody ? safe : `<div class="${EMAIL_BODY_CLASS}">${safe}</div>`}`,
    resources,
  };
}

export function renderMessage(
  html: string,
  imageUrl: ((index: number) => string) | null,
  resourceCount: number,
) {
  const rewrite: RewriteImage = (src) => {
    const match = /^spindle-image:(\d{1,2})$/.exec(src);
    const index = Number(match?.[1]);
    return imageUrl && match && index < resourceCount ? imageUrl(index) : null;
  };
  const css = stylesFrom(html)
    .map((style) => sanitizeCss(style, rewrite))
    .join('\n');
  const safe = sanitizeHtml(html, {
    ...policy,
    allowedAttributes: {
      ...policy.allowedAttributes,
      img: ['src', 'alt', 'width', 'height'],
    },
    transformTags: {
      ...policy.transformTags,
      '*': (tag, attrs) => ({
        tagName: tag,
        attribs: layoutAttributes(attrs, rewrite),
      }),
      img: (_tag, attrs) => {
        const index = Number(attrs['data-spindle-image']);
        if (
          !imageUrl ||
          !/^\d{1,2}$/.test(attrs['data-spindle-image'] ?? '') ||
          index >= resourceCount
        )
          return {
            tagName: 'span',
            attribs: {
              class: attrs.class ?? '',
              style: `display:inline-block;${attrs.width ? `width:${attrs.width}${attrs.width.endsWith('%') ? '' : 'px'};` : ''}${attrs.height ? `height:${attrs.height}${attrs.height.endsWith('%') ? '' : 'px'};` : ''}${attrs.style ?? ''}`,
            },
            text: `[${attrs.alt ?? 'Image blocked'}]`,
          };
        return {
          tagName: 'img',
          attribs: {
            ...attrs,
            src: imageUrl(index),
            alt: attrs.alt ?? 'Email image',
          },
        };
      },
    },
  });
  return `${css ? `<style>${css}</style>` : ''}${safe}`;
}

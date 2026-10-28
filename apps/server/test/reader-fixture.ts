export const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rWQAAAAASUVORK5CYII=',
  'base64',
);

export function newsletterHtml(index: number) {
  return `<html><head><style>
    body.brand { margin:0; padding:24px; font-family:Arial,sans-serif; background-color:#eef2f6 }
    .newsletter { width:600px; border-collapse:collapse; background-color:#fff }
    .newsletter-title { font-size:28px; color:#123456 }
    .newsletter-content {padding:24px}
    @media only screen and (max-width:480px) {
      .newsletter {width:100%!important}
      .newsletter-title {font-size:20px!important}
      .newsletter-content {padding:12px!important}
    }
  </style></head><body class="brand" bgcolor="#eef2f6"><div id="preheader" style="display:none;max-height:0;overflow:hidden">Hidden newsletter preheader</div><center>
    <table class="newsletter" width="600" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#ffffff" role="presentation">
      <tr><td class="newsletter-content" valign="top" style="padding:24px">
        <h1 class="newsletter-title">Business newsletter</h1><p>Formatted body ${index}</p>
        <a class="newsletter-cta" href="https://example.test" style="display:inline-block;background-color:#123456;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">Shop now</a>
        <font id="legacy-font" face="Arial" color="#445566" size="3">Legacy newsletter text</font>
        <img class="newsletter-logo" src="https://images.example.test/pixel.png" width="120" height="40" style="display:block" alt="Brand logo">
        <img src="cid:inline@example.test" width="1" height="1">
        <script>parent.readerPwned=true</script>
        <p class="newsletter-hero" style="background-image:url(https://images.example.test/css);background-size:cover">Safe styled text</p>
      </td></tr>
    </table></center></body></html>`;
}

export function readerMail(
  subject: string,
  html = '<p>Private HTML body</p>',
  plain = 'Private plain body',
) {
  return `From: Reader Sender <sender@example.test>\r\nTo: Reader Recipient <recipient@example.test>\r\nSubject: ${subject}\r\nMessage-ID: <same-reader-id@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=related\r\n\r\n--related\r\nContent-Type: multipart/alternative; boundary=alternative\r\n\r\n--alternative\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n--alternative\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--alternative--\r\n--related\r\nContent-Type: image/png\r\nContent-ID: <inline@example.test>\r\nContent-Transfer-Encoding: base64\r\n\r\n${tinyPng.toString('base64')}\r\n--related--\r\n`;
}

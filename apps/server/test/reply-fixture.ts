export function replyMail(
  options: {
    subject?: string;
    from?: string;
    to?: string;
    cc?: string;
    replyTo?: string | null;
    messageId?: string | null;
    references?: string;
    plain?: string;
    htmlOnly?: boolean;
  } = {},
) {
  const headers = [
    `From: ${options.from ?? 'Author <author@example.test>'}`,
    `To: ${options.to ?? 'Writer <writer@example.test>, Other <other@example.test>, Alias <alias@example.test>'}`,
    `Cc: ${options.cc ?? 'copy@example.test, OTHER@EXAMPLE.TEST, login@example.test'}`,
    'Bcc: never-copy@example.test',
    `Subject: ${options.subject ?? 'Project question'}`,
    'Date: Wed, 28 Oct 2026 12:00:00 +0000',
    ...(options.replyTo === null
      ? []
      : [`Reply-To: ${options.replyTo ?? 'Support <support@example.test>'}`]),
    ...(options.messageId === null
      ? []
      : [`Message-ID: ${options.messageId ?? '<parent@example.test>'}`]),
    `References: ${options.references ?? '<root@example.test> <previous@example.test>'}`,
    'In-Reply-To: <previous@example.test>',
    'MIME-Version: 1.0',
    `Content-Type: ${options.htmlOnly ? 'text/html' : 'text/plain'}; charset=utf-8`,
  ].join('\r\n');
  return `${headers}\r\n\r\n${options.plain ?? (options.htmlOnly ? '<html><head><style>.hidden{background:url(https://tracker.example.test)}</style></head><body><p>Business newsletter</p><p>Second paragraph</p><img src="https://tracker.example.test/pixel"><script>parent.replyPwned=true</script></body></html>' : 'Original response body.')}\r\n`;
}

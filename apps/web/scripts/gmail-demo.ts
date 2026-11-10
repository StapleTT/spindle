// Drives a guided tour of Spindle's Gmail integration for Google's OAuth
// verification video. Screen-record the browser window yourself (OBS, etc.):
// Google wants the address bar, including the OAuth client_id, visible.
//
//   DEMO_EMAIL=reviewer@example.com DEMO_PASSWORD=… npm run demo:gmail
//
// Google sign-in and consent are always completed by hand; the script waits.
// Optional: DEMO_URL (defaults to APP_URL), DEMO_BROWSER (Chromium-based
// executable, e.g. /usr/bin/brave, if Google rejects the bundled Chromium),
// DEMO_DELAY (milliseconds between steps, default 1800).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const appUrl = new URL(
  process.env.DEMO_URL ?? process.env.APP_URL ?? 'http://127.0.0.1:5173',
).origin;
const delay = Number(process.env.DEMO_DELAY ?? 1800);
const pause = (ms = delay) => new Promise((resolve) => setTimeout(resolve, ms));

const context = await chromium.launchPersistentContext(
  // Separate profile so a Google sign-in survives reruns without touching yours.
  join(homedir(), '.cache', 'spindle-gmail-demo'),
  {
    headless: false,
    executablePath: process.env.DEMO_BROWSER || undefined,
    viewport: null,
    args: [
      '--window-size=1440,960',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  },
);
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(30000);

// Captions are drawn only on Spindle pages, never over Google's screens.
async function caption(text: string, ms = delay) {
  if (new URL(page.url()).origin === appUrl)
    await page.evaluate((value) => {
      let box = document.getElementById('spindle-demo-caption');
      if (!box) {
        box = document.createElement('div');
        box.id = 'spindle-demo-caption';
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText =
          'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:min(760px,90vw);padding:14px 22px;border-radius:14px;background:rgba(20,22,30,.92);color:#fff;font:600 17px/1.45 system-ui,sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none';
        document.body.append(box);
      }
      box.textContent = value;
    }, text);
  console.log(`▸ ${text}`);
  await pause(ms);
}

async function step(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    // Keep the recording going; a skipped step is easier to fix than a restart.
    console.warn(
      `  skipped "${name}": ${(error as Error).message.split('\n')[0]}`,
    );
  }
}

async function openInbox(target: Page) {
  await target.goto(`${appUrl}/inbox`);
  await target.getByRole('list', { name: 'Messages' }).waitFor();
}

await step('home page', async () => {
  await page.goto(appUrl);
  await caption(
    'Spindle is an email client that brings Gmail and IMAP mail into one private inbox.',
  );
  await page.locator('.site-footer').scrollIntoViewIfNeeded();
  await caption(
    'The Privacy Policy and Terms of Service are linked from the home page.',
  );
});

await step('sign in', async () => {
  await page.goto(`${appUrl}/login`);
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;
  if (email && password) {
    await caption('Sign in to Spindle.', 800);
    await page
      .getByLabel('Email address')
      .pressSequentially(email, { delay: 40 });
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } else console.log('▸ Sign in to Spindle in the browser window…');
  await page.waitForURL((url) => url.pathname === '/inbox', {
    timeout: 300000,
  });
});

// DEMO_TO overrides the recipient; otherwise the demo mails the connected Gmail address.
let recipient = process.env.DEMO_TO ?? '';
let subject = '';
await step('connect Gmail', async () => {
  await page.goto(`${appUrl}/inbox#view=settings`);
  await caption('Gmail accounts are connected from Settings.');
  await page.getByRole('button', { name: 'Connect Gmail account' }).click();
  await caption(
    'Choose how much mail history to sync, then continue to Google.',
  );
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  console.log('▸ Complete Google sign-in and consent in the browser window…');
  await page.waitForURL((url) => url.hostname === 'accounts.google.com');
  await page.waitForURL((url) => url.origin === appUrl, { timeout: 600000 });
  await page
    .getByText('Gmail connected. Labels and mail sync in the background')
    .waitFor();
  await caption(
    'Gmail is connected. Spindle stores an encrypted access grant, never the Google password.',
    3000,
  );
  recipient ||=
    (
      await page
        .locator('.account-row', { hasText: 'Gmail' })
        .last()
        .textContent()
    )?.match(/[^\s@]+@[^\s@]+\.[a-z]+/i)?.[0] ?? '';
});

await step('read mail', async () => {
  await openInbox(page);
  await caption('Messages and labels sync from Gmail into the inbox.', 800);
  const first = page
    .getByRole('list', { name: 'Messages' })
    .locator('a.message-open')
    .first();
  await first.waitFor({ timeout: 120000 });
  await caption('Messages and labels sync from Gmail into the inbox.');
  subject = (await first.textContent())?.trim() ?? '';
  await first.click();
  await page.getByRole('article', { name: 'Message' }).waitFor();
  await caption(
    'Opening a message reads it from Gmail and displays it safely.',
    3000,
  );
});

await step('read and unread', async () => {
  const toggle = page.getByRole('button', { name: /^Mark as (un)?read$/ });
  await caption('Read state changes are applied in Gmail.', 800);
  await toggle.click();
  await pause();
  await toggle.click();
  await pause();
});

await step('archive and undo', async () => {
  await caption('Archive removes the Inbox label in Gmail…', 800);
  await page
    .getByRole('button', { name: 'Archive', exact: true })
    .first()
    .click();
  await pause();
  await caption('…and every action can be undone for five seconds.', 600);
  await page
    .getByRole('button', { name: /^Undo:/ })
    .first()
    .click();
  await pause();
});

await step('trash and restore', async () => {
  await openInbox(page);
  const row = page
    .getByRole('list', { name: 'Messages' })
    .getByRole('listitem')
    .filter({ hasText: subject })
    .first();
  await row.hover();
  await caption(
    'Trash moves a message to Gmail’s Trash. Spindle never permanently deletes mail.',
    800,
  );
  await page
    .getByRole('button', { name: `Move “${subject}” to trash` })
    .click();
  await pause();
  await page
    .getByRole('button', { name: /^Trash/ })
    .first()
    .click();
  await caption('Restore brings it back from Trash.', 800);
  const restore = page.getByRole('button', { name: `Restore “${subject}”` });
  await restore.first().hover();
  await restore.first().click();
  await pause();
});

await step('search', async () => {
  await openInbox(page);
  const word = subject.split(/\s+/).find((item) => item.length > 3) ?? subject;
  await caption('Search runs over mail already synced to Spindle.', 600);
  await page.getByLabel('Search mail').pressSequentially(word, { delay: 80 });
  await page.getByLabel('Search mail').press('Enter');
  await pause(2500);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
});

await step('send', async () => {
  if (!recipient) throw new Error('set DEMO_TO to choose a recipient');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await caption('Mail the user writes is sent through Gmail.', 600);
  const to = recipient;
  await page
    .getByLabel('To', { exact: true })
    .pressSequentially(to, { delay: 30 });
  await page
    .getByLabel('Subject', { exact: true })
    .pressSequentially('Spindle demo', { delay: 40 });
  await page
    .getByRole('textbox', { name: 'Message body', exact: true })
    .pressSequentially('Sent from Spindle through the Gmail API.', {
      delay: 25,
    });
  await pause(800);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await caption(
    'Sent. It appears in Gmail’s Sent folder like any other message.',
    4000,
  );
});

await step('disconnect', async () => {
  await page.goto(`${appUrl}/inbox#view=settings`);
  await page
    .getByRole('button', { name: 'Disconnect', exact: true })
    .first()
    .hover();
  await caption(
    'Disconnecting deletes Spindle’s copy of the mail and revokes Google access.',
    3500,
  );
});

await caption(
  'That is everything Spindle does with Gmail: read, organize and send, as the user chooses.',
  4000,
);
console.log('Done. Stop your recording, then close the browser.');
await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
await context.close();

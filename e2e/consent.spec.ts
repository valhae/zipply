import { expect, test, type Page } from '@playwright/test';
import {
  connect,
  openTabs,
  sent,
  skipWithoutWebRTC,
  status,
  verification,
  verify,
  words,
} from './webrtc';

// P5-03 (no skip path) and P5-05 (consent races) through the real app, real Worker and WebRTC.

test.describe.configure({ mode: 'default', timeout: 90_000 });
test.beforeEach(async ({ page }, testInfo) => skipWithoutWebRTC(page, testInfo));

const FILE = { name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') };
const blocked = (p: Page) =>
  expect(sent(p)).resolves.toMatchObject({ manifestBytes: 0, payloadBytes: 0 });

async function toWords(page: Page) {
  const tabs = await openTabs(page);
  await (
    await connect(tabs.sender, tabs.receiver, tabs.receiverName, FILE)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await words(tabs.sender, tabs.receiver);
  return tabs;
}

test('the keyboard reaches only the field, Check words and Mismatch; Escape cancels', async ({
  page,
}) => {
  const { sender, receiver } = await toWords(page);
  const reached = new Set<string>();
  // The first entry is where the dialog put focus when it opened.
  for (let i = 0; i < 7; i++) {
    if (i > 0) await receiver.keyboard.press('Tab');
    reached.add(
      await receiver.evaluate(() => {
        // Past the modal's last control, focus leaves for the browser UI (body), not the page.
        const el = document.activeElement as HTMLElement;
        if (el === document.body) return 'browser';
        return el.tagName === 'INPUT' ? 'field' : (el.textContent ?? '');
      }),
    );
  }
  reached.delete('browser');
  expect([...reached].sort()).toEqual(['Check words', 'Mismatch — cancel', 'field']);

  // Enter on an empty field is stopped by the browser and uses up no try.
  await verification(receiver).getByRole('textbox').focus();
  await receiver.keyboard.press('Enter');
  await expect(verification(receiver).getByRole('alert')).toHaveCount(0);

  await receiver.keyboard.press('Escape');
  await expect(status(receiver)).toContainText('Transfer canceled');
  await expect(status(sender)).toContainText('Transfer canceled');
  await blocked(sender);
});

test('URL flags and a reload during verification never skip it', async ({ page }) => {
  const { sender, receiver } = await toWords(page);
  // Reload with made-up "verified" flags: the session is gone, and it fails closed on both sides.
  await receiver.goto(receiver.url().replace('#', '?verified=1&sas=ok&skip=1#'));
  await expect(status(sender)).toContainText('connection was lost', { timeout: 20_000 });
  await expect(receiver.getByRole('dialog')).toHaveCount(0);
  await expect(receiver.locator('#connection-heading')).toHaveCount(0);
  await blocked(sender);
});

test('the sender cancels while the receiver reviews the files: nothing is sent (P5-05)', async ({
  page,
}) => {
  const { sender, receiver, receiverName } = await openTabs(page);
  await (
    await connect(sender, receiver, receiverName, FILE)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  const incoming = receiver.getByRole('dialog', { name: 'Incoming files' });
  await expect(incoming).toBeVisible();
  await sender.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(incoming).toBeHidden();
  await expect(status(receiver)).toContainText('Transfer canceled');
  expect((await sent(sender)).payloadBytes).toBe(0);
});

test('the verification dialog fits a 320 px phone without sideways scrolling', async ({
  page,
}, testInfo) => {
  // Headless Firefox on Windows crashes when resized below 1280 px (R9).
  test.skip(testInfo.project.name.startsWith('firefox'), 'R9: Firefox resize crash');
  const { receiver } = await toWords(page);
  await receiver.setViewportSize({ width: 320, height: 568 });
  const box = await verification(receiver).getByRole('list').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    320,
  );
  await expect(
    verification(receiver).getByRole('button', { name: 'Check words' }),
  ).toBeInViewport();
});

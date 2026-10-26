// Exercise the production page, not a second hand-written mock of its layout.
import assert from 'node:assert/strict';
import { join } from 'node:path';
export async function checkClassicLayout(page, artifacts) {
  const result = [];
  const original = page.viewportSize();
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.evaluate((scheme) => {
      const palette =
        scheme === 'light'
          ? ['#f3f3f3', '#202020', '#626262', '#cecece', '#ffffff', '#176d56', '#087c65']
          : ['#151719', '#dfdfdf', '#999999', '#34383d', '#22262a', '#387d70', '#76bfa9'];
      [
        'sideBar-background',
        'foreground',
        'descriptionForeground',
        'widget-border',
        'input-background',
        'button-background',
        'focusBorder',
      ].forEach((key, i) =>
        document.documentElement.style.setProperty('--vscode-' + key, palette[i]),
      );
    }, colorScheme);
    for (const viewport of [
      { width: 320, height: 640 },
      { width: 460, height: 940 },
      { width: 900, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.body.scrollHeight,
          header: rect('#workbench > header'),
          composer: rect('footer'),
          send: rect('#send'),
          transcript: rect('#transcript'),
          historyHidden: document.querySelector('#history').hidden,
        };
      });
      assert(geometry.scrollWidth <= viewport.width, 'page must not scroll horizontally');
      assert(geometry.scrollHeight <= viewport.height, 'only the transcript should scroll');
      assert(geometry.composer.bottom <= viewport.height + 1, 'composer must stay in view');
      assert(
        geometry.send.right <= viewport.width && geometry.send.left >= 0,
        'send must not wrap out of view',
      );
      assert(geometry.header.height < 60, 'compact classic toolbar');
      assert(geometry.transcript.height >= 200, 'conversation retains usable vertical space');
      assert(geometry.historyHidden, 'history must not occupy conversation space by default');
      await page.screenshot({
        path: join(artifacts, `classic-${colorScheme}-${viewport.width}.png`),
      });
      await page.getByRole('button', { name: '模型、思考和 Fast 设置', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '模型与思考设置', exact: true });
      const bounds = await dialog.boundingBox();
      assert(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= viewport.width + 1 &&
          bounds.y + bounds.height <= viewport.height + 1,
        'model controls fit viewport',
      );
      await page.screenshot({
        path: join(artifacts, `model-controls-${colorScheme}-${viewport.width}.png`),
      });
      await page.keyboard.press('Escape');
      assert(!(await dialog.isVisible()));
      result.push({ colorScheme, viewport, geometry, modelControls: bounds });
    }
  }
  await page.locator('#prompt').fill('layout navigation draft');
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  assert(await page.locator('#history').isVisible());
  const count = await page.locator('#history-items [role=option]').count();
  if (count <= 4)
    assert(await page.getByRole('button', { name: '展开历史列表', exact: true }).isDisabled());
  await page.screenshot({ path: join(artifacts, 'history-controls.png') });
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  assert.equal(await page.locator('#prompt').inputValue(), 'layout navigation draft');
  await page.getByRole('button', { name: '模型设置', exact: true }).first().click();
  assert(await page.locator('#management').isVisible());
  assert.equal(await page.locator('#chat-page').isVisible(), false);
  await page.getByPlaceholder('搜索模型或供应商', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, 'classic-model-settings.png') });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await page.locator('#prompt').inputValue(), 'layout navigation draft');
  await page.locator('#prompt').fill('');
  if (original) await page.setViewportSize(original);
  await page.emulateMedia({ colorScheme: 'dark' });
  return result;
}

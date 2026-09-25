import { test, expect } from '@playwright/test';

test('renders the first 3D-ready scene and accepts build selection', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('game-title')).toHaveText('First Contact');
  await expect(page.getByTestId('scene-status')).toHaveText('Scene online');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  const debugState = await page.evaluate(() => {
    const debugWindow = window as Window & {
      __ECHOES_DEBUG__?: { ready: boolean; objectCount: number };
    };
    return debugWindow.__ECHOES_DEBUG__;
  });

  expect(debugState?.ready).toBe(true);
  expect(debugState?.objectCount).toBeGreaterThan(0);

  const webglAvailable = await page.getByTestId('scene-canvas').evaluate((element) => {
    return Boolean((element as HTMLCanvasElement).getContext('webgl2'));
  });

  expect(webglAvailable).toBe(true);

  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await expect(page.getByTestId('selection-status')).toHaveText('Grove Lens ready');
  await expect(page.getByRole('button', { name: 'Grove Lens' })).toHaveAttribute('aria-pressed', 'true');

  await page.screenshot({ path: 'test-results/bootstrap.png', fullPage: true });
});

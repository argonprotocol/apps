import { expect, waitFor } from 'storybook/test';

export async function expectEventuallyVisible(element: Element | Promise<Element>): Promise<Element> {
  const resolved = await element;
  await waitFor(() => expect(resolved).toBeVisible());
  return resolved;
}

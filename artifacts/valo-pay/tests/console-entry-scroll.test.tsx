import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => {
  api.uninstall();
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(window, 'scrollX', { configurable: true, writable: true, value: 0 });
  Reflect.deleteProperty(window, 'visualViewport');
});
const offset = (x: number, y: number) => {
  Object.defineProperty(window, 'scrollX', { configurable: true, writable: true, value: x });
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y });
};
const zoom = (scale: number) => Object.defineProperty(window, 'visualViewport', { configurable: true, value: { scale } });

it('leaves a pinch-zoomed reader where they are, and resets the offset once they zoom out', async () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => offset(0, 0));
  renderApp('/overview');
  await screen.findByRole('heading', { name: 'Operations overview' });
  expect(scroll).not.toHaveBeenCalled();
  // iOS Safari moves the document as a pinch-zoomed reader pans: snapping it back would lose their place.
  zoom(2);
  offset(40, 120);
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('pageshow'));
  expect(scroll).not.toHaveBeenCalled();
  expect([window.scrollX, window.scrollY]).toEqual([40, 120]);
  zoom(1);
  window.dispatchEvent(new Event('scroll'));
  expect(scroll).toHaveBeenCalledOnce();
  expect([window.scrollX, window.scrollY]).toEqual([0, 0]);
});

it('leaves the document where a phone moved it to show a focused field above the keyboard', async () => {
  const user = userEvent.setup();
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => offset(0, 0));
  renderApp('/overview');
  await screen.findByRole('heading', { name: 'Operations overview' });
  const field = screen.getByRole('searchbox', { name: 'Find a page' });
  await user.click(field);
  offset(0, 180);
  window.dispatchEvent(new Event('scroll'));
  expect(scroll).not.toHaveBeenCalled();
  expect(window.scrollY).toBe(180);
  expect(document.activeElement).toBe(field);
  // Focus on something that takes no typing, such as the page itself, resets the offset as before.
  screen.getByRole('main').focus();
  window.dispatchEvent(new Event('scroll'));
  expect(scroll).toHaveBeenCalledOnce();
  expect(window.scrollY).toBe(0);
});

it('clears the public offset and late document restoration without resetting console queues or public scrolling', async () => {
  const user = userEvent.setup();
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(window, 'scrollX', { configurable: true, writable: true, value: 0 });
  });
  renderApp('/sign-in');
  const entry = await screen.findByRole('link', { name: 'Continue to the sandbox' });
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 361 });
  await user.click(entry);
  await screen.findByRole('heading', { name: 'Operations overview' });
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, left: 0, behavior: 'instant' });
  expect(document.activeElement?.id).toBe('main');

  await user.click(screen.getByRole('link', { name: 'Exceptions' }));
  await screen.findByRole('heading', { name: 'Exceptions', level: 1 });
  const high = await screen.findByRole('tab', { name: 'High severity (1)' });
  const main = screen.getByRole('main');
  main.scrollTop = 320;
  await user.click(high);
  expect(main.scrollTop).toBe(320);
  expect(scroll).toHaveBeenCalledTimes(1);

  // Browsers can restore or focus-scroll the outer document after layout effects.
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 19 });
  window.dispatchEvent(new Event('scroll'));
  expect(window.scrollY).toBe(0);
  expect(main.scrollTop).toBe(320);
  expect(scroll).toHaveBeenCalledTimes(2);
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 19 });
  window.dispatchEvent(new Event('pageshow'));
  expect(window.scrollY).toBe(0);
  expect(main.scrollTop).toBe(320);
  main.dispatchEvent(new Event('scroll'));
  expect(scroll).toHaveBeenCalledTimes(3);

  // Leaving the console removes the guard: the long public page can scroll.
  await user.click(screen.getAllByRole('link', { name: 'Valo Pay, payments, credit and cash operations. Go to home page' })[0]!);
  expect(document.querySelector('.console-shell')).toBeNull();
  const beforePublicScroll = scroll.mock.calls.length;
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 441 });
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('pageshow'));
  expect(window.scrollY).toBe(441);
  expect(scroll).toHaveBeenCalledTimes(beforePublicScroll);
});

import { act } from '@testing-library/react';
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
/** A visual viewport at the given zoom, as the browser keeps it: one object that reports its own resizes. */
const visualViewport = (scale: number) => {
  const viewport = Object.assign(new EventTarget(), { scale });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  return viewport;
};
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

it('leaves a pinch-zoomed reader where they are, and resets the offset once they zoom out, though no window scroll follows', async () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => offset(0, 0));
  const viewport = visualViewport(1);
  renderApp('/overview');
  await screen.findByRole('heading', { name: 'Overview' });
  expect(scroll).not.toHaveBeenCalled();
  // iOS Safari moves the document as a pinch-zoomed reader pans: snapping it back would lose their place.
  viewport.scale = 2;
  viewport.dispatchEvent(new Event('resize'));
  offset(40, 120);
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('pageshow'));
  expect(scroll).not.toHaveBeenCalled();
  expect([window.scrollX, window.scrollY]).toEqual([40, 120]);
  // Zooming back out scrolls no window, and the page cannot be dragged back: the viewport's resize resets it.
  viewport.scale = 1;
  viewport.dispatchEvent(new Event('resize'));
  expect(scroll).toHaveBeenCalledOnce();
  expect([window.scrollX, window.scrollY]).toEqual([0, 0]);
});

it('leaves the document where a phone moved it to show a focused field, and resets it once focus leaves the fields, though no window scroll follows', async () => {
  const user = userEvent.setup();
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => offset(0, 0));
  renderApp('/overview');
  await screen.findByRole('heading', { name: 'Overview' });
  const field = screen.getByRole('searchbox', { name: 'Find a page' });
  await user.click(field);
  offset(0, 180);
  window.dispatchEvent(new Event('scroll'));
  expect(scroll).not.toHaveBeenCalled();
  expect(window.scrollY).toBe(180);
  expect(document.activeElement).toBe(field);
  // Moving on to another field keeps the keyboard up, and the shift with it.
  screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }).focus();
  await nextFrame();
  expect(scroll).not.toHaveBeenCalled();
  expect(window.scrollY).toBe(180);
  // Focus leaving the fields, here for the page itself as after a route change, scrolls no window: the guard checks then.
  screen.getByRole('main').focus();
  await nextFrame();
  expect(scroll).toHaveBeenCalledOnce();
  expect(window.scrollY).toBe(0);
});

it('clears the public offset and late document restoration without resetting console queues or public scrolling', async () => {
  const user = userEvent.setup();
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(window, 'scrollX', { configurable: true, writable: true, value: 0 });
  });
  const viewport = visualViewport(1);
  renderApp('/sign-in');
  const entry = await screen.findByRole('link', { name: 'Continue to the sandbox' });
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 361 });
  await user.click(entry);
  await screen.findByRole('heading', { name: 'Overview' });
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

  // Leaving the console removes the guard: the long public page can scroll, and neither a viewport resize nor focus
  // leaving a link puts it back to the top, then or a frame later.
  await user.click(screen.getAllByRole('link', { name: 'Valo Pay, payments, credit and cash operations. Go to home page' })[0]!);
  expect(document.querySelector('.console-shell')).toBeNull();
  const beforePublicScroll = scroll.mock.calls.length;
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 441 });
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('pageshow'));
  viewport.dispatchEvent(new Event('resize'));
  const link = screen.getAllByRole('link')[0]!;
  link.focus();
  link.blur();
  await nextFrame();
  expect(window.scrollY).toBe(441);
  expect(scroll).toHaveBeenCalledTimes(beforePublicScroll);
});

it('drops the check it was waiting to make when the console is left within the same frame', async () => {
  const user = userEvent.setup();
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => offset(0, 0));
  renderApp('/overview');
  await screen.findByRole('heading', { name: 'Overview' });
  const field = screen.getByRole('searchbox', { name: 'Find a page' });
  await user.click(field);
  await nextFrame();
  const home = screen.getAllByRole('link', { name: 'Valo Pay, payments, credit and cash operations. Go to home page' })[0]!;
  // Focus leaving the field asks for a check a frame later; by then the console has gone and the public page scrolls.
  act(() => { field.blur(); home.click(); });
  expect(document.querySelector('.console-shell')).toBeNull();
  offset(0, 441);
  await nextFrame();
  expect(scroll).not.toHaveBeenCalled();
  expect(window.scrollY).toBe(441);
});

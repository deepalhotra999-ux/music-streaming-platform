import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// jsdom does not implement matchMedia; a couple of components guard on it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

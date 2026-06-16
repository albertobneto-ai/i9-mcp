import { AsyncLocalStorage } from 'async_hooks';
export const usageALS = new AsyncLocalStorage();
export function pushUsage(model, usage) {
  const store = usageALS.getStore();
  if (store && usage) store.push({ model, ...usage });
}

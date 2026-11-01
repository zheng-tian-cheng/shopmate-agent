// Unit tests use the frozen TS oracle as transport fixture. Real HTTP is tested separately.
import './catalog.ts';
import { catalog } from '../../lib/products.ts';
import { applyChanges } from './conditions.ts';
import { searchProducts, evaluateProduct } from './search.ts';
import type { Product } from '../../lib/products.ts';
const raw = (p: Product) => ({ id: p.id, brand: p.brand, model: p.model, displayName: p.name,
  wearingStyle: p.wearingStyle === 'unknown' ? null : p.wearingStyle, anc: p.anc === 'unknown' ? null : p.anc,
  ancSpec: p.ancSpec ?? null, priceCny: p.price.amount, priceType: p.price.type ?? null,
  priceConditions: p.price.conditions, priceVerifiedAt: p.price.verifiedAt, battery: p.battery ?? [], batteryConditions: p.batteryConditions,
  weight: p.weight ?? [], weightNote: p.weightNote ?? null, bluetooth: p.bluetooth ?? null, officialLink: p.officialLink ?? null, fieldSources: {}, notes: [] });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const path = String(url);
  if (path.endsWith('/conditions/apply')) return Response.json(applyChanges(body.state, body.changes, body.origin));
  if (path.endsWith('/products/search')) return Response.json({ matches: searchProducts(catalog(), body.state).map(m => ({ ...m, product: raw(m.product) })), evaluations: Object.fromEntries(catalog().map(p => [p.id, evaluateProduct(p, body.state)])) });
  throw new Error(`Unexpected unit-test request: ${path}`);
};

import raw from '../../../data/products.json' with { type: 'json' };
import { toProduct, IMAGE_FILE, currentImageMode, installCatalog } from '../../lib/products.ts';
import type { CatalogFile } from '../../lib/products.ts';
export const CATALOG_FILE = raw as CatalogFile;
export const REAL_PRODUCTS = CATALOG_FILE.products.map(p => toProduct(p, CATALOG_FILE.sources, IMAGE_FILE.images[p.id], currentImageMode(), IMAGE_FILE.demoImages));
installCatalog(REAL_PRODUCTS);

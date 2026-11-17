// 17 Nov 2026 (contract v45-guard): the Lair prices a tab itself, from Shopify, never from the page. Tests that put
// things on a tab stand in for Shopify with this catalogue: the prices and names their items always had.
export const TEST_TAB_PRICES = {
  5001: { price: 450, title: 'Pocky', variantTitle: 'Strawberry' },
  5002: { price: 300, title: 'Drinks', variantTitle: '$3 Drink' },
  5015: { price: 300, title: 'Drinks', variantTitle: '$3 Drink' },
  4401: { price: 350, title: 'Coke', variantTitle: 'Default Title' },
  4402: { price: 300, title: 'Chips', variantTitle: 'Salt and vinegar' },
  44100000000001: { price: 550, title: 'Flat white', variantTitle: 'Regular' },
  123: { price: 550, title: 'Flat white', variantTitle: '' },
};

/** Shopify's prices for a tab, from TEST_TAB_PRICES (a variant not in it is one Shopify doesn't know) */
export function shopifyTabPrices(lair, prices = TEST_TAB_PRICES) {
  lair.shopify.tabVariants = async (ids) => new Map(ids.filter((id) => prices[id]).map((id) => [id, { ...prices[id], sellable: true }]));
}

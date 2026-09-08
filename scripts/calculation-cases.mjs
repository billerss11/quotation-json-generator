// Shared regression inputs for offline tests and optional repository parity checks.
export const calculationCases = [
  {
    name: 'explicit cost-plus with a stored manual price',
    input: {
      totalsConfig: { globalMarkupRate: 10 },
      majorItems: [{ pricingMethod: 'cost_plus', unitCost: 100, manualUnitPrice: 200 }],
    },
    grandTotal: 110,
  },
  {
    name: 'unit markup and unit price round before multiplying quantity',
    input: { totalsConfig: { globalMarkupRate: 100 }, majorItems: [{ unitCost: 0.005, quantity: 7 }] },
    grandTotal: 0.14,
  },
  {
    name: 'half-cent group sum',
    input: { majorItems: [{ quantity: 0.1, children: [231.42, 139.87, 532.56].map((manualUnitPrice) => ({
      pricingMethod: 'manual_price', manualUnitPrice, unitCost: 0,
    })) }] },
    grandTotal: 90.39,
  },
  ...[6_000_000_000_000, 1e307].map((manualUnitPrice) => ({
    name: `finite manual price ${manualUnitPrice}`,
    input: { majorItems: [{ pricingMethod: 'manual_price', manualUnitPrice, unitCost: 0 }] },
    grandTotal: manualUnitPrice,
  })),
  {
    name: 'each extra charge rounds to cents before summation',
    input: { totalsConfig: { globalMarkupRate: 0, extraCharges: [
      { id: 'a', label: 'A', amount: 0.005 }, { id: 'b', label: 'B', amount: 0.005 },
    ] } },
    grandTotal: 100.02,
  },
  {
    name: 'legacy tax rate migrates into a tax class',
    input: { totalsConfig: { globalMarkupRate: 0, taxRate: 13 } },
    grandTotal: 113,
  },
  {
    name: 'explicit tax classes take precedence over the legacy rate',
    input: { totalsConfig: {
      globalMarkupRate: 0, taxRate: 13,
      taxClasses: [{ id: 'service', label: '6%', rate: 6 }], defaultTaxClassId: 'service',
    } },
    grandTotal: 106,
  },
  {
    name: 'currency keys and item currencies normalize together',
    input: { exchangeRates: { ' usd ': 1, eur: 0.9 }, majorItems: [{ unitCost: 100, costCurrency: ' eur ' }] },
    grandTotal: 90,
  },
  {
    name: 'mixed-tax fractional hierarchy',
    input: {
      totalsConfig: {
        globalMarkupRate: 216.6667, taxMode: 'mixed', defaultTaxClassId: 'low',
        taxClasses: [{ id: 'low', label: '5%', rate: 5 }, { id: 'high', label: '13%', rate: 13 }],
      },
      majorItems: [{ quantity: 0.5, children: [
        { quantity: 1.1, unitCost: 0.15, taxClassId: 'low' },
        { quantity: 3, unitCost: 0.004, taxClassId: 'high' },
        { quantity: 0.49, unitCost: 0.125, taxClassId: 'high' },
      ] }],
    },
    grandTotal: 0.4,
  },
]

export function createCalculationInput(patch = {}) {
  const input = {
    header: { quotationNumber: 'Q-REGRESSION-001', quotationDate: '2026-09-08', currency: 'USD', documentLocale: 'en-US' },
    totalsConfig: { globalMarkupRate: 0 },
    exchangeRates: { USD: 1 },
    majorItems: [{ unitCost: 100 }],
    ...patch,
  }
  let itemNumber = 0
  function completeItem(item) {
    const number = ++itemNumber
    return {
      id: `item-${number}`, name: `Item ${number}`, quantity: 1, quantityUnit: 'EA', costCurrency: 'USD',
      ...item,
      children: (item.children ?? []).map(completeItem),
    }
  }
  return { ...input, majorItems: input.majorItems.map(completeItem) }
}

import fs from 'node:fs/promises';

const SOURCE = 'https://raw.githubusercontent.com/tkm634-ux/tarkov-pve-report/502c8d7a9122970662006eb23467de2812c7157d/scripts/calculate-report.mjs';
const response = await fetch(SOURCE, { headers: { accept: 'text/plain' } });
if (!response.ok) throw new Error(`Failed to fetch pinned calculator: HTTP ${response.status}`);
let source = await response.text();

const craftLoopPattern = /\n    for \(const craft of crafts\) \{[\s\S]*?\n    \}\n\n    costMap\.set\(RUB_ID,/;
if (!craftLoopPattern.test(source)) throw new Error('Could not locate Hideout-craft acquisition loop');
source = source.replace(craftLoopPattern, '\n\n    costMap.set(RUB_ID,');

const assumptionNeedle = "ownedItems: 'no inventory assumption; inputs are valued at cheapest current realistic acquisition route',";
if (!source.includes(assumptionNeedle)) throw new Error('Could not locate acquisition assumption');
source = source.replace(
  assumptionNeedle,
  "ownedItems: 'no inventory assumption; inputs are valued at cheapest current non-Hideout-craft acquisition route',\n        acquisitionPolicy: 'Flea Market, direct Trader purchase, and Trader barter only; Hideout craft acquisition disabled',"
);

const runtimePath = new URL('./.calculate-report-no-hideout-craft-runtime.mjs', import.meta.url);
await fs.writeFile(runtimePath, source, 'utf8');
try {
  await import(`${runtimePath.href}?run=${Date.now()}`);
} finally {
  await fs.unlink(runtimePath).catch(() => {});
}

const crafts = JSON.parse(await fs.readFile('data/crafts.json', 'utf8'));

function saleStability(craft) {
  const outputs = Array.isArray(craft.outputs) ? craft.outputs : [];
  if (!outputs.length) return null;
  let weightedDeviation = 0;
  let grossWeight = 0;
  let allTrader = true;
  const outputDetails = [];

  for (const output of outputs) {
    const count = Number(output.count) || 1;
    const unitPrice = Number(output.unitPrice);
    const gross = Number(output.gross) > 0 ? Number(output.gross) : unitPrice * count;
    let deviationPct = null;
    let stabilitySource = null;

    if (output.methodType === 'trader') {
      deviationPct = 0;
      stabilitySource = 'fixed-trader-price';
    } else {
      allTrader = false;
      const current = Number(output.lastLowPrice ?? output.unitPrice);
      const avg24h = Number(output.avg24hPrice);
      if (current > 0 && avg24h > 0) {
        deviationPct = Math.abs(current - avg24h) / avg24h * 100;
        stabilitySource = 'current-vs-24h-average';
      }
    }

    if (deviationPct === null) return null;
    weightedDeviation += deviationPct * gross;
    grossWeight += gross;
    outputDetails.push({
      item: output.item,
      count,
      sellTo: output.sellTo,
      unitPrice: Math.round(unitPrice),
      gross: Math.round(gross),
      net: Math.round(Number(output.net) || 0),
      lastLowPrice: Number(output.lastLowPrice) > 0 ? Math.round(Number(output.lastLowPrice)) : null,
      avg24hPrice: Number(output.avg24hPrice) > 0 ? Math.round(Number(output.avg24hPrice)) : null,
      deviationPct: Math.round(deviationPct * 100) / 100,
      stabilitySource,
    });
  }

  const deviationPct = grossWeight > 0 ? weightedDeviation / grossWeight : null;
  return {
    deviationPct: deviationPct === null ? null : Math.round(deviationPct * 100) / 100,
    allTrader,
    outputDetails,
  };
}

const candidates = crafts
  .filter(craft => craft?.status === 'complete' && Number(craft.profit) > 0 && Number(craft.profitPerHour) > 0)
  .map(craft => {
    const stability = saleStability(craft);
    if (!stability) return null;
    const limitedMaterials = (Array.isArray(craft.materials) ? craft.materials : [])
      .filter(material => Number(material.buyLimit) > 0)
      .map(material => ({ item: material.item, buyLimit: material.buyLimit, method: material.method }));
    return {
      craftId: craft.craftId,
      station: craft.station,
      craft: craft.craft,
      durationMinutes: craft.durationMinutes,
      materialCost: craft.materialCost,
      profit: craft.profit,
      profitPerHour: craft.profitPerHour,
      sellTo: craft.sellTo,
      priceDeviationPct: stability.deviationPct,
      traderFixedSale: stability.allTrader,
      stabilityTier: stability.allTrader || stability.deviationPct <= 5 ? 'very-stable' : stability.deviationPct <= 10 ? 'stable' : 'volatile',
      limitedMaterials,
      outputs: stability.outputDetails,
    };
  })
  .filter(Boolean);

const stable = candidates
  .filter(row => row.traderFixedSale || row.priceDeviationPct <= 10)
  .sort((a, b) => b.profitPerHour - a.profitPerHour);
const veryStable = stable.filter(row => row.traderFixedSale || row.priceDeviationPct <= 5);

const bestByStation = [...new Set(stable.map(row => row.station))]
  .map(station => stable.find(row => row.station === station))
  .filter(Boolean);

const report = JSON.parse(await fs.readFile('data/report.json', 'utf8'));
report.stabilityRanking = {
  metric: 'Positive-profit crafts only. Trader-sale outputs are treated as 0% sale-price deviation. Flea-sale outputs use absolute deviation between current lastLowPrice and avg24hPrice. Stable <=10%; very-stable <=5%. Ranking is profitPerHour descending after stability filter.',
  stableThresholdPct: 10,
  veryStableThresholdPct: 5,
  eligibleStableCount: stable.length,
  eligibleVeryStableCount: veryStable.length,
  topStableProfitPerHour: stable.slice(0, 20),
  topVeryStableProfitPerHour: veryStable.slice(0, 20),
  bestStableByStation: bestByStation,
};
await fs.writeFile('data/report.json', JSON.stringify(report, null, 2));

const rub = value => `${Math.round(Number(value)).toLocaleString('en-US')} RUB`;
const lines = [
  '',
  '## Stable sale-price ranking',
  'Definition: positive-profit only; trader sale = 0% deviation; flea current vs 24h avg <=10%; ranked by profit/h.',
];
stable.slice(0, 20).forEach((row, index) => {
  const output = row.outputs[0];
  const stability = row.traderFixedSale ? 'fixed trader' : `${row.priceDeviationPct}% vs 24h avg`;
  lines.push(`${index + 1}. ${row.station} | ${row.craft} | profit ${rub(row.profit)} | ${rub(row.profitPerHour)}/h | sale ${output?.unitPrice?.toLocaleString('en-US') ?? 'N/A'} RUB each | ${stability}`);
});
await fs.appendFile('data/report.txt', `${lines.join('\n')}\n`);

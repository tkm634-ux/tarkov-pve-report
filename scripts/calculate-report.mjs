import fs from 'node:fs/promises';

const SOURCE = 'https://raw.githubusercontent.com/tkm634-ux/tarkov-pve-report/9a41e1618379cccdb24ac10a3133674410cf4619/scripts/calculate-report.mjs';
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

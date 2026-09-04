import fs from 'node:fs/promises';

const SOURCE = 'https://raw.githubusercontent.com/tkm634-ux/tarkov-pve-report/9a41e1618379cccdb24ac10a3133674410cf4619/scripts/calculate-special-systems.mjs';
const response = await fetch(SOURCE, { headers: { accept: 'text/plain' } });
if (!response.ok) throw new Error(`Failed to fetch pinned special-system calculator: HTTP ${response.status}`);
let source = await response.text();

const oldBest = `function bestAcquisition(item, crafts) {
  const candidates = serializedAcquisitionFromCrafts(item, crafts);
  const direct = directAcquisition(item);
  if (direct) candidates.push(direct);
  candidates.sort((a, b) => a.unitCost - b.unitCost);
  return candidates[0] ?? null;
}`;
const newBest = `function bestAcquisition(item, crafts) {
  const candidates = serializedAcquisitionFromCrafts(item, crafts).filter(candidate => candidate.type !== 'craft');
  const direct = directAcquisition(item);
  if (direct) candidates.push(direct);
  candidates.sort((a, b) => a.unitCost - b.unitCost);
  return candidates[0] ?? null;
}`;
if (!source.includes(oldBest)) throw new Error('Could not locate bestAcquisition');
source = source.replace(oldBest, newBest);

const runtimePath = new URL('./.calculate-special-no-hideout-craft-runtime.mjs', import.meta.url);
await fs.writeFile(runtimePath, source, 'utf8');
try {
  await import(`${runtimePath.href}?run=${Date.now()}`);
} finally {
  await fs.unlink(runtimePath).catch(() => {});
}

import fs from 'node:fs/promises';

const BASE = 'https://json.tarkov.dev/pve';
const RUB_ID = '5449016a4bdc2d6f028b456f';
const INTEL_CENTER_LEVEL = 3;
const HIDEOUT_MANAGEMENT_LEVEL = 0;
const MAX_PASSES = 40;
const SPECIAL_RANDOM_STATIONS = new Set(['scav-case', 'cultist-circle']);

const STATION_LABELS = {
  'workbench': 'Workbench',
  'lavatory': 'Lavatory',
  'nutrition-unit': 'Nutrition Unit',
  'medstation': 'Medstation',
  'intelligence-center': 'Intelligence Center',
  'booze-generator': 'Booze Generator',
  'water-collector': 'Water Collector',
  'scav-case': 'Scav Case',
  'cultist-circle': 'Cultist Circle',
  'bitcoin-farm': 'Bitcoin Farm',
};

async function fetchEnvelope(endpoint) {
  const r = await fetch(`${BASE}/${endpoint}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status}`);
  const envelope = await r.json();
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data')) {
    throw new Error(`${endpoint}: missing data envelope`);
  }
  return envelope;
}

async function fetchLocale(endpoint) {
  try {
    const env = await fetchEnvelope(`${endpoint}_en`);
    return env?.data && typeof env.data === 'object' ? env.data : {};
  } catch (error) {
    console.warn(`locale ${endpoint}_en unavailable:`, error instanceof Error ? error.message : String(error));
    return {};
  }
}

function records(value) {
  if (Array.isArray(value)) return value.filter(v => v && typeof v === 'object');
  if (value && typeof value === 'object') return Object.values(value).filter(v => v && typeof v === 'object');
  return [];
}

function idOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.id ?? value.uid ?? value._id ?? value.itemId ?? null;
  return null;
}

function countOf(part) {
  const n = Number(part?.count ?? part?.quantity ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isTool(part) {
  const a = part?.attributes;
  if (!a) return false;
  if (!Array.isArray(a) && typeof a === 'object') return a.tool === true || a.Tool === true;
  if (Array.isArray(a)) {
    return a.some(x => String(x?.type ?? x?.name ?? '').toLowerCase() === 'tool' && [true, 'true', 1, '1'].includes(x?.value ?? true));
  }
  return false;
}

function containedPart(part) {
  const id = idOf(part?.item);
  if (!id) return null;
  return { id, count: countOf(part), tool: isTool(part) };
}

function requiredParts(record, { skipTools = false } = {}) {
  const list = Array.isArray(record?.requiredItems) ? record.requiredItems : [];
  return list.map(containedPart).filter(Boolean).filter(x => !(skipTools && x.tool));
}

function outputParts(record) {
  if (record?.productItem) {
    const part = containedPart(record.productItem);
    return part ? [part] : [];
  }
  if (record?.offeredItem) {
    const part = containedPart(record.offeredItem);
    return part ? [part] : [];
  }
  const list = Array.isArray(record?.rewardItems) ? record.rewardItems : [];
  return list.map(containedPart).filter(Boolean);
}

function makeMap(list) {
  return new Map(list.map(x => [x.id, x]).filter(([id]) => typeof id === 'string'));
}

function titleFromSlug(value) {
  return String(value ?? '')
    .split('-')
    .filter(Boolean)
    .map(x => x.charAt(0).toUpperCase() + x.slice(1))
    .join(' ');
}

function translated(raw, locale, fallback = null) {
  if (typeof raw === 'string' && typeof locale?.[raw] === 'string') return locale[raw];
  return fallback ?? raw ?? null;
}

function itemLabel(item, locale) {
  if (!item) return null;
  return translated(item.name, locale, titleFromSlug(item.normalizedName) || item.id);
}

function traderLabel(trader, locale) {
  if (!trader) return 'Trader';
  return translated(trader.name, locale, titleFromSlug(trader.normalizedName) || trader.id);
}

function stationLabel(station) {
  if (!station) return 'Unknown';
  return STATION_LABELS[station.normalizedName] ?? titleFromSlug(station.normalizedName) ?? station.id;
}

function fleaAllowed(item) {
  if (!item) return false;
  const types = Array.isArray(item.types) ? item.types : [];
  return !types.includes('noFlea') && Number(item.lastLowPrice) > 0;
}

function directPurchaseCandidates(item, traderMap, traderLocale) {
  const out = [];
  if (fleaAllowed(item)) {
    out.push({
      unitCost: Number(item.lastLowPrice),
      method: 'Flea Market',
      type: 'flea',
      buyLimit: null,
      taskUnlock: null,
      ancestors: [],
    });
  }
  for (const offer of Array.isArray(item?.buyFromTrader) ? item.buyFromTrader : []) {
    const price = Number(offer?.priceRUB);
    if (!(price > 0)) continue;
    const trader = traderMap.get(idOf(offer?.trader) ?? offer?.trader);
    out.push({
      unitCost: price,
      method: `Trader purchase: ${traderLabel(trader, traderLocale)} LL${offer.minTraderLevel ?? '?'}`,
      type: 'trader',
      trader: traderLabel(trader, traderLocale),
      traderLevel: offer.minTraderLevel ?? null,
      buyLimit: offer.buyLimit ?? null,
      taskUnlock: idOf(offer.taskUnlock) ?? offer.taskUnlock ?? null,
      ancestors: [],
    });
  }
  return out.sort((a, b) => a.unitCost - b.unitCost);
}

function traderSellCandidates(item, traderMap, traderLocale) {
  const out = [];
  for (const offer of Array.isArray(item?.sellToTrader) ? item.sellToTrader : []) {
    const price = Number(offer?.priceRUB);
    if (!(price > 0)) continue;
    const trader = traderMap.get(idOf(offer?.trader) ?? offer?.trader);
    out.push({
      method: traderLabel(trader, traderLocale),
      type: 'trader',
      unitPrice: price,
      grossUnit: price,
    });
  }
  return out;
}

function fleaFee(item, unitPrice, count, flea) {
  if (!fleaAllowed(item)) return null;
  const basePrice = Number(item.basePrice);
  const price = Number(unitPrice);
  const qty = Number(count);
  const ti = Number(flea?.sellOfferFeeRate);
  const tr = Number(flea?.sellRequirementFeeRate);
  if (!(basePrice > 0 && price > 0 && qty > 0 && Number.isFinite(ti) && Number.isFinite(tr))) return null;

  const q = qty;
  const vo = basePrice;
  const vr = price;
  let po = Math.log10(vo / vr);
  if (vr < vo) po = Math.pow(po, 1.08);
  let pr = Math.log10(vr / vo);
  if (vr >= vo) pr = Math.pow(pr, 1.08);
  let fee = (vo * ti * Math.pow(4, po) * q) + (vr * tr * Math.pow(4, pr) * q);
  if (INTEL_CENTER_LEVEL >= 3) {
    let discount = 0.3;
    discount += discount * HIDEOUT_MANAGEMENT_LEVEL * 0.01;
    fee -= fee * discount;
  }
  if (!Number.isFinite(fee)) return null;
  return Math.round(Math.max(0, fee));
}

function bestSale(item, count, traderMap, traderLocale, flea) {
  const candidates = [];
  for (const t of traderSellCandidates(item, traderMap, traderLocale)) {
    const gross = t.unitPrice * count;
    candidates.push({ method: t.method, type: 'trader', unitPrice: t.unitPrice, gross, fee: 0, net: gross });
  }
  if (fleaAllowed(item)) {
    const unitPrice = Number(item.lastLowPrice);
    const gross = unitPrice * count;
    const fee = fleaFee(item, unitPrice, count, flea);
    if (fee !== null) candidates.push({ method: 'Flea Market', type: 'flea', unitPrice, gross, fee, net: gross - fee });
  }
  candidates.sort((a, b) => b.net - a.net);
  return candidates[0] ?? null;
}

function combinedInputCost(parts, costMap, outputId = null) {
  let total = 0;
  const ancestors = new Set();
  for (const part of parts) {
    const c = costMap.get(part.id);
    if (!c || !(Number(c.unitCost) > 0)) return null;
    total += c.unitCost * part.count;
    ancestors.add(part.id);
    for (const ancestor of c.ancestors ?? []) ancestors.add(ancestor);
  }
  if (outputId && ancestors.has(outputId)) return null;
  return { total, ancestors: [...ancestors] };
}

function buildCosts(items, crafts, barters, traderMap, traderLocale) {
  const costMap = new Map();
  costMap.set(RUB_ID, { unitCost: 1, method: 'RUB', type: 'currency', ancestors: [] });

  for (const item of items) {
    if (!item?.id) continue;
    const best = directPurchaseCandidates(item, traderMap, traderLocale)[0];
    if (best) costMap.set(item.id, best);
  }
  costMap.set(RUB_ID, { unitCost: 1, method: 'RUB', type: 'currency', ancestors: [] });

  let passes = 0;
  let converged = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    passes = pass + 1;
    let changed = false;

    for (const barter of barters) {
      const req = requiredParts(barter);
      const outputs = outputParts(barter);
      if (!req.length || !outputs.length) continue;
      for (const output of outputs) {
        const input = combinedInputCost(req, costMap, output.id);
        if (!input) continue;
        const candidate = input.total / output.count;
        const old = costMap.get(output.id)?.unitCost;
        if (candidate > 0 && (!old || candidate < old - 0.01)) {
          const trader = traderMap.get(idOf(barter.trader) ?? barter.trader);
          costMap.set(output.id, {
            unitCost: candidate,
            method: `Trader barter: ${traderLabel(trader, traderLocale)} LL${barter.minTraderLevel ?? '?'}`,
            type: 'barter',
            trader: traderLabel(trader, traderLocale),
            traderLevel: barter.minTraderLevel ?? null,
            buyLimit: barter.buyLimit ?? null,
            taskUnlock: idOf(barter.taskUnlock) ?? barter.taskUnlock ?? null,
            barterId: barter.id ?? null,
            ancestors: input.ancestors,
          });
          changed = true;
        }
      }
    }

    for (const craft of crafts) {
      if (SPECIAL_RANDOM_STATIONS.has(craft._stationNormalizedName)) continue;
      const req = requiredParts(craft, { skipTools: true });
      const outputs = outputParts(craft);
      if (!req.length || !outputs.length) continue;
      for (const output of outputs) {
        const input = combinedInputCost(req, costMap, output.id);
        if (!input) continue;
        const candidate = input.total / output.count;
        const old = costMap.get(output.id)?.unitCost;
        if (candidate > 0 && (!old || candidate < old - 0.01)) {
          costMap.set(output.id, {
            unitCost: candidate,
            method: `Hideout craft: ${craft._stationLabel} Lv${craft.level ?? '?'}`,
            type: 'craft',
            craftId: craft.id ?? null,
            taskUnlock: idOf(craft.taskUnlock) ?? craft.taskUnlock ?? null,
            ancestors: input.ancestors,
          });
          changed = true;
        }
      }
    }

    costMap.set(RUB_ID, { unitCost: 1, method: 'RUB', type: 'currency', ancestors: [] });
    if (!changed) {
      converged = true;
      break;
    }
  }

  return { costMap, passes, converged };
}

function round(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n)) : null; }
function round2(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null; }

function calculateCraft(craft, itemMap, itemLocale, costMap, traderMap, traderLocale, flea) {
  const reqAll = requiredParts(craft);
  const req = reqAll.filter(x => !x.tool);
  const tools = reqAll.filter(x => x.tool);
  const outputs = outputParts(craft);
  const duration = Number(craft.duration);
  const station = craft._stationLabel;
  const outputName = outputs.map(x => `${itemLabel(itemMap.get(x.id), itemLocale) ?? x.id} x${x.count}`).join(' + ') || craft.id;

  const base = {
    craftId: craft.id ?? null,
    station,
    stationId: craft.station ?? null,
    stationNormalizedName: craft._stationNormalizedName,
    stationLevel: craft.level ?? null,
    taskUnlock: idOf(craft.taskUnlock) ?? craft.taskUnlock ?? null,
    durationSeconds: Number.isFinite(duration) ? duration : null,
    durationMinutes: Number.isFinite(duration) ? round2(duration / 60) : null,
    craft: outputName,
    materials: [],
    tools: tools.map(x => ({ id: x.id, item: itemLabel(itemMap.get(x.id), itemLocale) ?? x.id, count: x.count })),
    outputs: [],
  };

  if (SPECIAL_RANDOM_STATIONS.has(craft._stationNormalizedName)) {
    return { ...base, status: 'special-random', reason: 'Random-return system; expected value is intentionally not invented.' };
  }
  if (!outputs.length) return { ...base, status: 'incomplete', reason: 'No productItem/offered output' };
  if (!(duration > 0)) return { ...base, status: 'incomplete', reason: 'Invalid duration' };

  let materialCost = 0;
  for (const part of req) {
    const item = itemMap.get(part.id);
    const cost = costMap.get(part.id);
    if (!item) return { ...base, status: 'incomplete', reason: `Missing material item ${part.id}` };
    if (!cost) return { ...base, status: 'incomplete', reason: `No acquisition price for ${itemLabel(item, itemLocale) ?? part.id}` };
    const subtotal = cost.unitCost * part.count;
    materialCost += subtotal;
    base.materials.push({
      id: part.id,
      item: itemLabel(item, itemLocale) ?? part.id,
      count: part.count,
      unitCost: round(cost.unitCost),
      subtotal: round(subtotal),
      method: cost.method,
      methodType: cost.type,
      buyLimit: cost.buyLimit ?? null,
      taskUnlock: cost.taskUnlock ?? null,
    });
  }

  let saleGross = 0;
  let fleaFees = 0;
  let netRevenue = 0;
  const destinations = new Set();
  for (const part of outputs) {
    const item = itemMap.get(part.id);
    if (!item) return { ...base, status: 'incomplete', reason: `Missing output item ${part.id}` };
    const sale = bestSale(item, part.count, traderMap, traderLocale, flea);
    if (!sale) return { ...base, status: 'incomplete', reason: `No sale price for ${itemLabel(item, itemLocale) ?? part.id}` };
    saleGross += sale.gross;
    fleaFees += sale.fee;
    netRevenue += sale.net;
    destinations.add(sale.method);
    base.outputs.push({
      id: part.id,
      item: itemLabel(item, itemLocale) ?? part.id,
      count: part.count,
      unitPrice: round(sale.unitPrice),
      gross: round(sale.gross),
      fee: round(sale.fee),
      net: round(sale.net),
      sellTo: sale.method,
      methodType: sale.type,
      lastLowPrice: round(item.lastLowPrice),
      avg24hPrice: round(item.avg24hPrice),
      updated: item.updated ?? null,
    });
  }

  const profit = netRevenue - materialCost;
  return {
    ...base,
    status: 'complete',
    materialCost: round(materialCost),
    saleGross: round(saleGross),
    fleaFee: round(fleaFees),
    netRevenue: round(netRevenue),
    profit: round(profit),
    profitPerHour: round(profit / duration * 3600),
    sellTo: [...destinations].join(' + '),
  };
}

function compact(r) {
  return {
    craftId: r.craftId,
    craft: r.craft,
    stationLevel: r.stationLevel,
    taskUnlock: r.taskUnlock,
    materialCost: r.materialCost,
    saleGross: r.saleGross,
    fleaFee: r.fleaFee,
    netRevenue: r.netRevenue,
    profit: r.profit,
    durationMinutes: r.durationMinutes,
    profitPerHour: r.profitPerHour,
    sellTo: r.sellTo,
    materials: r.materials,
    tools: r.tools,
    outputs: r.outputs,
  };
}

function reportText(report) {
  const rub = n => Number.isFinite(Number(n)) ? `${Math.round(Number(n)).toLocaleString('en-US')} RUB` : 'N/A';
  const lines = [
    `Mode: PvE`,
    `Calculated: ${report.metadata.calculatedAt}`,
    `Crafts scanned: ${report.counts.crafts}`,
    `Success: ${report.counts.calculatedSuccessfully}`,
    `Incomplete: ${report.counts.incomplete}`,
    `Special/random: ${report.counts.specialRandom}`,
    `Barters scanned: ${report.counts.barters}`,
    `Items loaded: ${report.counts.items}`,
    `Count integrity: ${report.counts.check}`,
    '',
  ];
  for (const station of report.stations) {
    lines.push(`## ${station.station}`);
    lines.push(`Scanned crafts: ${station.scannedCrafts}`);
    if (station.specialRandom) lines.push(`Random-system recipes: ${station.specialRandom} (EV not fabricated)`);
    lines.push('Profit/h TOP3');
    station.topProfitPerHour.forEach((r, i) => lines.push(`${i + 1}. ${r.craft} | profit ${rub(r.profit)} | ${rub(r.profitPerHour)}/h | ${r.sellTo}`));
    lines.push('Profit/craft TOP3');
    station.topProfitPerCraft.forEach((r, i) => lines.push(`${i + 1}. ${r.craft} | profit ${rub(r.profit)} | ${rub(r.profitPerHour)}/h | ${r.sellTo}`));
    lines.push('');
  }
  if (report.incomplete.length) {
    lines.push('## Incomplete');
    for (const r of report.incomplete) lines.push(`${r.station} | ${r.craft} | ${r.reason}`);
  }
  return lines.join('\n');
}

async function main() {
  const [craftsEnv, bartersEnv, itemsEnv, tradersEnv, hideoutEnv, itemLocale, traderLocale] = await Promise.all([
    fetchEnvelope('crafts'),
    fetchEnvelope('barters'),
    fetchEnvelope('items'),
    fetchEnvelope('traders'),
    fetchEnvelope('hideout'),
    fetchLocale('items'),
    fetchLocale('traders'),
  ]);

  const craftsRaw = records(craftsEnv.data);
  const barters = records(bartersEnv.data);
  const itemsData = itemsEnv.data;
  const items = records(itemsData?.items ?? itemsData);
  const traders = records(tradersEnv.data);
  const stations = records(hideoutEnv.data);
  const itemMap = makeMap(items);
  const traderMap = makeMap(traders);
  const stationMap = makeMap(stations);
  const flea = itemsData?.fleaMarket ?? null;

  const crafts = craftsRaw.map(craft => {
    const station = stationMap.get(idOf(craft.station) ?? craft.station);
    return {
      ...craft,
      _stationLabel: stationLabel(station),
      _stationNormalizedName: station?.normalizedName ?? String(craft.station ?? 'unknown'),
    };
  });

  const unresolvedStationCrafts = crafts.filter(c => !stationMap.has(idOf(c.station) ?? c.station)).map(c => c.id);
  const referencedIds = new Set();
  for (const craft of crafts) {
    for (const p of requiredParts(craft)) referencedIds.add(p.id);
    for (const p of outputParts(craft)) referencedIds.add(p.id);
  }
  for (const barter of barters) {
    for (const p of requiredParts(barter)) referencedIds.add(p.id);
    for (const p of outputParts(barter)) referencedIds.add(p.id);
  }
  const missingReferencedItems = [...referencedIds].filter(id => !itemMap.has(id));

  const engine = buildCosts(items, crafts, barters, traderMap, traderLocale);
  const results = crafts.map(craft => calculateCraft(craft, itemMap, itemLocale, engine.costMap, traderMap, traderLocale, flea));
  const complete = results.filter(x => x.status === 'complete');
  const incomplete = results.filter(x => x.status === 'incomplete');
  const specialRandom = results.filter(x => x.status === 'special-random');

  const stationGroups = new Map();
  for (const row of results) {
    if (!stationGroups.has(row.station)) stationGroups.set(row.station, []);
    stationGroups.get(row.station).push(row);
  }
  const stationReports = [...stationGroups.entries()].map(([station, rows]) => {
    const ok = rows.filter(x => x.status === 'complete');
    const random = rows.filter(x => x.status === 'special-random');
    return {
      station,
      scannedCrafts: rows.length,
      successful: ok.length,
      incomplete: rows.filter(x => x.status === 'incomplete').length,
      specialRandom: random.length,
      topProfitPerHour: [...ok].sort((a, b) => b.profitPerHour - a.profitPerHour).slice(0, 3).map(compact),
      topProfitPerCraft: [...ok].sort((a, b) => b.profit - a.profit).slice(0, 3).map(compact),
    };
  }).sort((a, b) => a.station.localeCompare(b.station));

  const updated = items
    .map(x => x.updated)
    .filter(Boolean)
    .map(x => new Date(x))
    .filter(x => !Number.isNaN(x.getTime()))
    .sort((a, b) => a - b);

  const report = {
    metadata: {
      mode: 'PvE',
      source: 'Tarkov.dev JSON API',
      calculatedAt: new Date().toISOString(),
      priceUpdatedRange: {
        oldest: updated[0]?.toISOString() ?? null,
        newest: updated.at(-1)?.toISOString() ?? null,
      },
      assumptions: {
        hideout: 'maximum levels',
        traderLL: 'maximum',
        fleaPurchasePrice: 'lastLowPrice',
        fleaSalePrice: 'lastLowPrice',
        fleaFee: 'Tarkov.dev itemResolver formula',
        intelCenterLevel: INTEL_CENTER_LEVEL,
        hideoutManagementLevel: HIDEOUT_MANAGEMENT_LEVEL,
        tools: 'required but not consumed; excluded from per-craft material cost',
        ownedItems: 'no inventory assumption; inputs are valued at cheapest current realistic acquisition route',
        fuel: 'regular craft ranking uses shared-generator marginal fuel cost = 0; continuous systems need a separate production model',
      },
    },
    counts: {
      crafts: crafts.length,
      barters: barters.length,
      items: items.length,
      calculatedSuccessfully: complete.length,
      incomplete: incomplete.length,
      specialRandom: specialRandom.length,
      check: complete.length + incomplete.length + specialRandom.length === crafts.length && crafts.length === craftsRaw.length,
    },
    integrity: {
      unresolvedStationCrafts,
      missingReferencedItems,
      referencedUniqueItems: referencedIds.size,
    },
    acquisitionEngine: {
      converged: engine.converged,
      passes: engine.passes,
      pricedItems: engine.costMap.size,
    },
    fleaMarket: flea,
    stations: stationReports,
    incomplete: incomplete.map(x => ({ craftId: x.craftId, station: x.station, craft: x.craft, reason: x.reason })),
    specialRandom: specialRandom.map(x => ({ craftId: x.craftId, station: x.station, craft: x.craft, durationMinutes: x.durationMinutes, reason: x.reason, materials: x.materials })),
    specialSystems: {
      bitcoinFarm: { status: 'separate-model-required' },
      scavCase: { status: 'random-return; exact PvE EV intentionally not fabricated' },
      cultistCircle: { status: 'random-return; exact PvE EV intentionally not fabricated' },
    },
  };

  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/report.json', JSON.stringify(report, null, 2));
  await fs.writeFile('data/report.txt', reportText(report));
  await fs.writeFile('data/crafts.json', JSON.stringify(results, null, 2));
  await fs.writeFile('data/integrity.json', JSON.stringify({
    mode: 'pve',
    source: 'Tarkov.dev JSON API',
    totals: { crafts: crafts.length, barters: barters.length, items: items.length, referencedUniqueItems: referencedIds.size },
    integrity: {
      countMatch: report.counts.check,
      unresolvedStationCrafts: unresolvedStationCrafts.length,
      missingReferencedItems: missingReferencedItems.length,
    },
    unresolvedStationCraftIds: unresolvedStationCrafts,
    missingReferencedItemIds: missingReferencedItems,
  }, null, 2));

  console.log(JSON.stringify({ counts: report.counts, integrity: report.integrity, engine: report.acquisitionEngine }, null, 2));
  if (!report.counts.check || unresolvedStationCrafts.length || missingReferencedItems.length) process.exitCode = 2;
}

await main();

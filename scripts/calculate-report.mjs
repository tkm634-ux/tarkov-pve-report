import fs from 'node:fs/promises';

const BASE = 'https://json.tarkov.dev/pve';
const RUB_ID = '5449016a4bdc2d6f028b456f';
const USD_ID = '5696686a4bdc2da3298b456a';
const EUR_ID = '569668774bdc2da2298b4568';
const INTEL_CENTER_LEVEL = 3;
const HIDEOUT_MANAGEMENT_LEVEL = 0;
const MAX_PASSES = 40;

async function get(endpoint) {
  const r = await fetch(`${BASE}/${endpoint}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status}`);
  const envelope = await r.json();
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data')) {
    throw new Error(`${endpoint}: missing data envelope`);
  }
  return envelope.data;
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
    return a.some(x => {
      const key = String(x?.type ?? x?.name ?? '').toLowerCase();
      const val = x?.value ?? true;
      return key === 'tool' && (val === true || val === 'true' || val === 1 || val === '1');
    });
  }
  return false;
}

function partsOf(record, key, { skipTools = false } = {}) {
  const list = Array.isArray(record?.[key]) ? record[key] : [];
  return list.map(part => ({
    id: idOf(part?.item),
    count: countOf(part),
    tool: isTool(part),
  })).filter(x => x.id && !(skipTools && x.tool));
}

function itemPayloadItems(itemsData) {
  const candidate = itemsData?.items ?? itemsData;
  return records(candidate);
}

function buildMap(list) {
  return new Map(list.map(x => [x.id, x]).filter(([id]) => typeof id === 'string'));
}

function flattenHideoutCrafts(hideoutData) {
  const map = new Map();
  for (const station of records(hideoutData)) {
    for (const level of records(station.levels)) {
      for (const craft of records(level.crafts)) {
        const id = craft.id;
        if (!id) continue;
        map.set(id, {
          ...craft,
          _stationId: station.id ?? idOf(craft.station),
          _stationName: station.name ?? station.normalizedName ?? station.id ?? idOf(craft.station) ?? 'Unknown',
          _stationLevel: Number(craft.level ?? level.level ?? 0),
        });
      }
    }
  }
  return [...map.values()];
}

function fleaAllowed(item) {
  if (!item) return false;
  const types = Array.isArray(item.types) ? item.types : [];
  return !types.includes('noFlea') && Number(item.lastLowPrice) > 0;
}

function traderSellOffers(item, traderMap) {
  const out = [];
  for (const p of Array.isArray(item?.traderPrices) ? item.traderPrices : []) {
    const price = Number(p?.priceRUB ?? p?.price);
    if (!(price > 0)) continue;
    const tid = idOf(p?.trader) ?? p?.trader;
    const t = traderMap.get(tid);
    out.push({
      method: t?.name ?? p?.source ?? tid ?? 'Trader',
      unit: price,
      type: 'trader',
    });
  }
  for (const p of Array.isArray(item?.sellFor) ? item.sellFor : []) {
    const vendorName = p?.vendor?.name ?? p?.vendor?.normalizedName ?? p?.source ?? '';
    if (String(vendorName).toLowerCase().includes('flea')) continue;
    const price = Number(p?.priceRUB ?? p?.price);
    if (price > 0) out.push({ method: vendorName || 'Trader', unit: price, type: 'trader' });
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

function bestSale(item, count, traderMap, flea) {
  const offers = [];
  for (const t of traderSellOffers(item, traderMap)) {
    const gross = t.unit * count;
    offers.push({ method: t.method, type: t.type, unitPrice: t.unit, gross, fee: 0, net: gross });
  }
  if (fleaAllowed(item)) {
    const unit = Number(item.lastLowPrice);
    const gross = unit * count;
    const fee = fleaFee(item, unit, count, flea);
    if (fee !== null) offers.push({ method: 'Flea Market', type: 'flea', unitPrice: unit, gross, fee, net: gross - fee });
  }
  offers.sort((a, b) => b.net - a.net);
  return offers[0] ?? null;
}

function totalCost(parts, costMap) {
  let total = 0;
  for (const p of parts) {
    const c = costMap.get(p.id);
    if (!c || !(Number(c.unitCost) > 0)) return null;
    total += c.unitCost * p.count;
  }
  return total;
}

function traderName(barter, traderMap) {
  const tid = idOf(barter?.trader) ?? barter?.trader;
  return traderMap.get(tid)?.name ?? barter?.sourceName ?? barter?.source ?? tid ?? 'Trader';
}

function buildCosts(items, crafts, barters, traderMap) {
  const costMap = new Map();
  costMap.set(RUB_ID, { unitCost: 1, method: 'RUB', type: 'currency' });

  for (const item of items) {
    if (!item?.id) continue;
    if (fleaAllowed(item)) {
      costMap.set(item.id, {
        unitCost: Number(item.lastLowPrice),
        method: 'Flea Market',
        type: 'flea',
      });
    }
  }

  let passes = 0;
  let converged = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    passes = pass + 1;
    let changed = false;

    for (const barter of barters) {
      const req = partsOf(barter, 'requiredItems');
      const rew = partsOf(barter, 'rewardItems');
      if (!req.length || !rew.length) continue;
      const input = totalCost(req, costMap);
      if (input === null) continue;
      for (const out of rew) {
        if (out.id === RUB_ID || req.some(x => x.id === out.id)) continue;
        const candidate = input / out.count;
        const old = costMap.get(out.id)?.unitCost;
        if (candidate > 0 && (!old || candidate < old - 0.01)) {
          const cash = req.every(x => [RUB_ID, USD_ID, EUR_ID].includes(x.id));
          costMap.set(out.id, {
            unitCost: candidate,
            method: `${cash ? 'Trader purchase' : 'Trader barter'}: ${traderName(barter, traderMap)} LL${barter.level ?? '?'}`,
            type: cash ? 'trader' : 'barter',
            taskUnlock: idOf(barter.taskUnlock) ?? barter.taskUnlock ?? null,
          });
          changed = true;
        }
      }
    }

    for (const craft of crafts) {
      const req = partsOf(craft, 'requiredItems', { skipTools: true });
      const rew = partsOf(craft, 'rewardItems');
      if (!req.length || !rew.length) continue;
      const input = totalCost(req, costMap);
      if (input === null) continue;
      for (const out of rew) {
        if (req.some(x => x.id === out.id)) continue;
        const candidate = input / out.count;
        const old = costMap.get(out.id)?.unitCost;
        if (candidate > 0 && (!old || candidate < old - 0.01)) {
          costMap.set(out.id, {
            unitCost: candidate,
            method: `Hideout craft: ${craft._stationName} Lv${craft._stationLevel}`,
            type: 'craft',
            craftId: craft.id,
            taskUnlock: idOf(craft.taskUnlock) ?? craft.taskUnlock ?? null,
          });
          changed = true;
        }
      }
    }

    costMap.set(RUB_ID, { unitCost: 1, method: 'RUB', type: 'currency' });
    if (!changed) {
      converged = true;
      break;
    }
  }
  return { costMap, passes, converged };
}

function round(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n)) : null; }
function round2(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null; }

function calculateCraft(craft, itemMap, costMap, traderMap, flea) {
  const reqAll = partsOf(craft, 'requiredItems');
  const req = reqAll.filter(x => !x.tool);
  const tools = reqAll.filter(x => x.tool);
  const rew = partsOf(craft, 'rewardItems');
  const duration = Number(craft.duration);
  const base = {
    craftId: craft.id,
    station: craft._stationName,
    stationId: craft._stationId,
    stationLevel: craft._stationLevel,
    taskUnlock: idOf(craft.taskUnlock) ?? craft.taskUnlock ?? null,
    durationSeconds: Number.isFinite(duration) ? duration : null,
    durationMinutes: Number.isFinite(duration) ? round2(duration / 60) : null,
    status: 'complete',
    craft: rew.map(x => `${itemMap.get(x.id)?.name ?? x.id} x${x.count}`).join(' + ') || craft.id,
    materials: [],
    tools: tools.map(x => ({ id: x.id, item: itemMap.get(x.id)?.name ?? x.id, count: x.count })),
    outputs: [],
  };

  if (!req.length && !tools.length) return { ...base, status: 'incomplete', reason: 'No requiredItems' };
  if (!rew.length) return { ...base, status: 'incomplete', reason: 'No rewardItems in hideout data' };
  if (!(duration > 0)) return { ...base, status: 'incomplete', reason: 'Invalid duration' };

  let materialCost = 0;
  for (const p of req) {
    const item = itemMap.get(p.id);
    const c = costMap.get(p.id);
    if (!item) return { ...base, status: 'incomplete', reason: `Missing material item ${p.id}` };
    if (!c) return { ...base, status: 'incomplete', reason: `No acquisition price for ${item.name ?? p.id}` };
    const subtotal = c.unitCost * p.count;
    materialCost += subtotal;
    base.materials.push({
      id: p.id,
      item: item.name ?? p.id,
      count: p.count,
      unitCost: round(c.unitCost),
      subtotal: round(subtotal),
      method: c.method,
      methodType: c.type,
    });
  }

  let saleGross = 0;
  let fees = 0;
  let netRevenue = 0;
  const destinations = new Set();
  for (const p of rew) {
    const item = itemMap.get(p.id);
    if (!item) return { ...base, status: 'incomplete', reason: `Missing output item ${p.id}` };
    const sale = bestSale(item, p.count, traderMap, flea);
    if (!sale) return { ...base, status: 'incomplete', reason: `No sale price for ${item.name ?? p.id}` };
    saleGross += sale.gross;
    fees += sale.fee;
    netRevenue += sale.net;
    destinations.add(sale.method);
    base.outputs.push({
      id: p.id,
      item: item.name ?? p.id,
      count: p.count,
      unitPrice: round(sale.unitPrice),
      gross: round(sale.gross),
      fee: round(sale.fee),
      net: round(sale.net),
      sellTo: sale.method,
      methodType: sale.type,
      lastLowPrice: round(item.lastLowPrice),
      avg24hPrice: round(item.avg24hPrice),
    });
  }

  const profit = netRevenue - materialCost;
  return {
    ...base,
    materialCost: round(materialCost),
    saleGross: round(saleGross),
    fleaFee: round(fees),
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
  const f = n => Number.isFinite(Number(n)) ? `${Math.round(Number(n)).toLocaleString('en-US')} RUB` : 'N/A';
  const lines = [
    `Mode: PvE`,
    `Calculated: ${report.metadata.calculatedAt}`,
    `Crafts authoritative: ${report.counts.authoritativeCrafts}`,
    `Crafts from hideout: ${report.counts.hideoutCrafts}`,
    `Success: ${report.counts.calculatedSuccessfully}`,
    `Incomplete: ${report.counts.incomplete}`,
    `Barters scanned: ${report.counts.barters}`,
    `Items loaded: ${report.counts.items}`,
    `Count integrity: ${report.counts.check}`,
    '',
  ];
  for (const s of report.stations) {
    lines.push(`## ${s.station}`);
    lines.push(`Scanned crafts: ${s.scannedCrafts}`);
    lines.push('Profit/h TOP3');
    s.topProfitPerHour.forEach((r, i) => lines.push(`${i + 1}. ${r.craft} | profit ${f(r.profit)} | ${f(r.profitPerHour)}/h | ${r.sellTo}`));
    lines.push('Profit/craft TOP3');
    s.topProfitPerCraft.forEach((r, i) => lines.push(`${i + 1}. ${r.craft} | profit ${f(r.profit)} | ${f(r.profitPerHour)}/h | ${r.sellTo}`));
    lines.push('');
  }
  if (report.incomplete.length) {
    lines.push('## Incomplete');
    for (const r of report.incomplete) lines.push(`${r.station} | ${r.craft} | ${r.reason}`);
  }
  return lines.join('\n');
}

async function main() {
  const [hideoutData, craftsData, bartersData, itemsData, tradersData] = await Promise.all([
    get('hideout'), get('crafts'), get('barters'), get('items'), get('traders'),
  ]);

  const hideoutCrafts = flattenHideoutCrafts(hideoutData);
  const authoritativeCrafts = records(craftsData);
  const barters = records(bartersData);
  const items = itemPayloadItems(itemsData);
  const traders = records(tradersData);
  const itemMap = buildMap(items);
  const traderMap = buildMap(traders);
  const flea = itemsData?.fleaMarket ?? null;

  const hideoutIds = new Set(hideoutCrafts.map(x => x.id));
  const authIds = new Set(authoritativeCrafts.map(x => x.id));
  const missingFromHideout = [...authIds].filter(id => !hideoutIds.has(id));
  const extraInHideout = [...hideoutIds].filter(id => !authIds.has(id));

  const engine = buildCosts(items, hideoutCrafts, barters, traderMap);
  const results = hideoutCrafts.map(c => calculateCraft(c, itemMap, engine.costMap, traderMap, flea));
  const complete = results.filter(x => x.status === 'complete');
  const incomplete = results.filter(x => x.status !== 'complete');

  const stationMap = new Map();
  for (const r of results) {
    if (!stationMap.has(r.station)) stationMap.set(r.station, []);
    stationMap.get(r.station).push(r);
  }
  const stations = [...stationMap.entries()].map(([station, rows]) => {
    const ok = rows.filter(x => x.status === 'complete');
    return {
      station,
      scannedCrafts: rows.length,
      successful: ok.length,
      incomplete: rows.length - ok.length,
      topProfitPerHour: [...ok].sort((a, b) => b.profitPerHour - a.profitPerHour).slice(0, 3).map(compact),
      topProfitPerCraft: [...ok].sort((a, b) => b.profit - a.profit).slice(0, 3).map(compact),
    };
  }).sort((a, b) => String(a.station).localeCompare(String(b.station)));

  const updated = items.map(x => x.updated).filter(Boolean).map(x => new Date(x)).filter(x => !Number.isNaN(x.getTime())).sort((a, b) => a - b);
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
        fuel: 'regular craft ranking uses shared-generator marginal fuel cost = 0; continuous systems require separate model',
      },
    },
    counts: {
      authoritativeCrafts: authoritativeCrafts.length,
      hideoutCrafts: hideoutCrafts.length,
      barters: barters.length,
      items: items.length,
      calculatedSuccessfully: complete.length,
      incomplete: incomplete.length,
      check: authoritativeCrafts.length === hideoutCrafts.length && complete.length + incomplete.length === hideoutCrafts.length,
    },
    integrity: {
      missingCraftIdsFromHideout: missingFromHideout,
      extraCraftIdsInHideout: extraInHideout,
    },
    acquisitionEngine: {
      converged: engine.converged,
      passes: engine.passes,
      pricedItems: engine.costMap.size,
    },
    fleaMarket: flea,
    stations,
    incomplete: incomplete.map(x => ({ craftId: x.craftId, station: x.station, craft: x.craft, reason: x.reason })),
  };

  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/report.json', JSON.stringify(report, null, 2));
  await fs.writeFile('data/report.txt', reportText(report));
  await fs.writeFile('data/integrity.json', JSON.stringify({
    mode: 'pve',
    source: 'Tarkov.dev JSON API',
    totals: { crafts: authoritativeCrafts.length, hideoutCrafts: hideoutCrafts.length, barters: barters.length, items: items.length },
    integrity: {
      missingCraftIdsFromHideout: missingFromHideout.length,
      extraCraftIdsInHideout: extraInHideout.length,
      countMatch: authoritativeCrafts.length === hideoutCrafts.length,
    },
    missingCraftIds: missingFromHideout,
    extraCraftIds: extraInHideout,
  }, null, 2));

  console.log(JSON.stringify({ counts: report.counts, integrity: report.integrity, engine: report.acquisitionEngine }, null, 2));
  if (!report.counts.check) process.exitCode = 2;
}

await main();

import fs from 'node:fs/promises';

const BASE = 'https://json.tarkov.dev/pve';
const HIDEOUT_MANAGEMENT_LEVEL = 0;
const SOLAR_POWER = true;
const FUEL_UNITS_PER_HOUR = SOLAR_POWER ? 2.375 : 4.75;
const SPEC_VERIFIED_AT = '2026-09-03';

const BITCOIN_BASE_SECONDS = 300000;
const BITCOIN_GPU_FACTOR = 0.041225;
const BITCOIN_GPU_COUNTS = [1, 10, 25, 50];

const FUEL_SPECS = [
  { normalizedName: 'expeditionary-fuel-tank', capacity: 60 },
  { normalizedName: 'metal-fuel-tank', capacity: 100 },
];

const SCAV_CASE_OPTIONS = [
  {
    key: '2500-rubles',
    inputType: 'roubles',
    amount: 2500,
    durationSeconds: 2500,
    rewardCount: [1, 3],
    risk: 'Low stake, high outcome variance',
    highValueHits: ['Rare loot is possible, but current PvE probabilities are not published'],
  },
  {
    key: '15000-rubles',
    inputType: 'roubles',
    amount: 15000,
    durationSeconds: 7700,
    rewardCount: [2, 4],
    risk: 'Low-to-moderate stake, high outcome variance',
    highValueHits: ['Barter items and weapon-related loot; exact PvE probabilities unavailable'],
  },
  {
    key: '95000-rubles',
    inputType: 'roubles',
    amount: 95000,
    durationSeconds: 8100,
    rewardCount: [2, 5],
    risk: 'Moderate stake, high outcome variance',
    highValueHits: ['Keys, containers and valuable barter/gear drops are reported; exact PvE probabilities unavailable'],
  },
  {
    key: 'moonshine',
    inputType: 'item',
    normalizedName: 'bottle-of-fierce-hatchling-moonshine',
    amount: 1,
    durationSeconds: 16800,
    rewardCount: [4, 6],
    risk: 'High stake, very high outcome variance',
    highValueHits: ['Rare barter, quest and streamer-item categories; exact PvE probabilities unavailable'],
  },
  {
    key: 'intelligence-folder',
    inputType: 'item',
    normalizedName: 'intelligence-folder',
    amount: 1,
    durationSeconds: 19200,
    rewardCount: [4, 7],
    risk: 'High stake, very high outcome variance',
    highValueHits: ['Keys and intelligence-related rare loot categories; exact PvE probabilities unavailable'],
  },
];

async function fetchEnvelope(endpoint) {
  const response = await fetch(`${BASE}/${endpoint}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  const envelope = await response.json();
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data')) {
    throw new Error(`${endpoint}: missing data envelope`);
  }
  return envelope;
}

function records(value) {
  if (Array.isArray(value)) return value.filter(v => v && typeof v === 'object');
  if (value && typeof value === 'object') return Object.values(value).filter(v => v && typeof v === 'object');
  return [];
}

function round(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
}

function round2(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null;
}

function findItem(items, normalizedName) {
  const exact = items.find(item => item?.normalizedName === normalizedName);
  if (exact) return exact;
  const needle = normalizedName.replaceAll('-', ' ').toLowerCase();
  return items.find(item => String(item?.normalizedName ?? '').replaceAll('-', ' ').toLowerCase() === needle) ?? null;
}

function directAcquisition(item) {
  if (!item) return null;
  const candidates = [];
  if (Number(item.lastLowPrice) > 0 && !(Array.isArray(item.types) && item.types.includes('noFlea'))) {
    candidates.push({ unitCost: Number(item.lastLowPrice), method: 'Flea Market', type: 'flea' });
  }
  for (const offer of Array.isArray(item.buyFromTrader) ? item.buyFromTrader : []) {
    const price = Number(offer?.priceRUB);
    if (price > 0) {
      candidates.push({
        unitCost: price,
        method: `Trader purchase (${offer.trader ?? 'unknown trader'}) LL${offer.minTraderLevel ?? '?'}`,
        type: 'trader',
      });
    }
  }
  candidates.sort((a, b) => a.unitCost - b.unitCost);
  return candidates[0] ?? null;
}

function serializedAcquisitionFromCrafts(item, crafts) {
  if (!item?.id) return [];
  const candidates = [];

  for (const craft of crafts) {
    if (craft?.status === 'complete') {
      for (const material of Array.isArray(craft.materials) ? craft.materials : []) {
        if (material?.id !== item.id) continue;
        const unitCost = Number(material.unitCost);
        if (unitCost > 0) {
          candidates.push({
            unitCost,
            method: material.method ?? 'Existing acquisition engine',
            type: material.methodType ?? 'serialized-engine',
          });
        }
      }

      for (const output of Array.isArray(craft.outputs) ? craft.outputs : []) {
        if (output?.id !== item.id) continue;
        const outputCount = Number(output.count);
        const materialCost = Number(craft.materialCost);
        if (outputCount > 0 && materialCost > 0) {
          candidates.push({
            unitCost: materialCost / outputCount,
            method: `Hideout craft: ${craft.station} Lv${craft.stationLevel ?? '?'}`,
            type: 'craft',
          });
        }
      }
    }
  }

  return candidates;
}

function bestAcquisition(item, crafts) {
  const candidates = serializedAcquisitionFromCrafts(item, crafts);
  const direct = directAcquisition(item);
  if (direct) candidates.push(direct);
  candidates.sort((a, b) => a.unitCost - b.unitCost);
  return candidates[0] ?? null;
}

function findCompleteCraft(crafts, stationNormalizedName, predicate = () => true) {
  return crafts.find(craft => craft?.status === 'complete' && craft?.stationNormalizedName === stationNormalizedName && predicate(craft)) ?? null;
}

function allCompleteCrafts(crafts, stationNormalizedName) {
  return crafts.filter(craft => craft?.status === 'complete' && craft?.stationNormalizedName === stationNormalizedName);
}

function buildFuelModel(items, crafts) {
  const options = [];
  for (const spec of FUEL_SPECS) {
    const item = findItem(items, spec.normalizedName);
    const acquisition = bestAcquisition(item, crafts);
    if (!item || !acquisition) {
      options.push({
        itemId: item?.id ?? null,
        item: item?.name ?? spec.normalizedName,
        capacity: spec.capacity,
        status: 'incomplete',
        reason: !item ? 'Fuel item not found in Tarkov.dev items' : 'No acquisition price for fuel item',
      });
      continue;
    }
    const runtimeHours = spec.capacity / FUEL_UNITS_PER_HOUR;
    const costPerHour = acquisition.unitCost / runtimeHours;
    options.push({
      itemId: item.id,
      item: item.name ?? spec.normalizedName,
      normalizedName: item.normalizedName,
      capacity: spec.capacity,
      acquisitionCost: round(acquisition.unitCost),
      acquisitionMethod: acquisition.method,
      runtimeHours: round2(runtimeHours),
      costPerHour: round2(costPerHour),
      costPerDay: round(costPerHour * 24),
      status: 'complete',
    });
  }

  const usable = options.filter(option => option.status === 'complete').sort((a, b) => a.costPerHour - b.costPerHour);
  const cheapest = usable[0] ?? null;
  return {
    solarPower: SOLAR_POWER,
    hideoutManagementLevel: HIDEOUT_MANAGEMENT_LEVEL,
    fuelUnitsPerHour: FUEL_UNITS_PER_HOUR,
    residualEmptyCanValueCredited: false,
    residualValueNote: 'Conservative fuel cost: static Tarkov.dev item data does not expose a reliable resource-state value for an empty can, so no residual empty-can value is credited.',
    options,
    cheapest,
    dailyFuelCost: cheapest?.costPerDay ?? null,
  };
}

function buildBitcoinModel(items, crafts, fuelModel) {
  const gpu = findItem(items, 'graphics-card');
  const gpuAcquisition = bestAcquisition(gpu, crafts);
  const bitcoinCraft = findCompleteCraft(crafts, 'bitcoin-farm');
  const bitcoinOutput = bitcoinCraft?.outputs?.[0] ?? null;
  const bitcoinUnitNet = bitcoinOutput && Number(bitcoinOutput.count) > 0 ? Number(bitcoinOutput.net) / Number(bitcoinOutput.count) : null;
  const fuelPerDay = Number(fuelModel.dailyFuelCost);

  if (!gpu || !gpuAcquisition || !bitcoinCraft || !(bitcoinUnitNet > 0)) {
    return {
      status: 'incomplete',
      reason: 'Missing Graphics card acquisition price, Bitcoin craft, or Bitcoin sale value',
    };
  }

  const variants = BITCOIN_GPU_COUNTS.map(gpuCount => {
    const secondsPerBitcoin = BITCOIN_BASE_SECONDS / (1 + (gpuCount - 1) * BITCOIN_GPU_FACTOR);
    const bitcoinsPerDay = 86400 / secondsPerBitcoin;
    const revenuePerDay = bitcoinUnitNet * bitcoinsPerDay;
    const netPerDay = Number.isFinite(fuelPerDay) ? revenuePerDay - fuelPerDay : null;
    const gpuCapital = gpuAcquisition.unitCost * gpuCount;
    return {
      gpuCount,
      secondsPerBitcoin: round(secondsPerBitcoin),
      hoursPerBitcoin: round2(secondsPerBitcoin / 3600),
      bitcoinsPerDay: round2(bitcoinsPerDay),
      bitcoinNetSaleEach: round(bitcoinUnitNet),
      saleDestination: bitcoinOutput.sellTo ?? bitcoinCraft.sellTo ?? null,
      revenuePerDay: round(revenuePerDay),
      fuelCostPerDay: Number.isFinite(fuelPerDay) ? round(fuelPerDay) : null,
      netProfitPerDay: netPerDay === null ? null : round(netPerDay),
      gpuUnitAcquisitionCost: round(gpuAcquisition.unitCost),
      gpuAcquisitionMethod: gpuAcquisition.method,
      installedGpuCapital: round(gpuCapital),
      simpleCapitalPaybackDays: netPerDay > 0 ? round2(gpuCapital / netPerDay) : null,
    };
  });

  return {
    status: 'complete',
    formula: '300000 / (1 + (GC - 1) * 0.041225) seconds per Physical Bitcoin',
    formulaSource: 'Official Escape from Tarkov Wiki - Hideout / Bitcoin Farm',
    formulaVerifiedAt: SPEC_VERIFIED_AT,
    graphicsCard: {
      itemId: gpu.id,
      acquisitionCost: round(gpuAcquisition.unitCost),
      acquisitionMethod: gpuAcquisition.method,
    },
    variants,
  };
}

function buildContinuousCraftModel(craft, fuelModel) {
  const durationSeconds = Number(craft.durationSeconds);
  if (!(durationSeconds > 0)) return null;
  const cyclesPerDay = 86400 / durationSeconds;
  const beforeFuel = Number(craft.profit) * cyclesPerDay;
  const dailyFuelCost = Number(fuelModel.dailyFuelCost);
  return {
    craftId: craft.craftId,
    station: craft.station,
    craft: craft.craft,
    durationSeconds: round(durationSeconds),
    durationHours: round2(durationSeconds / 3600),
    cyclesPerDay: round2(cyclesPerDay),
    materialCostPerCycle: craft.materialCost,
    netRevenuePerCycle: craft.netRevenue,
    profitPerCycleBeforeFuel: craft.profit,
    profitPerDayBeforeFuel: round(beforeFuel),
    standaloneFuelCostPerDay: Number.isFinite(dailyFuelCost) ? round(dailyFuelCost) : null,
    profitPerDayStandalone: Number.isFinite(dailyFuelCost) ? round(beforeFuel - dailyFuelCost) : null,
    profitPerDayMarginalIfGeneratorAlreadyRunning: round(beforeFuel),
    materials: craft.materials,
    outputs: craft.outputs,
    sellTo: craft.sellTo,
  };
}

function buildContinuousProduction(crafts, fuelModel) {
  const booze = allCompleteCrafts(crafts, 'booze-generator').map(craft => buildContinuousCraftModel(craft, fuelModel)).filter(Boolean);
  const water = allCompleteCrafts(crafts, 'water-collector').map(craft => buildContinuousCraftModel(craft, fuelModel)).filter(Boolean);
  const bestWater = [...water].sort((a, b) => b.profitPerDayBeforeFuel - a.profitPerDayBeforeFuel)[0] ?? null;
  const bestBooze = [...booze].sort((a, b) => b.profitPerDayBeforeFuel - a.profitPerDayBeforeFuel)[0] ?? null;
  return {
    fuelPolicy: {
      standalone: 'Each station is charged the full daily generator fuel cost when evaluated alone.',
      marginal: 'If the generator is already running for another station, additional shared fuel is treated as 0 RUB marginal cost.',
      combined: 'Combined operation counts generator fuel only once.',
    },
    waterCollector: {
      scannedCompleteCrafts: water.length,
      crafts: water,
      recommendedByDailyProfitBeforeFuel: bestWater,
    },
    boozeGenerator: {
      scannedCompleteCrafts: booze.length,
      crafts: booze,
      recommendedByDailyProfitBeforeFuel: bestBooze,
    },
  };
}

function buildScavCase(items, crafts) {
  const evMessage = '信頼できるPvEサンプル不足のため正確な期待値は算出不可';
  const options = SCAV_CASE_OPTIONS.map(option => {
    if (option.inputType === 'roubles') {
      return {
        ...option,
        input: `${option.amount.toLocaleString('en-US')} RUB`,
        investmentCost: option.amount,
        investmentMethod: 'Roubles',
        durationMinutes: round2(option.durationSeconds / 60),
        expectedReturn: null,
        expectedProfit: null,
        profitPerHour: null,
        evStatus: evMessage,
      };
    }

    const item = findItem(items, option.normalizedName);
    const acquisition = bestAcquisition(item, crafts);
    return {
      ...option,
      input: item?.name ?? option.normalizedName,
      inputItemId: item?.id ?? null,
      investmentCost: acquisition ? round(acquisition.unitCost * option.amount) : null,
      investmentMethod: acquisition?.method ?? null,
      durationMinutes: round2(option.durationSeconds / 60),
      expectedReturn: null,
      expectedProfit: null,
      profitPerHour: null,
      evStatus: evMessage,
      incompleteReason: acquisition ? null : 'No current acquisition price for Scav Case input item',
    };
  });

  return {
    status: 'ev-unavailable',
    fenceReputationAssumption: 'Base turnaround times are shown; actual turnaround is affected by Fence reputation.',
    source: 'Official Escape from Tarkov Wiki, cross-checked with current Japanese EFT Wiki craft table',
    sourceVerifiedAt: SPEC_VERIFIED_AT,
    expectedValuePolicy: evMessage,
    options,
  };
}

function appendSpecialText(existing, report) {
  const rub = n => Number.isFinite(Number(n)) ? `${Math.round(Number(n)).toLocaleString('en-US')} RUB` : 'N/A';
  const lines = [existing.trimEnd(), '', '## Special systems'];

  const fuel = report.specialSystems.fuel;
  lines.push('### Generator fuel');
  lines.push(`Solar Power: ${fuel.solarPower}; Hideout Management: ${fuel.hideoutManagementLevel}`);
  if (fuel.cheapest) lines.push(`Cheapest current fuel: ${fuel.cheapest.item} | ${rub(fuel.cheapest.costPerDay)}/day | ${fuel.cheapest.acquisitionMethod}`);
  lines.push(fuel.residualValueNote);
  lines.push('');

  const bitcoin = report.specialSystems.bitcoinFarm;
  lines.push('### Bitcoin Farm');
  if (bitcoin.status === 'complete') {
    for (const row of bitcoin.variants) {
      lines.push(`${row.gpuCount} GPU | ${row.hoursPerBitcoin} h/BTC | ${row.bitcoinsPerDay} BTC/day | revenue ${rub(row.revenuePerDay)}/day | fuel ${rub(row.fuelCostPerDay)}/day | net ${rub(row.netProfitPerDay)}/day`);
    }
  } else {
    lines.push(`Incomplete: ${bitcoin.reason}`);
  }
  lines.push('');

  const continuous = report.specialSystems.continuousProduction;
  lines.push('### Water Collector continuous production');
  for (const row of continuous.waterCollector.crafts) {
    lines.push(`${row.craft} | ${row.cyclesPerDay} cycles/day | ${rub(row.profitPerCycleBeforeFuel)}/cycle | ${rub(row.profitPerDayBeforeFuel)}/day before fuel | ${rub(row.profitPerDayStandalone)}/day standalone`);
  }
  lines.push('');
  lines.push('### Booze Generator continuous production');
  for (const row of continuous.boozeGenerator.crafts) {
    lines.push(`${row.craft} | ${row.cyclesPerDay} cycles/day | ${rub(row.profitPerCycleBeforeFuel)}/cycle | ${rub(row.profitPerDayBeforeFuel)}/day before fuel | ${rub(row.profitPerDayStandalone)}/day standalone`);
  }
  lines.push('');

  const scav = report.specialSystems.scavCase;
  lines.push('### Scav Case');
  lines.push(scav.expectedValuePolicy);
  for (const row of scav.options) {
    lines.push(`${row.input} | investment ${rub(row.investmentCost)} | ${row.durationMinutes} min | rewards ${row.rewardCount[0]}-${row.rewardCount[1]} items | EV N/A | ${row.risk}`);
  }
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const [reportText, reportJson, craftsJson, itemsEnvelope] = await Promise.all([
    fs.readFile('data/report.txt', 'utf8'),
    fs.readFile('data/report.json', 'utf8').then(JSON.parse),
    fs.readFile('data/crafts.json', 'utf8').then(JSON.parse),
    fetchEnvelope('items'),
  ]);

  const itemsData = itemsEnvelope.data;
  const items = records(itemsData?.items ?? itemsData);
  const crafts = Array.isArray(craftsJson) ? craftsJson : [];

  const fuel = buildFuelModel(items, crafts);
  const bitcoinFarm = buildBitcoinModel(items, crafts, fuel);
  const continuousProduction = buildContinuousProduction(crafts, fuel);
  const scavCase = buildScavCase(items, crafts);

  const bestWater = continuousProduction.waterCollector.recommendedByDailyProfitBeforeFuel;
  const bestBooze = continuousProduction.boozeGenerator.recommendedByDailyProfitBeforeFuel;
  const bitcoin50 = bitcoinFarm.status === 'complete' ? bitcoinFarm.variants.find(row => row.gpuCount === 50) : null;
  const sharedFuel = Number(fuel.dailyFuelCost);
  const combinedDailyNet = bitcoin50 && Number.isFinite(sharedFuel)
    ? round(Number(bitcoin50.revenuePerDay) + Number(bestWater?.profitPerDayBeforeFuel ?? 0) + Number(bestBooze?.profitPerDayBeforeFuel ?? 0) - sharedFuel)
    : null;

  reportJson.metadata.assumptions = {
    ...(reportJson.metadata.assumptions ?? {}),
    fuel: 'Regular craft ranking uses shared-generator marginal fuel cost = 0. Special continuous-production models separately show standalone fuel cost, marginal fuel cost, and combined shared-fuel operation.',
    solarPower: SOLAR_POWER,
    specialSystemSpecVerifiedAt: SPEC_VERIFIED_AT,
  };

  reportJson.specialSystems = {
    fuel,
    bitcoinFarm,
    continuousProduction,
    scavCase,
    cultistCircle: {
      status: 'random-return',
      expectedValue: null,
      note: 'Exact PvE expected value is intentionally not fabricated.',
    },
    combinedDailyOperation: {
      scenario: '50 GPU Bitcoin Farm + highest daily-profit Water Collector craft + highest daily-profit Booze Generator craft; generator fuel counted once',
      bitcoinGpuCount: 50,
      waterCraft: bestWater?.craft ?? null,
      boozeCraft: bestBooze?.craft ?? null,
      sharedFuelCostPerDay: Number.isFinite(sharedFuel) ? round(sharedFuel) : null,
      netProfitPerDay: combinedDailyNet,
    },
  };

  const updatedText = appendSpecialText(reportText, reportJson);

  await fs.writeFile('data/report.json', JSON.stringify(reportJson, null, 2));
  await fs.writeFile('data/report.txt', updatedText);
  await fs.writeFile('data/special-systems.json', JSON.stringify(reportJson.specialSystems, null, 2));

  console.log(JSON.stringify({
    fuel: { dailyFuelCost: fuel.dailyFuelCost, cheapest: fuel.cheapest?.item ?? null },
    bitcoinStatus: bitcoinFarm.status,
    bitcoinVariants: bitcoinFarm.status === 'complete' ? bitcoinFarm.variants.length : 0,
    waterCrafts: continuousProduction.waterCollector.scannedCompleteCrafts,
    boozeCrafts: continuousProduction.boozeGenerator.scannedCompleteCrafts,
    scavCaseOptions: scavCase.options.length,
    combinedDailyNet,
  }, null, 2));

  if (bitcoinFarm.status !== 'complete' || scavCase.options.length !== 5 || !fuel.cheapest) {
    process.exitCode = 2;
  }
}

await main();

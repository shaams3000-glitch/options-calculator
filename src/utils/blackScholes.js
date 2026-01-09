// Standard Normal Distribution Functions
function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Calculate d1 and d2 for Black-Scholes
function calculateD1D2(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) {
    return { d1: 0, d2: 0 };
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return { d1, d2 };
}

// Black-Scholes Option Pricing
export function calculateOptionPrice(S, K, T, r, sigma, optionType) {
  // S: Current stock price
  // K: Strike price
  // T: Time to expiration (in years)
  // r: Risk-free interest rate (annual)
  // sigma: Implied volatility (annual)
  // optionType: 'call' or 'put'

  if (T <= 0) {
    // At expiration
    if (optionType === 'call') {
      return Math.max(0, S - K);
    } else {
      return Math.max(0, K - S);
    }
  }

  const { d1, d2 } = calculateD1D2(S, K, T, r, sigma);

  if (optionType === 'call') {
    return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
  } else {
    return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
  }
}

// Calculate Greeks
export function calculateGreeks(S, K, T, r, sigma, optionType) {
  if (T <= 0 || sigma <= 0) {
    // At or past expiration
    const intrinsic = optionType === 'call'
      ? Math.max(0, S - K)
      : Math.max(0, K - S);
    return {
      delta: optionType === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0),
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
      price: intrinsic
    };
  }

  const { d1, d2 } = calculateD1D2(S, K, T, r, sigma);
  const sqrtT = Math.sqrt(T);
  const expRT = Math.exp(-r * T);
  const nd1 = normalCDF(d1);
  const nd2 = normalCDF(d2);
  const npd1 = normalPDF(d1);

  let delta, theta, rho;
  const price = calculateOptionPrice(S, K, T, r, sigma, optionType);

  if (optionType === 'call') {
    delta = nd1;
    theta = (-S * npd1 * sigma / (2 * sqrtT)) - (r * K * expRT * nd2);
    rho = K * T * expRT * nd2;
  } else {
    delta = nd1 - 1;
    theta = (-S * npd1 * sigma / (2 * sqrtT)) + (r * K * expRT * normalCDF(-d2));
    rho = -K * T * expRT * normalCDF(-d2);
  }

  // Gamma and Vega are the same for calls and puts
  const gamma = npd1 / (S * sigma * sqrtT);
  const vega = S * sqrtT * npd1;

  return {
    delta,
    gamma,
    theta: theta / 365, // Convert to daily theta
    vega: vega / 100,   // Per 1% change in IV
    rho: rho / 100,     // Per 1% change in rate
    price
  };
}

// Calculate break-even price
export function calculateBreakEven(K, premium, optionType) {
  if (optionType === 'call') {
    return K + premium;
  } else {
    return K - premium;
  }
}

// Calculate P&L for a position
export function calculatePnL(S, K, T, r, sigma, optionType, premium, currentPrice = null) {
  const optionValue = currentPrice !== null
    ? currentPrice
    : calculateOptionPrice(S, K, T, r, sigma, optionType);

  return optionValue - premium;
}

// Generate P&L data for payoff chart (at expiration)
export function generatePayoffData(K, premium, optionType, currentPrice, range = 0.3) {
  const minPrice = Math.max(0, currentPrice * (1 - range));
  const maxPrice = currentPrice * (1 + range);
  const step = (maxPrice - minPrice) / 100;

  const data = [];
  for (let price = minPrice; price <= maxPrice; price += step) {
    let intrinsicValue;
    if (optionType === 'call') {
      intrinsicValue = Math.max(0, price - K);
    } else {
      intrinsicValue = Math.max(0, K - price);
    }
    const pnl = intrinsicValue - premium;

    data.push({
      stockPrice: parseFloat(price.toFixed(2)),
      pnl: parseFloat(pnl.toFixed(2)),
      intrinsic: parseFloat(intrinsicValue.toFixed(2))
    });
  }

  return data;
}

// Generate P&L heatmap data (price x date)
export function generateHeatmapData(K, premium, optionType, currentPrice, daysToExpiry, sigma, r = 0.05) {
  const priceRange = 0.25; // +/- 25% from current price
  const minPrice = Math.max(1, currentPrice * (1 - priceRange));
  const maxPrice = currentPrice * (1 + priceRange);
  const priceStep = (maxPrice - minPrice) / 15; // 16 price points

  const data = [];

  // Generate date intervals (every few days until expiry)
  const dateIntervals = [];
  const dayStep = Math.max(1, Math.floor(daysToExpiry / 8));
  for (let d = 0; d <= daysToExpiry; d += dayStep) {
    dateIntervals.push(d);
  }
  if (dateIntervals[dateIntervals.length - 1] !== daysToExpiry) {
    dateIntervals.push(daysToExpiry);
  }

  // Generate price points
  const pricePoints = [];
  for (let p = maxPrice; p >= minPrice; p -= priceStep) {
    pricePoints.push(parseFloat(p.toFixed(2)));
  }

  // Calculate P&L for each cell
  for (const price of pricePoints) {
    const row = { stockPrice: price };
    for (const day of dateIntervals) {
      const T = (daysToExpiry - day) / 365;
      const optionValue = calculateOptionPrice(price, K, T, r, sigma, optionType);
      const pnl = optionValue - premium;
      row[`day${day}`] = parseFloat(pnl.toFixed(2));
    }
    data.push(row);
  }

  return { data, dateIntervals, pricePoints };
}

// Days between two dates
export function daysBetween(date1, date2) {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs((date2 - date1) / oneDay));
}

// ============================================================
// MULTI-LEG STRATEGY CALCULATIONS
// ============================================================

// Strategy leg definition
// { optionType: 'call'|'put', action: 'buy'|'sell', strike, premium, qty, expiration, iv }

// Calculate combined P&L for a multi-leg strategy at a given stock price
export function calculateStrategyPnL(legs, stockPrice, atExpiration = true, daysFromNow = 0, r = 0.05) {
  let totalPnL = 0;

  for (const leg of legs) {
    const { optionType, action, strike, premium, qty = 1, expiration, iv = 0.3 } = leg;
    const multiplier = action === 'buy' ? 1 : -1;

    let optionValue;
    if (atExpiration) {
      // At expiration, use intrinsic value
      if (optionType === 'call') {
        optionValue = Math.max(0, stockPrice - strike);
      } else {
        optionValue = Math.max(0, strike - stockPrice);
      }
    } else {
      // Before expiration, use Black-Scholes
      const daysToExpiry = daysBetween(new Date(), new Date(expiration)) - daysFromNow;
      const T = Math.max(0, daysToExpiry / 365);
      if (T <= 0) {
        optionValue = optionType === 'call'
          ? Math.max(0, stockPrice - strike)
          : Math.max(0, strike - stockPrice);
      } else {
        optionValue = calculateOptionPrice(stockPrice, strike, T, r, iv, optionType);
      }
    }

    // For sold options, we received premium; for bought, we paid premium
    const legPnL = multiplier * (optionValue - premium) * 100 * qty;
    totalPnL += legPnL;
  }

  return totalPnL;
}

// Calculate combined Greeks for a multi-leg strategy
export function calculateStrategyGreeks(legs, stockPrice, r = 0.05) {
  const combined = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };

  for (const leg of legs) {
    const { optionType, action, strike, expiration, iv = 0.3, qty = 1 } = leg;
    const daysToExpiry = daysBetween(new Date(), new Date(expiration));
    const T = Math.max(0.001, daysToExpiry / 365);
    const multiplier = action === 'buy' ? 1 : -1;

    const greeks = calculateGreeks(stockPrice, strike, T, r, iv, optionType);

    combined.delta += greeks.delta * multiplier * qty;
    combined.gamma += greeks.gamma * multiplier * qty;
    combined.theta += greeks.theta * multiplier * qty;
    combined.vega += greeks.vega * multiplier * qty;
    combined.rho += greeks.rho * multiplier * qty;
  }

  return combined;
}

// Generate strategy P&L curve for charting
export function generateStrategyPayoffData(legs, currentPrice, range = 0.3) {
  const minPrice = Math.max(0, currentPrice * (1 - range));
  const maxPrice = currentPrice * (1 + range);
  const step = (maxPrice - minPrice) / 100;

  const data = [];
  for (let price = minPrice; price <= maxPrice; price += step) {
    const pnl = calculateStrategyPnL(legs, price, true);
    data.push({
      stockPrice: parseFloat(price.toFixed(2)),
      pnl: parseFloat(pnl.toFixed(2)),
    });
  }

  return data;
}

// Generate multi-date P&L curves for risk graph
export function generateMultiDatePayoffData(legs, currentPrice, daysToExpiry, range = 0.3, dateCount = 5) {
  const minPrice = Math.max(0, currentPrice * (1 - range));
  const maxPrice = currentPrice * (1 + range);
  const step = (maxPrice - minPrice) / 50;

  // Generate date intervals
  const dateIntervals = [0];
  const dayStep = Math.max(1, Math.floor(daysToExpiry / (dateCount - 1)));
  for (let d = dayStep; d < daysToExpiry; d += dayStep) {
    dateIntervals.push(d);
  }
  dateIntervals.push(daysToExpiry);

  const data = [];
  for (let price = minPrice; price <= maxPrice; price += step) {
    const row = { stockPrice: parseFloat(price.toFixed(2)) };

    for (const day of dateIntervals) {
      const atExpiration = day >= daysToExpiry;
      const pnl = calculateStrategyPnL(legs, price, atExpiration, day);
      row[`day${day}`] = parseFloat(pnl.toFixed(2));
    }

    data.push(row);
  }

  return { data, dateIntervals };
}

// Calculate strategy metrics (max profit, max loss, breakevens)
export function calculateStrategyMetrics(legs, currentPrice, range = 0.5) {
  const minPrice = Math.max(0.01, currentPrice * (1 - range));
  const maxPrice = currentPrice * (1 + range);
  const step = 0.5;

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  let maxProfitPrice = currentPrice;
  let maxLossPrice = currentPrice;
  const breakevens = [];
  let prevPnL = null;

  for (let price = minPrice; price <= maxPrice; price += step) {
    const pnl = calculateStrategyPnL(legs, price, true);

    if (pnl > maxProfit) {
      maxProfit = pnl;
      maxProfitPrice = price;
    }
    if (pnl < maxLoss) {
      maxLoss = pnl;
      maxLossPrice = price;
    }

    // Detect breakeven crossings
    if (prevPnL !== null && ((prevPnL < 0 && pnl >= 0) || (prevPnL >= 0 && pnl < 0))) {
      breakevens.push(parseFloat(price.toFixed(2)));
    }
    prevPnL = pnl;
  }

  // Check for unlimited profit/loss scenarios
  const farOTMCall = calculateStrategyPnL(legs, currentPrice * 3, true);
  const farOTMPut = calculateStrategyPnL(legs, currentPrice * 0.1, true);

  const hasUnlimitedUpside = farOTMCall > maxProfit * 1.5;
  const hasUnlimitedDownside = farOTMPut < maxLoss * 1.5;

  // Calculate net debit/credit
  const netPremium = legs.reduce((sum, leg) => {
    const mult = leg.action === 'buy' ? -1 : 1;
    return sum + mult * leg.premium * 100 * (leg.qty || 1);
  }, 0);

  return {
    maxProfit: hasUnlimitedUpside ? Infinity : maxProfit,
    maxLoss: hasUnlimitedDownside ? -Infinity : maxLoss,
    maxProfitPrice,
    maxLossPrice,
    breakevens,
    netPremium, // Negative = debit, Positive = credit
    isDebit: netPremium < 0,
    isCredit: netPremium > 0,
  };
}

// Strategy templates with leg definitions
export const STRATEGY_TEMPLATES = {
  longCall: {
    name: 'Long Call',
    type: 'bullish',
    legs: 1,
    description: 'Buy a call option. Profit if stock rises above strike + premium.',
    maxProfit: 'Unlimited',
    maxLoss: 'Premium paid',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'call', action: 'buy', strikeOffset: 0 }
    ]
  },
  longPut: {
    name: 'Long Put',
    type: 'bearish',
    legs: 1,
    description: 'Buy a put option. Profit if stock falls below strike - premium.',
    maxProfit: 'Strike - Premium',
    maxLoss: 'Premium paid',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'put', action: 'buy', strikeOffset: 0 }
    ]
  },
  coveredCall: {
    name: 'Covered Call',
    type: 'neutral',
    legs: 1,
    description: 'Own stock, sell OTM call. Income strategy with capped upside.',
    maxProfit: 'Premium + (Strike - Stock Price)',
    maxLoss: 'Stock price - Premium',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'call', action: 'sell', strikeOffset: 5 }
    ]
  },
  bullCallSpread: {
    name: 'Bull Call Spread',
    type: 'bullish',
    legs: 2,
    description: 'Buy lower strike call, sell higher strike call. Limited risk & reward.',
    maxProfit: 'Strike difference - Net debit',
    maxLoss: 'Net debit',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'call', action: 'buy', strikeOffset: 0 },
      { optionType: 'call', action: 'sell', strikeOffset: 5 }
    ]
  },
  bearPutSpread: {
    name: 'Bear Put Spread',
    type: 'bearish',
    legs: 2,
    description: 'Buy higher strike put, sell lower strike put. Limited risk & reward.',
    maxProfit: 'Strike difference - Net debit',
    maxLoss: 'Net debit',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'put', action: 'buy', strikeOffset: 0 },
      { optionType: 'put', action: 'sell', strikeOffset: -5 }
    ]
  },
  bullPutSpread: {
    name: 'Bull Put Spread',
    type: 'bullish',
    legs: 2,
    description: 'Sell higher strike put, buy lower strike put. Credit spread.',
    maxProfit: 'Net credit received',
    maxLoss: 'Strike difference - Credit',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'put', action: 'sell', strikeOffset: 0 },
      { optionType: 'put', action: 'buy', strikeOffset: -5 }
    ]
  },
  bearCallSpread: {
    name: 'Bear Call Spread',
    type: 'bearish',
    legs: 2,
    description: 'Sell lower strike call, buy higher strike call. Credit spread.',
    maxProfit: 'Net credit received',
    maxLoss: 'Strike difference - Credit',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'call', action: 'sell', strikeOffset: 0 },
      { optionType: 'call', action: 'buy', strikeOffset: 5 }
    ]
  },
  straddle: {
    name: 'Long Straddle',
    type: 'neutral',
    legs: 2,
    description: 'Buy call AND put at same strike. Profit from big moves either direction.',
    maxProfit: 'Unlimited',
    maxLoss: 'Total premium paid',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'call', action: 'buy', strikeOffset: 0 },
      { optionType: 'put', action: 'buy', strikeOffset: 0 }
    ]
  },
  strangle: {
    name: 'Long Strangle',
    type: 'neutral',
    legs: 2,
    description: 'Buy OTM call AND OTM put. Cheaper than straddle, needs bigger move.',
    maxProfit: 'Unlimited',
    maxLoss: 'Total premium paid',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'call', action: 'buy', strikeOffset: 5 },
      { optionType: 'put', action: 'buy', strikeOffset: -5 }
    ]
  },
  ironCondor: {
    name: 'Iron Condor',
    type: 'neutral',
    legs: 4,
    description: 'Sell OTM put spread + OTM call spread. Profit if stock stays in range.',
    maxProfit: 'Net credit received',
    maxLoss: 'Wing width - Credit',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'put', action: 'buy', strikeOffset: -10 },
      { optionType: 'put', action: 'sell', strikeOffset: -5 },
      { optionType: 'call', action: 'sell', strikeOffset: 5 },
      { optionType: 'call', action: 'buy', strikeOffset: 10 }
    ]
  },
  ironButterfly: {
    name: 'Iron Butterfly',
    type: 'neutral',
    legs: 4,
    description: 'Sell ATM straddle, buy OTM strangle for protection. Max profit at strike.',
    maxProfit: 'Net credit received',
    maxLoss: 'Wing width - Credit',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'put', action: 'buy', strikeOffset: -5 },
      { optionType: 'put', action: 'sell', strikeOffset: 0 },
      { optionType: 'call', action: 'sell', strikeOffset: 0 },
      { optionType: 'call', action: 'buy', strikeOffset: 5 }
    ]
  },
  callButterfly: {
    name: 'Call Butterfly',
    type: 'neutral',
    legs: 3,
    description: 'Buy 1 lower, sell 2 middle, buy 1 higher call. Max profit if stock at middle strike.',
    maxProfit: 'Wing width - Net debit',
    maxLoss: 'Net debit',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'call', action: 'buy', strikeOffset: -5 },
      { optionType: 'call', action: 'sell', strikeOffset: 0, qty: 2 },
      { optionType: 'call', action: 'buy', strikeOffset: 5 }
    ]
  },
  putButterfly: {
    name: 'Put Butterfly',
    type: 'neutral',
    legs: 3,
    description: 'Buy 1 higher, sell 2 middle, buy 1 lower put. Max profit if stock at middle strike.',
    maxProfit: 'Wing width - Net debit',
    maxLoss: 'Net debit',
    buildLegs: (baseStrike, expiry, baseIV) => [
      { optionType: 'put', action: 'buy', strikeOffset: 5 },
      { optionType: 'put', action: 'sell', strikeOffset: 0, qty: 2 },
      { optionType: 'put', action: 'buy', strikeOffset: -5 }
    ]
  },
  calendarSpread: {
    name: 'Calendar Spread',
    type: 'neutral',
    legs: 2,
    description: 'Sell near-term, buy far-term at same strike. Profits from time decay differential.',
    maxProfit: 'Depends on IV and time',
    maxLoss: 'Net debit',
    requiresMultipleExpiries: true,
    buildLegs: (baseStrike, nearExpiry, farExpiry, baseIV) => [
      { optionType: 'call', action: 'sell', strikeOffset: 0, isNearTerm: true },
      { optionType: 'call', action: 'buy', strikeOffset: 0, isFarTerm: true }
    ]
  },
  diagonalSpread: {
    name: 'Diagonal Spread',
    type: 'bullish',
    legs: 2,
    description: 'Sell near-term OTM, buy far-term ATM/ITM. Like calendar with directional bias.',
    maxProfit: 'Depends on IV and time',
    maxLoss: 'Net debit',
    requiresMultipleExpiries: true,
    buildLegs: (baseStrike, nearExpiry, farExpiry, baseIV) => [
      { optionType: 'call', action: 'sell', strikeOffset: 5, isNearTerm: true },
      { optionType: 'call', action: 'buy', strikeOffset: 0, isFarTerm: true }
    ]
  },
};

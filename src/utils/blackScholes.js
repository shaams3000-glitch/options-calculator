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
    description: 'The simplest bullish options trade. You buy a call option, which gives you the right to purchase the stock at the strike price. If the stock goes up significantly, your call increases in value.',
    whenToUse: 'Use when you believe a stock will rise significantly before expiration. Best when you expect a big move up but want to risk less than buying shares outright.',
    example: 'Stock at $100, buy $105 call for $2. If stock hits $115, your option is worth ~$10 (5x return). If stock stays below $105, you lose the $2.',
    riskLevel: 'Medium',
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
    description: 'The simplest bearish options trade. You buy a put option, which gives you the right to sell the stock at the strike price. If the stock drops, your put increases in value.',
    whenToUse: 'Use when you believe a stock will fall significantly. Also used to protect (hedge) existing stock positions against downside.',
    example: 'Stock at $100, buy $95 put for $2. If stock drops to $80, your option is worth ~$15. If stock stays above $95, you lose the $2.',
    riskLevel: 'Medium',
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
    description: 'An income strategy for stocks you already own. You sell a call option against your shares, collecting premium. If the stock stays below the strike, you keep the premium and your shares.',
    whenToUse: 'Use when you own shares and think the stock will trade sideways or rise slightly. Great for generating extra income on stocks you plan to hold anyway.',
    example: 'Own 100 shares at $100, sell $110 call for $3. You pocket $300. If stock stays under $110, you keep shares + $300. If it goes above $110, shares get sold at $110.',
    riskLevel: 'Low',
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
    description: 'A cheaper way to bet on a stock going up. You buy a call and sell a higher-strike call to reduce cost. Your profit is capped but so is your risk.',
    whenToUse: 'Use when you\'re moderately bullish but want to spend less than buying a call outright. Good when you have a price target in mind.',
    example: 'Stock at $100. Buy $100 call for $5, sell $110 call for $2. Net cost: $3. Max profit: $7 (if stock above $110). Max loss: $3.',
    riskLevel: 'Low-Medium',
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
    description: 'A cheaper way to bet on a stock going down. You buy a put and sell a lower-strike put to reduce cost. Your profit is capped but so is your risk.',
    whenToUse: 'Use when you\'re moderately bearish but want to spend less than buying a put outright. Good when you have a downside target.',
    example: 'Stock at $100. Buy $100 put for $5, sell $90 put for $2. Net cost: $3. Max profit: $7 (if stock below $90). Max loss: $3.',
    riskLevel: 'Low-Medium',
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
    description: 'A credit strategy that profits if the stock stays above a certain price. You collect money upfront by selling a put and buying a lower put for protection.',
    whenToUse: 'Use when you\'re neutral to bullish and want to collect premium. You profit if the stock stays flat or goes up. Popular for generating income.',
    example: 'Stock at $100. Sell $95 put for $3, buy $90 put for $1. Net credit: $2. Keep the $2 if stock stays above $95. Max loss: $3 if stock below $90.',
    riskLevel: 'Low-Medium',
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
    description: 'A credit strategy that profits if the stock stays below a certain price. You collect money upfront by selling a call and buying a higher call for protection.',
    whenToUse: 'Use when you\'re neutral to bearish and want to collect premium. You profit if the stock stays flat or goes down.',
    example: 'Stock at $100. Sell $105 call for $3, buy $110 call for $1. Net credit: $2. Keep the $2 if stock stays below $105. Max loss: $3 if stock above $110.',
    riskLevel: 'Low-Medium',
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
    description: 'A volatility play - you buy both a call AND a put at the same strike. You profit if the stock makes a big move in EITHER direction. Direction doesn\'t matter, only magnitude.',
    whenToUse: 'Use before major events (earnings, FDA decisions, etc.) when you expect a big move but don\'t know which direction. Also good when you think the market is underpricing volatility.',
    example: 'Stock at $100. Buy $100 call for $5 and $100 put for $5. Cost: $10. You profit if stock goes above $110 or below $90 by expiration.',
    riskLevel: 'Medium-High',
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
    description: 'Like a straddle but cheaper. You buy an out-of-the-money call AND put. Costs less but needs a bigger move to profit.',
    whenToUse: 'Use when you expect a huge move but want to pay less than a straddle. Good for very volatile situations where you need the stock to move significantly.',
    example: 'Stock at $100. Buy $105 call for $2 and $95 put for $2. Cost: $4. You profit if stock goes above $109 or below $91.',
    riskLevel: 'Medium-High',
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
    description: 'The classic "range-bound" strategy. You collect premium by betting the stock stays within a range. Combines a bull put spread below and a bear call spread above.',
    whenToUse: 'Use when you expect low volatility and think the stock will stay in a range. Popular monthly income strategy. Works best in calm, sideways markets.',
    example: 'Stock at $100. Sell $95/$90 put spread and $105/$110 call spread. Collect ~$2 credit. Keep it all if stock stays between $95-$105.',
    riskLevel: 'Low-Medium',
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
    description: 'A high-reward bet that the stock stays exactly where it is. You sell options at the current price and buy protection on both sides. Maximum profit if stock closes exactly at strike.',
    whenToUse: 'Use when you\'re very confident the stock will stay near current price. Higher risk/reward than iron condor. Best with stocks that tend to pin to round numbers.',
    example: 'Stock at $100. Sell $100 call and put, buy $95 put and $105 call. Collect ~$6 credit. Max profit if stock at exactly $100 at expiration.',
    riskLevel: 'Medium',
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
    description: 'A low-cost bet on a specific price target. You buy one call below target, sell two at target, buy one above. Very cheap, potentially high return if you nail the price.',
    whenToUse: 'Use when you have a specific price target and want a cheap lottery-ticket type trade. Risk is very limited but you need to be precise.',
    example: 'Stock at $100, target $105. Buy $100 call, sell 2x $105 calls, buy $110 call. Cost: ~$1. Worth $4 if stock at exactly $105.',
    riskLevel: 'Low',
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
    description: 'Same as call butterfly but using puts. A low-cost bet on a specific lower price target.',
    whenToUse: 'Use when you have a specific downside price target. Same logic as call butterfly but positioned for a move down to a specific level.',
    example: 'Stock at $100, target $95. Buy $100 put, sell 2x $95 puts, buy $90 put. Cost: ~$1. Worth $4 if stock at exactly $95.',
    riskLevel: 'Low',
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
    description: 'A time-based strategy. You sell a near-term option and buy a longer-term option at the same strike. Profits from the near-term option decaying faster.',
    whenToUse: 'Use when you expect the stock to stay near current price in the short term. Great before events when near-term IV is high. Also called a "time spread".',
    example: 'Stock at $100. Sell next-week $100 call for $2, buy next-month $100 call for $4. Cost: $2. Profit if stock near $100 when short call expires.',
    riskLevel: 'Medium',
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
    description: 'A calendar spread with a directional twist. Sell near-term OTM option, buy longer-term ATM option. Combines time decay income with directional bias.',
    whenToUse: 'Use when you\'re moderately bullish over time but want to reduce cost by selling near-term premium. A "poor man\'s covered call" is a type of diagonal.',
    example: 'Stock at $100. Sell next-week $105 call for $1, buy next-month $100 call for $5. Cost: $4. Profit if stock rises gradually over time.',
    riskLevel: 'Medium',
    maxProfit: 'Depends on IV and time',
    maxLoss: 'Net debit',
    requiresMultipleExpiries: true,
    buildLegs: (baseStrike, nearExpiry, farExpiry, baseIV) => [
      { optionType: 'call', action: 'sell', strikeOffset: 5, isNearTerm: true },
      { optionType: 'call', action: 'buy', strikeOffset: 0, isFarTerm: true }
    ]
  },
};

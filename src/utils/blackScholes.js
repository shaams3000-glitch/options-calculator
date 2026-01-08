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

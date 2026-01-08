// Yahoo Finance API utilities - via API server

// Use localhost in development, relative path in production (Vercel)
const BASE_URL = import.meta.env.DEV ? 'http://localhost:3001/api' : '/api';

// Fetch stock quote (current price)
export async function fetchStockQuote(ticker) {
  const url = `${BASE_URL}/quote/${ticker.toUpperCase()}`;

  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Failed to fetch quote for ${ticker}`);
  }

  return await response.json();
}

// Fetch options chain with all expiration dates
export async function fetchOptionsChain(ticker, expirationDate = null) {
  let url = `${BASE_URL}/options/${ticker.toUpperCase()}`;
  if (expirationDate) {
    url += `?date=${expirationDate}`;
  }

  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Failed to fetch options for ${ticker}`);
  }

  return await response.json();
}

// Convert Unix timestamp to date string
export function unixToDate(timestamp) {
  const date = new Date(timestamp * 1000);
  return date.toISOString().split('T')[0];
}

// Convert date string to Unix timestamp
export function dateToUnix(dateString) {
  return Math.floor(new Date(dateString).getTime() / 1000);
}

// Format option data for display
export function formatOptionData(option) {
  return {
    strike: option.strike,
    lastPrice: option.lastPrice || 0,
    bid: option.bid || 0,
    ask: option.ask || 0,
    volume: option.volume || 0,
    openInterest: option.openInterest || 0,
    impliedVolatility: (option.impliedVolatility || 0) * 100, // Convert to percentage
    inTheMoney: option.inTheMoney || false,
    contractSymbol: option.contractSymbol,
    expiration: option.expiration,
    change: option.change || 0,
    percentChange: option.percentChange || 0,
  };
}

// Get mid price (average of bid and ask)
export function getMidPrice(option) {
  if (option.bid && option.ask) {
    return (option.bid + option.ask) / 2;
  }
  return option.lastPrice || 0;
}

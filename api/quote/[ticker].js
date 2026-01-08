import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { ticker } = req.query;
    const quote = await yahooFinance.quote(ticker.toUpperCase());
    res.json({
      symbol: quote.symbol,
      price: quote.regularMarketPrice,
      previousClose: quote.regularMarketPreviousClose,
      change: quote.regularMarketChange,
      changePercent: quote.regularMarketChangePercent,
    });
  } catch (error) {
    console.error('Quote error:', error.message);
    res.status(500).json({ error: error.message });
  }
}

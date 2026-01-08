import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

// Helper to convert option dates to Unix timestamps
function formatOption(opt) {
  return {
    ...opt,
    expiration: opt.expiration instanceof Date
      ? Math.floor(opt.expiration.getTime() / 1000)
      : opt.expiration,
  };
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { ticker, date } = req.query;

    const queryOptions = {};
    if (date) {
      queryOptions.date = new Date(parseInt(date) * 1000);
    }

    const result = await yahooFinance.options(ticker.toUpperCase(), queryOptions);
    const rawOptions = result.options[0] || { calls: [], puts: [] };

    res.json({
      underlyingSymbol: result.underlyingSymbol,
      underlyingPrice: result.quote?.regularMarketPrice || 0,
      expirationDates: result.expirationDates.map(d => Math.floor(d.getTime() / 1000)),
      strikes: result.strikes,
      options: {
        calls: rawOptions.calls.map(formatOption),
        puts: rawOptions.puts.map(formatOption),
      },
      quote: result.quote,
    });
  } catch (error) {
    console.error('Options error:', error.message);
    res.status(500).json({ error: error.message });
  }
}

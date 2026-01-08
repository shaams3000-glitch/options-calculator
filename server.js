import express from 'express';
import cors from 'cors';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();
const app = express();
app.use(cors());
app.use(express.json());

// Get stock quote
app.get('/api/quote/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
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
});

// Helper to convert option dates to Unix timestamps
function formatOption(opt) {
  return {
    ...opt,
    expiration: opt.expiration instanceof Date
      ? Math.floor(opt.expiration.getTime() / 1000)
      : opt.expiration,
  };
}

// Get options chain
app.get('/api/options/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const { date } = req.query;

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
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});

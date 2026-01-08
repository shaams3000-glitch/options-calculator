import { useState, useEffect, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  calculateOptionPrice,
  calculateGreeks,
  calculateBreakEven,
  generatePayoffData,
  generateHeatmapData,
  daysBetween,
} from './utils/blackScholes';
import {
  fetchOptionsChain,
  fetchStockQuote,
  unixToDate,
  formatOptionData,
  getMidPrice,
} from './utils/yahooFinance';

// Educational tooltips content
const tooltipContent = {
  delta: "Delta measures how much the option price changes for a $1 move in the stock. A delta of 0.50 means the option gains $0.50 if the stock rises $1.",
  gamma: "Gamma measures how fast delta changes. High gamma means delta will change quickly as the stock moves.",
  theta: "Theta is time decay - how much value the option loses each day. A theta of -0.05 means you lose $0.05 per day.",
  vega: "Vega measures sensitivity to volatility changes. High vega means the option price changes a lot when IV changes.",
  iv: "Implied Volatility (IV) reflects the market's expectation of future price movement. Higher IV = more expensive options.",
  premium: "The price you pay to buy the option. This is your maximum loss if buying.",
  strike: "The price at which you can buy (call) or sell (put) the stock if you exercise the option.",
  breakeven: "The stock price where your profit equals zero at expiration.",
};

// Tooltip Component
function InfoTooltip({ content, children }) {
  const [show, setShow] = useState(false);

  return (
    <span className="relative inline-block">
      <span
        className="cursor-help border-b border-dashed border-gray-500"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        {children}
      </span>
      {show && (
        <div className="absolute z-50 w-64 p-3 text-sm bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl -top-2 left-full ml-2 text-gray-200">
          {content}
          <div className="absolute w-2 h-2 bg-neutral-900 border-l border-b border-neutral-700 transform rotate-45 -left-1 top-4"></div>
        </div>
      )}
    </span>
  );
}

// AI Options Builder Component
function OptionsBuilder({ onSelectOption, onStockPriceUpdate }) {
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState({
    ticker: '',
    direction: '',
    budget: '',
    maxRisk: '',
    targetPriceLow: '',
    targetPriceHigh: '',
    selectedExpiries: [],
  });
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [optionsData, setOptionsData] = useState(null);
  const [availableExpiries, setAvailableExpiries] = useState([]);
  const [stockPrice, setStockPrice] = useState(0);

  const handleInputChange = (field, value) => {
    setFormData({ ...formData, [field]: value });
  };

  const toggleExpiry = (expiry) => {
    const current = formData.selectedExpiries;
    if (current.includes(expiry)) {
      handleInputChange('selectedExpiries', current.filter(e => e !== expiry));
    } else {
      handleInputChange('selectedExpiries', [...current, expiry]);
    }
  };

  // Fetch expiries after ticker is entered
  const fetchExpiries = async () => {
    if (!formData.ticker) return;
    setLoading(true);
    try {
      const data = await fetchOptionsChain(formData.ticker);
      setOptionsData(data);
      setAvailableExpiries(data.expirationDates || []);
      setStockPrice(data.underlyingPrice);
      onStockPriceUpdate(data.underlyingPrice);
      // Pre-fill target price range around current price
      handleInputChange('targetPriceLow', Math.round(data.underlyingPrice * 0.95));
      handleInputChange('targetPriceHigh', Math.round(data.underlyingPrice * 1.10));
      setStep(1);
    } catch (error) {
      console.error('Error fetching expiries:', error);
    } finally {
      setLoading(false);
    }
  };

  const generateSuggestions = async () => {
    if (!optionsData) return;
    setLoading(true);

    try {
      const budget = parseFloat(formData.budget) || 500;
      const maxRisk = parseFloat(formData.maxRisk) || budget;
      const targetLow = parseFloat(formData.targetPriceLow);
      const targetHigh = parseFloat(formData.targetPriceHigh);
      const selectedExpiries = formData.selectedExpiries;

      // Fetch options for each selected expiry and find best matches
      const suggestionList = [];

      for (const expiry of selectedExpiries.slice(0, 3)) {
        const data = await fetchOptionsChain(formData.ticker, expiry);
        const calls = data.options?.calls || [];
        const puts = data.options?.puts || [];

        if (formData.direction === 'bullish') {
          // Find calls with strike near target price, within budget
          const matchingCalls = calls.filter(c => {
            const price = getMidPrice(c) * 100;
            return c.strike >= stockPrice && c.strike <= targetHigh && price <= budget && price <= maxRisk;
          });

          if (matchingCalls.length > 0) {
            // Sort by strike closest to target high
            matchingCalls.sort((a, b) => Math.abs(a.strike - targetHigh) - Math.abs(b.strike - targetHigh));
            const best = matchingCalls[0];
            const premium = getMidPrice(best);
            const potentialProfit = targetHigh - best.strike - premium;

            suggestionList.push({
              type: `Call - ${unixToDate(expiry)}`,
              option: best,
              optionType: 'call',
              expiry: expiry,
              reason: `$${best.strike} strike. Cost: $${(premium * 100).toFixed(0)}. If stock hits $${targetHigh}, potential profit: $${(potentialProfit * 100).toFixed(0)} (${((potentialProfit / premium) * 100).toFixed(0)}% return)`,
              maxLoss: premium * 100,
              potentialGain: potentialProfit * 100,
            });
          }
        } else if (formData.direction === 'bearish') {
          // Find puts with strike near target price, within budget
          const matchingPuts = puts.filter(p => {
            const price = getMidPrice(p) * 100;
            return p.strike <= stockPrice && p.strike >= targetLow && price <= budget && price <= maxRisk;
          });

          if (matchingPuts.length > 0) {
            matchingPuts.sort((a, b) => Math.abs(a.strike - targetLow) - Math.abs(b.strike - targetLow));
            const best = matchingPuts[0];
            const premium = getMidPrice(best);
            const potentialProfit = best.strike - targetLow - premium;

            suggestionList.push({
              type: `Put - ${unixToDate(expiry)}`,
              option: best,
              optionType: 'put',
              expiry: expiry,
              reason: `$${best.strike} strike. Cost: $${(premium * 100).toFixed(0)}. If stock drops to $${targetLow}, potential profit: $${(potentialProfit * 100).toFixed(0)} (${((potentialProfit / premium) * 100).toFixed(0)}% return)`,
              maxLoss: premium * 100,
              potentialGain: potentialProfit * 100,
            });
          }
        }
      }

      setSuggestions(suggestionList);
      setStep(6);
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  const selectSuggestion = (suggestion) => {
    const formatted = formatOptionData(suggestion.option);
    onSelectOption({
      strikePrice: formatted.strike,
      premium: getMidPrice(suggestion.option),
      iv: formatted.impliedVolatility,
      expirationDate: unixToDate(suggestion.option.expiration),
      optionType: suggestion.optionType,
    });
    setStep(0);
    setSuggestions([]);
    setFormData({
      ticker: '',
      direction: '',
      budget: '',
      maxRisk: '',
      targetPriceLow: '',
      targetPriceHigh: '',
      selectedExpiries: [],
    });
  };

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <>
            <p className="text-neutral-400 mb-4">What stock are you interested in?</p>
            <input
              type="text"
              value={formData.ticker}
              onChange={(e) => handleInputChange('ticker', e.target.value.toUpperCase())}
              placeholder="Enter ticker (e.g., AAPL, SPY)"
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={fetchExpiries}
              disabled={!formData.ticker}
              className={`w-full mt-4 py-2 rounded-lg font-medium ${
                formData.ticker ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-neutral-700 text-neutral-500'
              }`}
            >
              Next
            </button>
          </>
        );

      case 1:
        return (
          <>
            <p className="text-neutral-400 mb-2">Current price: <span className="text-white font-medium">${stockPrice.toFixed(2)}</span></p>
            <p className="text-neutral-400 mb-4">What is your market outlook?</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: 'bullish', label: 'Bullish', desc: 'Stock will go up' },
                { value: 'bearish', label: 'Bearish', desc: 'Stock will go down' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { handleInputChange('direction', opt.value); setStep(2); }}
                  className={`p-4 rounded-lg border transition-all ${
                    formData.direction === opt.value
                      ? 'border-blue-500 bg-blue-500/20'
                      : 'border-neutral-700 hover:border-neutral-600'
                  }`}
                >
                  <div className="font-medium text-white">{opt.label}</div>
                  <div className="text-xs text-neutral-400">{opt.desc}</div>
                </button>
              ))}
            </div>
          </>
        );

      case 2:
        return (
          <>
            <p className="text-neutral-400 mb-4">What price range do you think {formData.ticker} will reach?</p>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm text-neutral-500 mb-1">Low Target ($)</label>
                <input
                  type="number"
                  value={formData.targetPriceLow}
                  onChange={(e) => handleInputChange('targetPriceLow', e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-sm text-neutral-500 mb-1">High Target ($)</label>
                <input
                  type="number"
                  value={formData.targetPriceHigh}
                  onChange={(e) => handleInputChange('targetPriceHigh', e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-2 text-white"
                />
              </div>
            </div>
            <p className="text-xs text-neutral-500 mb-4">Current: ${stockPrice.toFixed(2)}</p>
            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={() => setStep(3)}
                disabled={!formData.targetPriceLow || !formData.targetPriceHigh}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Next
              </button>
            </div>
          </>
        );

      case 3:
        return (
          <>
            <p className="text-neutral-400 mb-4">When do you expect this price target? (Select expiry dates)</p>
            <div className="max-h-48 overflow-y-auto space-y-2 mb-4">
              {availableExpiries.slice(0, 12).map(exp => (
                <button
                  key={exp}
                  onClick={() => toggleExpiry(exp)}
                  className={`w-full p-3 rounded-lg border text-left transition-all ${
                    formData.selectedExpiries.includes(exp)
                      ? 'border-blue-500 bg-blue-500/20'
                      : 'border-neutral-700 hover:border-neutral-600'
                  }`}
                >
                  <span className="text-white">{unixToDate(exp)}</span>
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep(2)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={() => setStep(4)}
                disabled={formData.selectedExpiries.length === 0}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Next ({formData.selectedExpiries.length} selected)
              </button>
            </div>
          </>
        );

      case 4:
        return (
          <>
            <p className="text-neutral-400 mb-4">What is your total budget for this trade?</p>
            <div className="relative mb-4">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400">$</span>
              <input
                type="number"
                value={formData.budget}
                onChange={(e) => handleInputChange('budget', e.target.value)}
                placeholder="500"
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-3 pl-8 text-white"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep(3)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={() => setStep(5)}
                disabled={!formData.budget}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Next
              </button>
            </div>
          </>
        );

      case 5:
        return (
          <>
            <p className="text-neutral-400 mb-4">How much are you willing to lose (max risk)?</p>
            <div className="relative mb-2">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400">$</span>
              <input
                type="number"
                value={formData.maxRisk}
                onChange={(e) => handleInputChange('maxRisk', e.target.value)}
                placeholder={formData.budget}
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-3 pl-8 text-white"
              />
            </div>
            <p className="text-xs text-neutral-500 mb-4">This is the maximum you could lose if the trade goes against you</p>
            <div className="flex gap-2">
              <button onClick={() => setStep(4)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={generateSuggestions}
                disabled={!formData.maxRisk}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Find Options
              </button>
            </div>
          </>
        );

      case 6:
        return (
          <>
            {suggestions.length > 0 ? (
              <>
                <p className="text-neutral-400 mb-4">Based on your criteria, here are matching options:</p>
                <div className="space-y-3">
                  {suggestions.map((s, idx) => (
                    <div key={idx} className="bg-black/70 rounded-lg p-4 border border-neutral-800">
                      <div className="flex justify-between items-start mb-2">
                        <span className={`font-medium ${s.optionType === 'call' ? 'text-green-400' : 'text-red-400'}`}>
                          {s.type}
                        </span>
                        <span className="text-white font-medium">${s.option.strike}</span>
                      </div>
                      <p className="text-sm text-neutral-400 mb-2">{s.reason}</p>
                      <div className="flex justify-between text-xs mb-3">
                        <span className="text-red-400">Max Loss: ${s.maxLoss.toFixed(0)}</span>
                        <span className="text-green-400">Potential Gain: ${s.potentialGain.toFixed(0)}</span>
                      </div>
                      <button
                        onClick={() => selectSuggestion(s)}
                        className="w-full py-2 bg-blue-600 hover:bg-blue-700 rounded text-white text-sm"
                      >
                        Use This Option
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-neutral-400">No options found matching your criteria. Try adjusting your targets or budget.</p>
            )}
            <button
              onClick={() => { setStep(0); setSuggestions([]); setFormData({ ticker: '', direction: '', budget: '', maxRisk: '', targetPriceLow: '', targetPriceHigh: '', selectedExpiries: [] }); }}
              className="w-full mt-4 py-2 text-neutral-400 hover:text-white"
            >
              Start Over
            </button>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">Options Builder</h2>
      {loading ? (
        <div className="text-center py-8">
          <div className="text-neutral-400">Loading...</div>
        </div>
      ) : (
        renderStep()
      )}
    </div>
  );
}

// Ticker Search and Options Chain Component
function TickerSearch({ onSelectOption, onStockPriceUpdate }) {
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [optionsData, setOptionsData] = useState(null);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [optionType, setOptionType] = useState('calls');

  const handleSearch = async () => {
    if (!ticker.trim()) return;

    setLoading(true);
    setError('');
    setOptionsData(null);

    try {
      const data = await fetchOptionsChain(ticker);
      setOptionsData(data);
      onStockPriceUpdate(data.underlyingPrice);

      // Auto-select first expiration date
      if (data.expirationDates.length > 0) {
        setSelectedExpiry(data.expirationDates[0]);
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch options data');
    } finally {
      setLoading(false);
    }
  };

  const handleExpiryChange = async (expiry) => {
    setSelectedExpiry(expiry);
    setLoading(true);

    try {
      const data = await fetchOptionsChain(ticker, expiry);
      setOptionsData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectOption = (option) => {
    const formatted = formatOptionData(option);
    onSelectOption({
      strikePrice: formatted.strike,
      premium: getMidPrice(option),
      iv: formatted.impliedVolatility,
      expirationDate: unixToDate(option.expiration),
      optionType: optionType === 'calls' ? 'call' : 'put',
    });
  };

  const options = optionType === 'calls'
    ? optionsData?.options?.calls || []
    : optionsData?.options?.puts || [];

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">Lookup Real Options</h2>

      {/* Ticker Search */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Enter ticker (e.g., AAPL, SPY)"
          className="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-700 rounded-lg font-medium transition-colors"
        >
          {loading ? '...' : 'Search'}
        </button>
      </div>

      {error && (
        <div className="text-red-400 text-sm mb-4 p-2 bg-red-900/20 rounded">
          {error}
        </div>
      )}

      {optionsData && (
        <>
          {/* Stock Info */}
          <div className="mb-4 p-3 bg-black/70 rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-lg font-semibold text-white">{optionsData.underlyingSymbol}</span>
              <span className="text-xl font-bold text-green-400">
                ${optionsData.underlyingPrice?.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Expiration Selector */}
          <div className="mb-4">
            <label className="block text-sm text-neutral-400 mb-2">Expiration Date</label>
            <select
              value={selectedExpiry}
              onChange={(e) => handleExpiryChange(parseInt(e.target.value))}
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
            >
              {optionsData.expirationDates.map((exp) => (
                <option key={exp} value={exp}>
                  {unixToDate(exp)}
                </option>
              ))}
            </select>
          </div>

          {/* Call/Put Toggle */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setOptionType('calls')}
              className={`flex-1 py-2 px-4 rounded-lg font-medium transition-all ${
                optionType === 'calls'
                  ? 'bg-green-600 text-white'
                  : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              CALLS
            </button>
            <button
              onClick={() => setOptionType('puts')}
              className={`flex-1 py-2 px-4 rounded-lg font-medium transition-all ${
                optionType === 'puts'
                  ? 'bg-red-600 text-white'
                  : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              PUTS
            </button>
          </div>

          {/* Options Chain Table */}
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-neutral-900">
                <tr className="text-neutral-400">
                  <th className="p-2 text-left">Strike</th>
                  <th className="p-2 text-right">Bid</th>
                  <th className="p-2 text-right">Ask</th>
                  <th className="p-2 text-right">IV</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {options.map((opt) => {
                  const formatted = formatOptionData(opt);
                  const isITM = formatted.inTheMoney;
                  return (
                    <tr
                      key={opt.contractSymbol}
                      className={`border-t border-neutral-800 hover:bg-neutral-900/50 ${
                        isITM ? 'bg-blue-900/20' : ''
                      }`}
                    >
                      <td className="p-2 font-medium text-white">
                        ${formatted.strike}
                        {isITM && <span className="ml-1 text-xs text-blue-400">ITM</span>}
                      </td>
                      <td className="p-2 text-right text-neutral-300">${formatted.bid.toFixed(2)}</td>
                      <td className="p-2 text-right text-neutral-300">${formatted.ask.toFixed(2)}</td>
                      <td className="p-2 text-right text-neutral-300">{formatted.impliedVolatility.toFixed(1)}%</td>
                      <td className="p-2">
                        <button
                          onClick={() => handleSelectOption(opt)}
                          className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white"
                        >
                          Use
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-neutral-500 mt-3">
            Data from Yahoo Finance (15-20 min delay). Click "Use" to load an option into the calculator.
          </p>
        </>
      )}

      {!optionsData && !loading && (
        <p className="text-neutral-400 text-sm">
          Enter a stock ticker to fetch real options data.
        </p>
      )}
    </div>
  );
}

// Input Form Component - Simplified for beginners
function OptionsForm({ values, onChange }) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleChange = (field, value) => {
    onChange({ ...values, [field]: value });
  };

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">Option Details</h2>

      <div className="grid grid-cols-2 gap-4">
        {/* Option Type */}
        <div className="col-span-2">
          <label className="block text-sm text-neutral-400 mb-2">Option Type</label>
          <div className="flex gap-2">
            <button
              onClick={() => handleChange('optionType', 'call')}
              className={`flex-1 py-2 px-4 rounded-lg font-medium transition-all ${
                values.optionType === 'call'
                  ? 'bg-green-600 text-white'
                  : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              CALL
            </button>
            <button
              onClick={() => handleChange('optionType', 'put')}
              className={`flex-1 py-2 px-4 rounded-lg font-medium transition-all ${
                values.optionType === 'put'
                  ? 'bg-red-600 text-white'
                  : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              PUT
            </button>
          </div>
        </div>

        {/* Stock Price */}
        <div>
          <label className="block text-sm text-neutral-400 mb-2">Stock Price ($)</label>
          <input
            type="number"
            value={values.stockPrice}
            onChange={(e) => handleChange('stockPrice', parseFloat(e.target.value) || 0)}
            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
            step="0.01"
            min="0"
          />
        </div>

        {/* Strike Price */}
        <div>
          <label className="block text-sm text-neutral-400 mb-2">
            <InfoTooltip content={tooltipContent.strike}>Strike Price ($)</InfoTooltip>
          </label>
          <input
            type="number"
            value={values.strikePrice}
            onChange={(e) => handleChange('strikePrice', parseFloat(e.target.value) || 0)}
            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
            step="0.5"
            min="0"
          />
        </div>

        {/* Premium */}
        <div>
          <label className="block text-sm text-neutral-400 mb-2">
            <InfoTooltip content={tooltipContent.premium}>Option Price ($)</InfoTooltip>
          </label>
          <input
            type="number"
            value={values.premium}
            onChange={(e) => handleChange('premium', parseFloat(e.target.value) || 0)}
            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
            step="0.01"
            min="0"
          />
        </div>

        {/* Expiration Date */}
        <div>
          <label className="block text-sm text-neutral-400 mb-2">Expiration Date</label>
          <input
            type="date"
            value={values.expirationDate}
            onChange={(e) => handleChange('expirationDate', e.target.value)}
            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
            min={new Date().toISOString().split('T')[0]}
          />
        </div>

        {/* IV Display (read-only for beginners) */}
        <div className="col-span-2 p-3 bg-black/70 rounded-lg">
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-400">
              <InfoTooltip content={tooltipContent.iv}>Implied Volatility</InfoTooltip>
            </span>
            <span className="text-white font-medium">{values.iv}%</span>
          </div>
          <p className="text-xs text-neutral-500 mt-1">Auto-filled from market data when you select an option above</p>
        </div>

        {/* Advanced Settings Toggle */}
        <div className="col-span-2">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            {showAdvanced ? 'Hide advanced settings' : 'Show advanced settings'}
          </button>
        </div>

        {showAdvanced && (
          <>
            {/* Implied Volatility Slider */}
            <div className="col-span-2">
              <label className="block text-sm text-neutral-400 mb-2">
                Adjust IV: {values.iv}%
              </label>
              <input
                type="range"
                value={values.iv}
                onChange={(e) => handleChange('iv', parseInt(e.target.value))}
                className="w-full h-2 bg-neutral-900 rounded-lg appearance-none cursor-pointer accent-blue-500"
                min="5"
                max="200"
                step="1"
              />
            </div>

            {/* Risk-Free Rate */}
            <div className="col-span-2">
              <label className="block text-sm text-neutral-400 mb-2">Risk-Free Rate: {values.riskFreeRate}%</label>
              <input
                type="range"
                value={values.riskFreeRate}
                onChange={(e) => handleChange('riskFreeRate', parseFloat(e.target.value))}
                className="w-full h-2 bg-neutral-900 rounded-lg appearance-none cursor-pointer accent-neutral-500"
                min="0"
                max="10"
                step="0.25"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Greeks Dashboard Component
function GreeksDashboard({ greeks }) {
  const formatGreek = (value, decimals = 4) => {
    if (value === undefined || isNaN(value)) return '-';
    return value.toFixed(decimals);
  };

  const greekCards = [
    { name: 'Delta', key: 'delta', tooltip: tooltipContent.delta, color: 'blue' },
    { name: 'Gamma', key: 'gamma', tooltip: tooltipContent.gamma, color: 'purple' },
    { name: 'Theta', key: 'theta', tooltip: tooltipContent.theta, color: 'red', suffix: '/day' },
    { name: 'Vega', key: 'vega', tooltip: tooltipContent.vega, color: 'green', suffix: '/%IV' },
  ];

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">The Greeks</h2>
      <div className="grid grid-cols-2 gap-3">
        {greekCards.map((greek) => (
          <div
            key={greek.key}
            className={`bg-black/70 rounded-lg p-4 border border-neutral-800`}
          >
            <div className="text-sm text-neutral-400 mb-1">
              <InfoTooltip content={greek.tooltip}>{greek.name}</InfoTooltip>
            </div>
            <div className={`text-2xl font-bold text-${greek.color}-400`}>
              {formatGreek(greeks[greek.key])}
              {greek.suffix && <span className="text-sm text-neutral-500">{greek.suffix}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Payoff Chart Component
function PayoffChart({ data, breakEven, optionType }) {
  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">P&L at Expiration</h2>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis
            dataKey="stockPrice"
            stroke="#9CA3AF"
            label={{ value: 'Stock Price ($)', position: 'bottom', fill: '#9CA3AF' }}
          />
          <YAxis
            stroke="#9CA3AF"
            label={{ value: 'P&L ($)', angle: -90, position: 'insideLeft', fill: '#9CA3AF' }}
          />
          <RechartsTooltip
            contentStyle={{
              backgroundColor: '#1F2937',
              border: '1px solid #374151',
              borderRadius: '8px',
            }}
            labelStyle={{ color: '#9CA3AF' }}
            formatter={(value) => [`$${value.toFixed(2)}`, 'P&L']}
            labelFormatter={(label) => `Stock: $${label}`}
          />
          <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="5 5" />
          {breakEven > 0 && (
            <ReferenceLine
              x={breakEven}
              stroke="#F59E0B"
              strokeDasharray="5 5"
              label={{ value: `BE: $${breakEven.toFixed(2)}`, fill: '#F59E0B', position: 'top' }}
            />
          )}
          <Line
            type="linear"
            dataKey="pnl"
            stroke={optionType === 'call' ? '#10B981' : '#EF4444'}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// P&L Heatmap Component
function PnLHeatmap({ heatmapData, dateIntervals, premium, daysToExpiry }) {
  const [displayMode, setDisplayMode] = useState('dollar'); // 'dollar' or 'percent'

  if (!heatmapData || heatmapData.length === 0) return null;

  const getColor = (value, isPercent = false) => {
    const threshold = isPercent ? 100 : 10;
    if (value > 0) {
      const intensity = Math.min(value / threshold, 1);
      return `rgba(16, 185, 129, ${0.2 + intensity * 0.6})`; // Green
    } else if (value < 0) {
      const intensity = Math.min(Math.abs(value) / threshold, 1);
      return `rgba(239, 68, 68, ${0.2 + intensity * 0.6})`; // Red
    }
    return 'rgba(107, 114, 128, 0.3)'; // Gray for zero
  };

  const formatValue = (dollarValue) => {
    if (displayMode === 'percent') {
      const percentValue = (dollarValue / premium) * 100;
      return `${percentValue >= 0 ? '+' : ''}${percentValue.toFixed(0)}%`;
    }
    return `$${dollarValue?.toFixed(2)}`;
  };

  const getColumnLabel = (day) => {
    if (day === 0) return 'Today';
    if (day === daysToExpiry) return 'Expiry';
    return `+${day}d`;
  };

  const isExpiryColumn = (day) => day === daysToExpiry;

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-white">P&L Heatmap (Price x Days)</h2>
        <div className="flex gap-1 bg-neutral-900 rounded-lg p-1">
          <button
            onClick={() => setDisplayMode('dollar')}
            className={`px-3 py-1 text-sm rounded transition-all ${
              displayMode === 'dollar'
                ? 'bg-blue-600 text-white'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            $ P&L
          </button>
          <button
            onClick={() => setDisplayMode('percent')}
            className={`px-3 py-1 text-sm rounded transition-all ${
              displayMode === 'percent'
                ? 'bg-blue-600 text-white'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            % ROI
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="p-2 text-left text-neutral-400">Price</th>
              {dateIntervals.map((day) => (
                <th
                  key={day}
                  className={`p-2 text-center ${
                    isExpiryColumn(day)
                      ? 'text-yellow-400 font-bold bg-yellow-400/10 border-x border-yellow-400/30'
                      : 'text-neutral-400'
                  }`}
                >
                  {getColumnLabel(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heatmapData.map((row, idx) => (
              <tr key={idx}>
                <td className="p-2 text-neutral-300 font-medium">${row.stockPrice}</td>
                {dateIntervals.map((day) => {
                  const dollarValue = row[`day${day}`];
                  const percentValue = (dollarValue / premium) * 100;
                  const isExpiry = isExpiryColumn(day);
                  return (
                    <td
                      key={day}
                      className={`p-2 text-center font-medium ${
                        isExpiry ? 'border-x border-yellow-400/30' : ''
                      }`}
                      style={{ backgroundColor: getColor(displayMode === 'percent' ? percentValue : dollarValue, displayMode === 'percent') }}
                    >
                      <span className={dollarValue >= 0 ? 'text-green-200' : 'text-red-200'}>
                        {formatValue(dollarValue)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-500 mt-3">
        The "Expiry" column shows P&L at expiration (intrinsic value only, no time value remaining).
      </p>
    </div>
  );
}

// Summary Panel Component
function SummaryPanel({ values, greeks, breakEven, daysToExpiry }) {
  const theoreticalPrice = greeks?.price || 0;
  const currentPnL = theoreticalPrice - values.premium;
  const maxLoss = values.premium;
  const maxGain = values.optionType === 'call' ? 'Unlimited' : (values.strikePrice - values.premium).toFixed(2);

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">Position Summary</h2>

      <div className="space-y-3">
        <div className="flex justify-between items-center py-2 border-b border-neutral-800">
          <span className="text-neutral-400">Days to Expiry</span>
          <span className="text-white font-semibold">{daysToExpiry} days</span>
        </div>

        <div className="flex justify-between items-center py-2 border-b border-neutral-800">
          <span className="text-neutral-400">
            <InfoTooltip content={tooltipContent.breakeven}>Break-Even Price</InfoTooltip>
          </span>
          <span className="text-yellow-400 font-semibold">${breakEven.toFixed(2)}</span>
        </div>

        <div className="flex justify-between items-center py-2 border-b border-neutral-800">
          <span className="text-neutral-400">Theoretical Value</span>
          <span className="text-white font-semibold">${theoreticalPrice.toFixed(2)}</span>
        </div>

        <div className="flex justify-between items-center py-2 border-b border-neutral-800">
          <span className="text-neutral-400">Current P&L</span>
          <span className={`font-semibold ${currentPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            ${currentPnL.toFixed(2)} ({((currentPnL / values.premium) * 100).toFixed(1)}%)
          </span>
        </div>

        <div className="flex justify-between items-center py-2 border-b border-neutral-800">
          <span className="text-neutral-400">Max Loss</span>
          <span className="text-red-400 font-semibold">-${maxLoss.toFixed(2)}</span>
        </div>

        <div className="flex justify-between items-center py-2">
          <span className="text-neutral-400">Max Gain</span>
          <span className="text-green-400 font-semibold">
            {typeof maxGain === 'string' ? maxGain : `$${maxGain}`}
          </span>
        </div>
      </div>
    </div>
  );
}

// Saved Positions Component
function SavedPositions({ positions, onLoad, onDelete }) {
  if (positions.length === 0) {
    return (
      <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
        <h2 className="text-xl font-semibold mb-4 text-white">Saved Positions</h2>
        <p className="text-neutral-400 text-sm">No saved positions yet. Save your current analysis to compare later.</p>
      </div>
    );
  }

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">Saved Positions</h2>
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {positions.map((pos, idx) => (
          <div key={idx} className="flex items-center justify-between bg-black/70 rounded-lg p-3">
            <div>
              <span className={`font-medium ${pos.optionType === 'call' ? 'text-green-400' : 'text-red-400'}`}>
                {pos.optionType.toUpperCase()}
              </span>
              <span className="text-neutral-300 ml-2">
                ${pos.strikePrice} @ ${pos.premium}
              </span>
              <span className="text-neutral-500 text-sm ml-2">
                {pos.expirationDate}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => onLoad(pos)}
                className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 rounded text-white transition-colors"
              >
                Load
              </button>
              <button
                onClick={() => onDelete(idx)}
                className="px-3 py-1 text-sm bg-neutral-700 hover:bg-neutral-900 rounded text-white transition-colors"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Main App Component
function App() {
  const [values, setValues] = useState({
    optionType: 'call',
    stockPrice: 100,
    strikePrice: 105,
    premium: 3.50,
    expirationDate: getDefaultExpiry(),
    iv: 30,
    riskFreeRate: 5,
  });

  const [savedPositions, setSavedPositions] = useState(() => {
    const saved = localStorage.getItem('optionsPositions');
    return saved ? JSON.parse(saved) : [];
  });

  // Calculate derived values
  const daysToExpiry = Math.max(0, daysBetween(new Date(), new Date(values.expirationDate)));
  const T = daysToExpiry / 365;
  const sigma = values.iv / 100;
  const r = values.riskFreeRate / 100;

  const greeks = calculateGreeks(
    values.stockPrice,
    values.strikePrice,
    T,
    r,
    sigma,
    values.optionType
  );

  const breakEven = calculateBreakEven(values.strikePrice, values.premium, values.optionType);
  const payoffData = generatePayoffData(values.strikePrice, values.premium, values.optionType, values.stockPrice);
  const { data: heatmapData, dateIntervals } = generateHeatmapData(
    values.strikePrice,
    values.premium,
    values.optionType,
    values.stockPrice,
    daysToExpiry,
    sigma,
    r
  );

  // Save positions to localStorage
  useEffect(() => {
    localStorage.setItem('optionsPositions', JSON.stringify(savedPositions));
  }, [savedPositions]);

  const handleSavePosition = useCallback(() => {
    setSavedPositions((prev) => [...prev, { ...values, savedAt: new Date().toISOString() }]);
  }, [values]);

  const handleLoadPosition = useCallback((position) => {
    const { savedAt, ...positionValues } = position;
    setValues(positionValues);
  }, []);

  const handleDeletePosition = useCallback((index) => {
    setSavedPositions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSelectOption = useCallback((optionData) => {
    setValues((prev) => ({
      ...prev,
      ...optionData,
      iv: Math.round(optionData.iv),
    }));
  }, []);

  const handleStockPriceUpdate = useCallback((price) => {
    setValues((prev) => ({
      ...prev,
      stockPrice: price,
    }));
  }, []);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <header className="border-b border-neutral-800 bg-black/90 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-white">
              Options Profit Projection
            </h1>
            <button
              onClick={handleSavePosition}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
            >
              Save Position
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Options Builder, Ticker Search, Input Form & Greeks */}
          <div className="space-y-6">
            <OptionsBuilder
              onSelectOption={handleSelectOption}
              onStockPriceUpdate={handleStockPriceUpdate}
            />
            <TickerSearch
              onSelectOption={handleSelectOption}
              onStockPriceUpdate={handleStockPriceUpdate}
            />
            <OptionsForm values={values} onChange={setValues} />
            <GreeksDashboard greeks={greeks} />
            <SavedPositions
              positions={savedPositions}
              onLoad={handleLoadPosition}
              onDelete={handleDeletePosition}
            />
          </div>

          {/* Right Column - Charts & Summary */}
          <div className="lg:col-span-2 space-y-6">
            <SummaryPanel
              values={values}
              greeks={greeks}
              breakEven={breakEven}
              daysToExpiry={daysToExpiry}
            />
            <PayoffChart
              data={payoffData}
              breakEven={breakEven}
              optionType={values.optionType}
            />
            <PnLHeatmap
              heatmapData={heatmapData}
              dateIntervals={dateIntervals}
              premium={values.premium}
              daysToExpiry={daysToExpiry}
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-neutral-800 mt-12 py-6">
        <div className="max-w-7xl mx-auto px-6 text-center text-neutral-500 text-sm">
          <p>Options calculator using Black-Scholes pricing model. For educational purposes only.</p>
        </div>
      </footer>
    </div>
  );
}

// Helper to get default expiry (30 days from now)
function getDefaultExpiry() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().split('T')[0];
}

export default App;

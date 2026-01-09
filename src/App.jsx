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
function OptionsBuilder({ onSelectOption, onStockPriceUpdate, onSelectPortfolio }) {
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState({
    ticker: '',
    direction: '',
    budget: '',
    maxRisk: '',
    targetPriceLow: '',
    targetPriceHigh: '',
    selectedExpiries: [],
    multiExpiryPreference: '', // 'spread' = positions across expiries, 'single' = all same expiry
    optimization: '', // 'max_return', 'risk_reward', 'diversified'
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
      const optimization = formData.optimization || 'max_return';
      const selectedExpiries = formData.selectedExpiries;
      const multiExpiryPref = formData.multiExpiryPreference || 'single';

      // Collect all viable options across ALL selected expiries (no limit)
      const allViableOptions = [];

      for (const expiry of selectedExpiries) {
        const data = await fetchOptionsChain(formData.ticker, expiry);
        const options = formData.direction === 'bullish'
          ? (data.options?.calls || [])
          : (data.options?.puts || []);

        for (const opt of options) {
          const premium = getMidPrice(opt);
          const costPer100 = premium * 100;

          if (costPer100 <= 0 || costPer100 > budget) continue;

          // Calculate potential profit at target price
          let intrinsicAtTarget;
          if (formData.direction === 'bullish') {
            if (opt.strike > targetHigh) continue;
            intrinsicAtTarget = Math.max(0, targetHigh - opt.strike);
          } else {
            if (opt.strike < targetLow) continue;
            intrinsicAtTarget = Math.max(0, opt.strike - targetLow);
          }

          const profitPer100 = (intrinsicAtTarget - premium) * 100;
          const returnPct = (profitPer100 / costPer100) * 100;
          const maxQty = Math.floor(budget / costPer100);
          const riskRewardRatio = profitPer100 > 0 ? profitPer100 / costPer100 : -1;

          if (maxQty >= 1 && returnPct > -50) {
            allViableOptions.push({
              option: opt,
              expiry,
              premium,
              costPer100,
              profitPer100,
              returnPct,
              maxQty,
              strike: opt.strike,
              riskRewardRatio,
            });
          }
        }
      }

      // If user prefers single expiry, filter to only the best expiry date
      let optionsToUse = allViableOptions;
      if (multiExpiryPref === 'single' && selectedExpiries.length > 1) {
        // Find which expiry has the best average return
        const expiryReturns = {};
        for (const opt of allViableOptions) {
          if (!expiryReturns[opt.expiry]) {
            expiryReturns[opt.expiry] = { total: 0, count: 0 };
          }
          expiryReturns[opt.expiry].total += opt.returnPct;
          expiryReturns[opt.expiry].count += 1;
        }

        // Pick expiry with best average return
        let bestExpiry = selectedExpiries[0];
        let bestAvg = -Infinity;
        for (const [expiry, data] of Object.entries(expiryReturns)) {
          const avg = data.total / data.count;
          if (avg > bestAvg) {
            bestAvg = avg;
            bestExpiry = parseInt(expiry);
          }
        }

        optionsToUse = allViableOptions.filter(o => o.expiry === bestExpiry);
      }

      // Generate optimal multi-position portfolio based on optimization preference
      const generateOptimalPortfolio = (options, budgetLimit, sortBy) => {
        // Sort options by the chosen metric
        const sorted = [...options].sort((a, b) => {
          if (sortBy === 'max_return') return b.returnPct - a.returnPct;
          if (sortBy === 'risk_reward') return b.riskRewardRatio - a.riskRewardRatio;
          return 0; // diversified uses different logic
        });

        const positions = [];
        let remaining = budgetLimit;

        if (sortBy === 'diversified') {
          // Get unique strikes and expiries, spread budget across them
          const uniqueStrikes = [...new Set(options.map(o => o.strike))];
          const uniqueExpiries = [...new Set(options.map(o => o.expiry))];
          const combinations = [];

          // Create strike/expiry combinations
          for (const strike of uniqueStrikes) {
            for (const expiry of uniqueExpiries) {
              const opt = options.find(o => o.strike === strike && o.expiry === expiry);
              if (opt) combinations.push(opt);
            }
          }

          // Spread budget across combinations
          const perPosition = budgetLimit / Math.min(combinations.length, 8);
          for (const opt of combinations.slice(0, 10)) {
            if (remaining < opt.costPer100) continue;
            const qty = Math.min(Math.floor(perPosition / opt.costPer100), Math.floor(remaining / opt.costPer100));
            if (qty >= 1) {
              positions.push({ ...opt, qty });
              remaining -= qty * opt.costPer100;
            }
          }
        } else {
          // Greedy allocation for max_return or risk_reward
          for (const opt of sorted) {
            if (remaining < opt.costPer100) continue;
            // Allocate proportionally - more to better options
            const allocation = Math.min(remaining, budgetLimit * 0.4);
            const qty = Math.floor(allocation / opt.costPer100);
            if (qty >= 1) {
              positions.push({ ...opt, qty });
              remaining -= qty * opt.costPer100;
            }
            if (positions.length >= 8) break; // Reasonable limit per portfolio
          }
        }

        if (positions.length === 0) return null;

        const totalCost = positions.reduce((sum, p) => sum + p.qty * p.costPer100, 0);
        const totalProfit = positions.reduce((sum, p) => sum + p.qty * p.profitPer100, 0);

        return {
          positions,
          totalCost,
          totalProfit,
          totalReturn: (totalProfit / totalCost) * 100,
        };
      };

      const portfolios = [];

      // Generate primary recommended portfolio based on user's optimization preference
      const primaryPortfolio = generateOptimalPortfolio(optionsToUse, Math.min(budget, maxRisk), optimization);
      if (primaryPortfolio) {
        const optimizationNames = {
          max_return: { name: 'Maximum Return', desc: 'Optimized for highest potential ROI at your target price' },
          risk_reward: { name: 'Best Risk/Reward', desc: 'Balanced allocation prioritizing favorable risk/reward ratios' },
          diversified: { name: 'Diversified', desc: 'Spread across multiple strikes and expiries to reduce risk' },
        };
        portfolios.push({
          ...primaryPortfolio,
          name: `Recommended: ${optimizationNames[optimization].name}`,
          description: optimizationNames[optimization].desc,
          isRecommended: true,
        });
      }

      // Generate alternative portfolios with different strategies
      const alternatives = ['max_return', 'risk_reward', 'diversified'].filter(o => o !== optimization);
      for (const alt of alternatives) {
        const altPortfolio = generateOptimalPortfolio(optionsToUse, Math.min(budget, maxRisk), alt);
        if (altPortfolio && altPortfolio.positions.length > 0) {
          const altNames = {
            max_return: { name: 'High Return Focus', desc: 'Alternative focused on maximum percentage gains' },
            risk_reward: { name: 'Balanced Approach', desc: 'Alternative with better risk/reward balance' },
            diversified: { name: 'Spread Strategy', desc: 'Alternative spreading risk across positions' },
          };
          portfolios.push({
            ...altPortfolio,
            name: altNames[alt].name,
            description: altNames[alt].desc,
          });
        }
      }

      // Add a single-position "simple" option for comparison
      if (optionsToUse.length > 0) {
        const best = [...optionsToUse].sort((a, b) => b.returnPct - a.returnPct)[0];
        const qty = Math.min(best.maxQty, Math.floor(maxRisk / best.costPer100));
        if (qty >= 1) {
          portfolios.push({
            name: 'Simple (Single Position)',
            description: `All-in on the highest return option: $${best.strike} strike`,
            positions: [{ ...best, qty }],
            totalCost: qty * best.costPer100,
            totalProfit: qty * best.profitPer100,
            totalReturn: best.returnPct,
          });
        }
      }

      // Sort by recommended first, then by return
      portfolios.sort((a, b) => {
        if (a.isRecommended) return -1;
        if (b.isRecommended) return 1;
        return b.totalReturn - a.totalReturn;
      });

      setSuggestions(portfolios);
      setStep(8);
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  const selectSuggestion = (portfolioData, positionIndex = 0) => {
    // Load the first position (or specified position) into the calculator
    const position = portfolioData.positions[positionIndex];
    const formatted = formatOptionData(position.option);
    const optionType = formData.direction === 'bullish' ? 'call' : 'put';

    onSelectOption({
      strikePrice: formatted.strike,
      premium: position.premium,
      iv: formatted.impliedVolatility,
      expirationDate: unixToDate(position.option.expiration),
      optionType: optionType,
    });

    // If portfolio has multiple positions, pass them all
    if (portfolioData.positions.length > 1) {
      const portfolioPositions = portfolioData.positions.map(pos => ({
        strikePrice: pos.strike,
        premium: pos.premium,
        iv: formatOptionData(pos.option).impliedVolatility,
        expirationDate: unixToDate(pos.expiry),
        optionType: optionType,
        qty: pos.qty,
        costPer100: pos.costPer100,
      }));
      onSelectPortfolio(portfolioPositions);
    } else {
      onSelectPortfolio([]);
    }
  };

  const resetBuilder = () => {
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
      multiExpiryPreference: '',
      optimization: '',
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
            <div className="max-h-64 overflow-y-auto space-y-2 mb-4">
              {availableExpiries.map(exp => {
                const expDate = new Date(exp * 1000);
                const now = new Date();
                const daysOut = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
                const weeksOut = Math.floor(daysOut / 7);
                const monthsOut = Math.floor(daysOut / 30);
                let timeLabel = `${daysOut}d`;
                if (monthsOut >= 1) timeLabel = `${monthsOut}mo`;
                else if (weeksOut >= 1) timeLabel = `${weeksOut}w`;

                return (
                  <button
                    key={exp}
                    onClick={() => toggleExpiry(exp)}
                    className={`w-full p-3 rounded-lg border text-left transition-all ${
                      formData.selectedExpiries.includes(exp)
                        ? 'border-blue-500 bg-blue-500/20'
                        : 'border-neutral-700 hover:border-neutral-600'
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <span className="text-white">{unixToDate(exp)}</span>
                      <span className="text-neutral-500 text-sm">{timeLabel}</span>
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-neutral-500 mb-3">{availableExpiries.length} expiry dates available (up to 12+ months)</p>
            <div className="flex gap-2">
              <button onClick={() => setStep(2)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={() => {
                  // If multiple expiries selected, ask about multi-expiry preference
                  // Otherwise skip to budget step
                  if (formData.selectedExpiries.length > 1) {
                    setStep(4);
                  } else {
                    handleInputChange('multiExpiryPreference', 'single');
                    setStep(5);
                  }
                }}
                disabled={formData.selectedExpiries.length === 0}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Next ({formData.selectedExpiries.length} selected)
              </button>
            </div>
          </>
        );

      case 4:
        // Multi-expiry preference - only shown if multiple expiries selected
        return (
          <>
            <p className="text-neutral-400 mb-4">
              You selected {formData.selectedExpiries.length} expiry dates. How would you like positions distributed?
            </p>
            <div className="space-y-2 mb-4">
              {[
                {
                  value: 'spread',
                  label: 'Spread across expiries',
                  desc: 'Diversify with positions at different expiry dates for time-based risk management'
                },
                {
                  value: 'single',
                  label: 'Same expiry date',
                  desc: 'All positions expire together - simpler to manage, concentrated timing'
                },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => handleInputChange('multiExpiryPreference', opt.value)}
                  className={`w-full p-4 rounded-lg border text-left transition-all ${
                    formData.multiExpiryPreference === opt.value
                      ? 'border-blue-500 bg-blue-500/20'
                      : 'border-neutral-700 hover:border-neutral-600'
                  }`}
                >
                  <div className="font-medium text-white">{opt.label}</div>
                  <div className="text-xs text-neutral-400">{opt.desc}</div>
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep(3)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={() => setStep(5)}
                disabled={!formData.multiExpiryPreference}
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
              <button onClick={() => formData.selectedExpiries.length > 1 ? setStep(4) : setStep(3)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={() => setStep(6)}
                disabled={!formData.budget}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Next
              </button>
            </div>
          </>
        );

      case 6:
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
              <button onClick={() => setStep(5)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={() => setStep(7)}
                disabled={!formData.maxRisk}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Next
              </button>
            </div>
          </>
        );

      case 7:
        return (
          <>
            <p className="text-neutral-400 mb-4">What's your priority for this trade?</p>
            <div className="space-y-2 mb-4">
              {[
                { value: 'max_return', label: 'Maximum Return', desc: 'Focus on highest potential % gain at your target price' },
                { value: 'risk_reward', label: 'Best Risk/Reward', desc: 'Balance between potential gains and risk of loss' },
                { value: 'diversified', label: 'Diversified', desc: 'Spread across multiple strikes/expiries to reduce risk' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { handleInputChange('optimization', opt.value); }}
                  className={`w-full p-4 rounded-lg border text-left transition-all ${
                    formData.optimization === opt.value
                      ? 'border-blue-500 bg-blue-500/20'
                      : 'border-neutral-700 hover:border-neutral-600'
                  }`}
                >
                  <div className="font-medium text-white">{opt.label}</div>
                  <div className="text-xs text-neutral-400">{opt.desc}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-neutral-500 mb-4">
              Based on your {formData.direction} outlook and ${formData.budget} budget, we'll find the optimal portfolio.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setStep(6)} className="px-4 py-2 text-neutral-400">Back</button>
              <button
                onClick={generateSuggestions}
                disabled={!formData.optimization}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white"
              >
                Find Portfolios
              </button>
            </div>
          </>
        );

      case 8:
        return (
          <>
            {suggestions.length > 0 ? (
              <>
                <p className="text-neutral-400 mb-4">Portfolio strategies for your ${formData.budget} budget:</p>
                <div className="space-y-4">
                  {suggestions.map((portfolio, idx) => (
                    <div key={idx} className={`bg-black/70 rounded-lg p-4 border ${portfolio.isRecommended ? 'border-green-500/50 ring-1 ring-green-500/30' : 'border-neutral-800'}`}>
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <span className="font-semibold text-white">{portfolio.name}</span>
                          {portfolio.isRecommended && <span className="ml-2 text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">Best Match</span>}
                          <p className="text-xs text-neutral-500 mt-1">{portfolio.description}</p>
                        </div>
                        <span className={`font-bold text-lg ${portfolio.totalReturn >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {portfolio.totalReturn >= 0 ? '+' : ''}{portfolio.totalReturn.toFixed(0)}%
                        </span>
                      </div>

                      {/* Positions breakdown */}
                      <div className="mt-3 space-y-2">
                        {portfolio.positions.map((pos, posIdx) => (
                          <div key={posIdx} className="flex justify-between items-center text-sm bg-neutral-900/50 rounded px-3 py-2">
                            <div className="flex flex-col">
                              <div>
                                <span className={`font-medium ${formData.direction === 'bullish' ? 'text-green-400' : 'text-red-400'}`}>
                                  {pos.qty}x
                                </span>
                                <span className="text-white ml-2">${pos.strike} strike</span>
                                <span className="text-neutral-500 ml-2">@ ${pos.premium.toFixed(2)}</span>
                              </div>
                              <span className="text-xs text-blue-400">Exp: {unixToDate(pos.expiry)}</span>
                            </div>
                            <div className="text-right">
                              <span className="text-neutral-400">${(pos.qty * pos.costPer100).toFixed(0)}</span>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Summary */}
                      <div className="mt-3 pt-3 border-t border-neutral-700 grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <div className="text-neutral-500">Total Cost</div>
                          <div className="text-white font-medium">${portfolio.totalCost.toFixed(0)}</div>
                        </div>
                        <div>
                          <div className="text-neutral-500">Max Loss</div>
                          <div className="text-red-400 font-medium">-${portfolio.totalCost.toFixed(0)}</div>
                        </div>
                        <div>
                          <div className="text-neutral-500">Target Profit</div>
                          <div className="text-green-400 font-medium">
                            {portfolio.totalProfit >= 0 ? '+' : ''}${portfolio.totalProfit.toFixed(0)}
                          </div>
                        </div>
                      </div>

                      {/* Single Load Portfolio Button */}
                      <button
                        onClick={() => selectSuggestion(portfolio)}
                        className="w-full mt-3 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium"
                      >
                        Load Portfolio ({portfolio.positions.length} position{portfolio.positions.length > 1 ? 's' : ''})
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-neutral-400">No options found matching your criteria. Try adjusting your targets or budget.</p>
            )}
            <button
              onClick={resetBuilder}
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
function PayoffChart({ data, breakEven, optionType, portfolio, stockPrice }) {
  const hasPortfolio = portfolio && portfolio.length > 1;

  // Generate combined portfolio P&L data
  const generatePortfolioData = () => {
    if (!hasPortfolio || !stockPrice) return null;

    const priceRange = 0.3;
    const minPrice = Math.max(0, stockPrice * (1 - priceRange));
    const maxPrice = stockPrice * (1 + priceRange);
    const step = (maxPrice - minPrice) / 50;

    const chartData = [];
    for (let price = minPrice; price <= maxPrice; price += step) {
      let totalPnL = 0;
      for (const pos of portfolio) {
        const qty = pos.qty || 1;
        const premium = pos.premium;
        const strike = pos.strikePrice;
        const type = pos.optionType;

        let intrinsic;
        if (type === 'call') {
          intrinsic = Math.max(0, price - strike);
        } else {
          intrinsic = Math.max(0, strike - price);
        }
        totalPnL += (intrinsic - premium) * 100 * qty;
      }
      chartData.push({
        stockPrice: parseFloat(price.toFixed(2)),
        pnl: parseFloat(totalPnL.toFixed(2)),
      });
    }
    return chartData;
  };

  const chartData = hasPortfolio ? generatePortfolioData() : data;
  const totalCost = hasPortfolio
    ? portfolio.reduce((sum, p) => sum + (p.costPer100 || p.premium * 100) * (p.qty || 1), 0)
    : null;

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-white">
          {hasPortfolio ? 'Combined Portfolio P&L at Expiration' : 'P&L at Expiration'}
        </h2>
        {hasPortfolio && (
          <span className="text-sm text-neutral-400">
            {portfolio.length} positions | Total cost: ${totalCost?.toFixed(0)}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
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
            formatter={(value) => [`$${value.toFixed(2)}`, hasPortfolio ? 'Portfolio P&L' : 'P&L']}
            labelFormatter={(label) => `Stock: $${label}`}
          />
          <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="5 5" />
          {!hasPortfolio && breakEven > 0 && (
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
            stroke={hasPortfolio ? '#8B5CF6' : (optionType === 'call' ? '#10B981' : '#EF4444')}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
      {hasPortfolio && (
        <p className="text-xs text-neutral-500 mt-2">
          Combined P&L across all {portfolio.length} positions at expiration (assumes all expire on the same date for simplicity)
        </p>
      )}
    </div>
  );
}

// P&L Heatmap Component
function PnLHeatmap({ heatmapData, dateIntervals, premium, daysToExpiry, portfolio, stockPrice, optionType, strikePrice }) {
  const [displayMode, setDisplayMode] = useState('dollar'); // 'dollar' or 'percent'
  const [viewMode, setViewMode] = useState('expiry'); // 'expiry' or 'dateRange'
  const [interval, setInterval] = useState(7); // days between columns

  if (!heatmapData || heatmapData.length === 0) return null;

  // Check if we have a multi-position portfolio
  const hasPortfolio = portfolio && portfolio.length > 1;

  // Get unique expiry dates from portfolio, sorted
  const portfolioExpiries = hasPortfolio
    ? [...new Set(portfolio.map(p => p.expirationDate))].sort()
    : [];

  // Calculate days to each portfolio expiry
  const portfolioExpiryDays = portfolioExpiries.map(expiry => ({
    date: expiry,
    days: Math.max(0, daysBetween(new Date(), new Date(expiry)))
  }));

  // Get max days to expiry for date range view
  const maxDaysToExpiry = hasPortfolio
    ? Math.max(...portfolioExpiryDays.map(e => e.days))
    : daysToExpiry;

  // Generate date intervals for date range view
  const generateDateRangeIntervals = () => {
    const intervals = [0]; // Start with today
    for (let d = interval; d < maxDaysToExpiry; d += interval) {
      intervals.push(d);
    }
    if (intervals[intervals.length - 1] !== maxDaysToExpiry) {
      intervals.push(maxDaysToExpiry); // Always include final expiry
    }
    return intervals;
  };

  // Calculate P&L for positions expiring on a SPECIFIC date only (not cumulative)
  const calcPnLForExpiryDate = (price, targetExpiry) => {
    if (!hasPortfolio) return 0;

    let totalPnL = 0;
    for (const pos of portfolio) {
      // Only include positions that expire on THIS specific date
      if (pos.expirationDate === targetExpiry) {
        const qty = pos.qty || 1;
        const intrinsic = pos.optionType === 'call'
          ? Math.max(0, price - pos.strikePrice)
          : Math.max(0, pos.strikePrice - price);
        // P&L = (intrinsic - premium paid) * 100 shares * quantity
        totalPnL += (intrinsic - pos.premium) * 100 * qty;
      }
    }
    return totalPnL;
  };

  // Calculate portfolio P&L at a specific day (using Black-Scholes for time value)
  const calcPortfolioPnLAtDay = (price, daysFromNow) => {
    if (!hasPortfolio) return 0;

    let totalPnL = 0;
    const r = 0.05; // risk-free rate
    const sigma = 0.30; // default IV

    for (const pos of portfolio) {
      const qty = pos.qty || 1;
      const posExpDays = daysBetween(new Date(), new Date(pos.expirationDate));
      const daysRemaining = posExpDays - daysFromNow;

      let optionValue;
      if (daysRemaining <= 0) {
        // Position has expired - use intrinsic value
        optionValue = pos.optionType === 'call'
          ? Math.max(0, price - pos.strikePrice)
          : Math.max(0, pos.strikePrice - price);
      } else {
        // Position still has time - use Black-Scholes
        const T = daysRemaining / 365;
        const posIV = (pos.iv || 30) / 100;
        optionValue = calculateOptionPrice(price, pos.strikePrice, T, r, posIV, pos.optionType);
      }

      totalPnL += (optionValue - pos.premium) * 100 * qty;
    }
    return totalPnL;
  };

  // Get cost for positions expiring on a specific date
  const getCostForExpiryDate = (targetExpiry) => {
    if (!hasPortfolio) return premium * 100;

    let totalCost = 0;
    for (const pos of portfolio) {
      if (pos.expirationDate === targetExpiry) {
        const qty = pos.qty || 1;
        totalCost += (pos.costPer100 || pos.premium * 100) * qty;
      }
    }
    return totalCost || premium * 100;
  };

  // Get total portfolio cost
  const totalPortfolioCost = hasPortfolio
    ? portfolio.reduce((sum, p) => sum + (p.costPer100 || p.premium * 100) * (p.qty || 1), 0)
    : premium * 100;

  const getColor = (value, isPercent = false) => {
    const threshold = isPercent ? 100 : 500; // Adjusted threshold for larger portfolios
    if (value > 0) {
      const intensity = Math.min(value / threshold, 1);
      return `rgba(16, 185, 129, ${0.2 + intensity * 0.6})`;
    } else if (value < 0) {
      const intensity = Math.min(Math.abs(value) / threshold, 1);
      return `rgba(239, 68, 68, ${0.2 + intensity * 0.6})`;
    }
    return 'rgba(107, 114, 128, 0.3)';
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

  // For single option mode, just show the standard heatmap
  if (!hasPortfolio) {
    return (
      <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-white">P&L Heatmap (Price x Days)</h2>
          <div className="flex gap-1 bg-neutral-900 rounded-lg p-1">
            <button
              onClick={() => setDisplayMode('dollar')}
              className={`px-3 py-1 text-sm rounded transition-all ${displayMode === 'dollar' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-white'}`}
            >
              $ P&L
            </button>
            <button
              onClick={() => setDisplayMode('percent')}
              className={`px-3 py-1 text-sm rounded transition-all ${displayMode === 'percent' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-white'}`}
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
                  <th key={day} className={`p-2 text-center ${isExpiryColumn(day) ? 'text-yellow-400 font-bold bg-yellow-400/10' : 'text-neutral-400'}`}>
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
                    return (
                      <td
                        key={day}
                        className="p-2 text-center font-medium"
                        style={{ backgroundColor: getColor(displayMode === 'percent' ? percentValue : dollarValue * 10, displayMode === 'percent') }}
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
          The "Expiry" column shows P&L at expiration (intrinsic value only).
        </p>
      </div>
    );
  }

  // Portfolio mode
  const colorClasses = ['blue', 'purple', 'orange', 'green'];
  const dateRangeIntervals = generateDateRangeIntervals();

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <h2 className="text-xl font-semibold text-white">
          {viewMode === 'expiry' ? 'Portfolio P&L at Expiration' : 'Portfolio P&L Over Time'}
        </h2>
        <div className="flex gap-2">
          {/* View Mode Toggle */}
          <div className="flex gap-1 bg-neutral-900 rounded-lg p-1">
            <button
              onClick={() => setViewMode('expiry')}
              className={`px-3 py-1 text-sm rounded transition-all ${viewMode === 'expiry' ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-white'}`}
            >
              Expiry View
            </button>
            <button
              onClick={() => setViewMode('dateRange')}
              className={`px-3 py-1 text-sm rounded transition-all ${viewMode === 'dateRange' ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-white'}`}
            >
              Date Range
            </button>
          </div>
          {/* Dollar/Percent Toggle */}
          <div className="flex gap-1 bg-neutral-900 rounded-lg p-1">
            <button
              onClick={() => setDisplayMode('dollar')}
              className={`px-3 py-1 text-sm rounded transition-all ${displayMode === 'dollar' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-white'}`}
            >
              $ P&L
            </button>
            <button
              onClick={() => setDisplayMode('percent')}
              className={`px-3 py-1 text-sm rounded transition-all ${displayMode === 'percent' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-white'}`}
            >
              % ROI
            </button>
          </div>
        </div>
      </div>

      {/* Date Range Controls */}
      {viewMode === 'dateRange' && (
        <div className="mb-4 flex items-center gap-4">
          <span className="text-sm text-neutral-400">Interval:</span>
          <div className="flex gap-1">
            {[5, 7, 10, 14, 30].map(days => (
              <button
                key={days}
                onClick={() => setInterval(days)}
                className={`px-2 py-1 text-xs rounded transition-all ${interval === days ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
              >
                {days}d
              </button>
            ))}
          </div>
          <span className="text-xs text-neutral-500">
            ({dateRangeIntervals.length} columns, 0 to {maxDaysToExpiry} days)
          </span>
        </div>
      )}

      {/* Expiry View: Portfolio Expiry Legend */}
      {viewMode === 'expiry' && (
        <div className="mb-3 flex flex-wrap gap-3">
          {portfolioExpiryDays.map((exp, idx) => {
            const positionsForExpiry = portfolio.filter(p => p.expirationDate === exp.date);
            const cost = getCostForExpiryDate(exp.date);
            return (
              <div key={idx} className="flex items-center gap-2 text-xs bg-neutral-900 rounded px-2 py-1">
                <div className={`w-3 h-3 rounded bg-${colorClasses[idx % colorClasses.length]}-500`}></div>
                <span className="text-neutral-300">
                  Exp {idx + 1}: {exp.date} ({exp.days}d) - {positionsForExpiry.length} pos, ${cost.toFixed(0)} cost
                </span>
              </div>
          );
        })}
      </div>
      )}

      {/* EXPIRY VIEW TABLE */}
      {viewMode === 'expiry' && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="p-2 text-left text-neutral-400">Stock Price</th>
                  {portfolioExpiryDays.map((exp, idx) => (
                    <th
                      key={idx}
                      className={`p-2 text-center font-bold text-${colorClasses[idx % colorClasses.length]}-400 bg-${colorClasses[idx % colorClasses.length]}-400/10`}
                    >
                      Expiry {idx + 1}
                      <div className="text-xs font-normal opacity-70">{exp.date}</div>
                    </th>
                  ))}
                  <th className="p-2 text-center font-bold text-yellow-400 bg-yellow-400/10">
                    Total P&L
                    <div className="text-xs font-normal opacity-70">All positions</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {heatmapData.map((row, idx) => {
                  const expiryPnLs = portfolioExpiryDays.map(exp => ({
                    pnl: calcPnLForExpiryDate(row.stockPrice, exp.date),
                    cost: getCostForExpiryDate(exp.date)
                  }));
                  const totalPnL = expiryPnLs.reduce((sum, e) => sum + e.pnl, 0);
                  const totalCost = portfolio.reduce((sum, p) => sum + (p.costPer100 || p.premium * 100) * (p.qty || 1), 0);

                  return (
                    <tr key={idx}>
                      <td className="p-2 text-neutral-300 font-medium">${row.stockPrice}</td>
                      {expiryPnLs.map((expData, expIdx) => {
                        const percentValue = expData.cost > 0 ? (expData.pnl / expData.cost) * 100 : 0;
                        return (
                          <td
                            key={expIdx}
                            className={`p-2 text-center font-medium border-x border-${colorClasses[expIdx % colorClasses.length]}-400/30`}
                            style={{ backgroundColor: getColor(displayMode === 'percent' ? percentValue : expData.pnl, displayMode === 'percent') }}
                          >
                            <span className={expData.pnl >= 0 ? 'text-green-200' : 'text-red-200'}>
                              {displayMode === 'percent'
                                ? `${percentValue >= 0 ? '+' : ''}${percentValue.toFixed(0)}%`
                                : `$${expData.pnl.toFixed(0)}`}
                            </span>
                          </td>
                        );
                      })}
                      <td
                        className="p-2 text-center font-bold border-x border-yellow-400/30"
                        style={{ backgroundColor: getColor(displayMode === 'percent' ? (totalPnL / totalCost) * 100 : totalPnL, displayMode === 'percent') }}
                      >
                        <span className={totalPnL >= 0 ? 'text-green-200' : 'text-red-200'}>
                          {displayMode === 'percent'
                            ? `${(totalPnL / totalCost) * 100 >= 0 ? '+' : ''}${((totalPnL / totalCost) * 100).toFixed(0)}%`
                            : `$${totalPnL.toFixed(0)}`}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-neutral-500 mt-3">
            Each Expiry column shows P&L for positions expiring on that date. Total shows combined portfolio P&L.
          </p>
        </>
      )}

      {/* DATE RANGE VIEW TABLE */}
      {viewMode === 'dateRange' && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="p-2 text-left text-neutral-400">Stock Price</th>
                  {dateRangeIntervals.map((day, idx) => {
                    const isLastExpiry = day === maxDaysToExpiry;
                    return (
                      <th
                        key={idx}
                        className={`p-2 text-center ${isLastExpiry ? 'text-yellow-400 font-bold bg-yellow-400/10' : 'text-neutral-400'}`}
                      >
                        {day === 0 ? 'Today' : `+${day}d`}
                        {isLastExpiry && <div className="text-xs opacity-70">Expiry</div>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {heatmapData.map((row, idx) => {
                  return (
                    <tr key={idx}>
                      <td className="p-2 text-neutral-300 font-medium">${row.stockPrice}</td>
                      {dateRangeIntervals.map((day, dayIdx) => {
                        const pnl = calcPortfolioPnLAtDay(row.stockPrice, day);
                        const percentValue = totalPortfolioCost > 0 ? (pnl / totalPortfolioCost) * 100 : 0;
                        const isLastExpiry = day === maxDaysToExpiry;
                        return (
                          <td
                            key={dayIdx}
                            className={`p-2 text-center font-medium ${isLastExpiry ? 'border-x border-yellow-400/30' : ''}`}
                            style={{ backgroundColor: getColor(displayMode === 'percent' ? percentValue : pnl, displayMode === 'percent') }}
                          >
                            <span className={pnl >= 0 ? 'text-green-200' : 'text-red-200'}>
                              {displayMode === 'percent'
                                ? `${percentValue >= 0 ? '+' : ''}${percentValue.toFixed(0)}%`
                                : `$${pnl.toFixed(0)}`}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-neutral-500 mt-3">
            Shows combined portfolio P&L at each date. Uses Black-Scholes for time value before expiry.
          </p>
        </>
      )}
    </div>
  );
}

// Summary Panel Component
function SummaryPanel({ values, greeks, breakEven, daysToExpiry, portfolio }) {
  const theoreticalPrice = greeks?.price || 0;
  const currentPnL = theoreticalPrice - values.premium;
  const maxLoss = values.premium;
  const maxGain = values.optionType === 'call' ? 'Unlimited' : (values.strikePrice - values.premium).toFixed(2);

  // Calculate portfolio totals if multiple positions
  const hasPortfolio = portfolio && portfolio.length > 1;
  const portfolioTotalCost = hasPortfolio
    ? portfolio.reduce((sum, p) => sum + (p.costPer100 || p.premium * 100) * (p.qty || 1), 0)
    : null;

  // Get unique expiry dates from portfolio
  const portfolioExpiries = hasPortfolio
    ? [...new Set(portfolio.map(p => p.expirationDate))].sort()
    : [];

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">Position Summary - ${values.ticker?.toUpperCase() || 'N/A'}</h2>

      <div className="space-y-3">
        {/* Show multiple expiry dates if portfolio */}
        {hasPortfolio ? (
          <div className="py-2 border-b border-neutral-800">
            <span className="text-neutral-400 block mb-2">Expiry Dates ({portfolioExpiries.length})</span>
            <div className="space-y-1">
              {portfolioExpiries.map((expiry, idx) => {
                const days = Math.max(0, daysBetween(new Date(), new Date(expiry)));
                const positionsForExpiry = portfolio.filter(p => p.expirationDate === expiry);
                return (
                  <div key={idx} className="flex justify-between items-center text-sm">
                    <span className="text-blue-400">Expiry {idx + 1}: {expiry}</span>
                    <span className="text-white">{days}d ({positionsForExpiry.length} position{positionsForExpiry.length > 1 ? 's' : ''})</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex justify-between items-center py-2 border-b border-neutral-800">
            <span className="text-neutral-400">Days to Expiry</span>
            <span className="text-white font-semibold">{daysToExpiry} days</span>
          </div>
        )}

        {/* Portfolio positions summary */}
        {hasPortfolio && (
          <div className="py-2 border-b border-neutral-800">
            <span className="text-neutral-400 block mb-2">Portfolio Positions</span>
            <div className="space-y-1">
              {portfolio.map((pos, idx) => (
                <div key={idx} className="flex justify-between items-center text-sm bg-neutral-900/50 rounded px-2 py-1">
                  <span className="text-white">
                    {pos.qty || 1}x ${pos.strikePrice} {pos.optionType}
                  </span>
                  <span className="text-neutral-400">{pos.expirationDate}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between items-center mt-2 pt-2 border-t border-neutral-700">
              <span className="text-neutral-400">Total Cost</span>
              <span className="text-white font-semibold">${portfolioTotalCost.toFixed(0)}</span>
            </div>
          </div>
        )}

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
          <span className="text-red-400 font-semibold">
            {hasPortfolio ? `-$${portfolioTotalCost.toFixed(0)}` : `-$${maxLoss.toFixed(2)}`}
          </span>
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
function SavedPositions({ positions, onLoad, onDelete, onCompare, compareList }) {
  if (positions.length === 0) {
    return (
      <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
        <h2 className="text-xl font-semibold mb-4 text-white">Saved Positions & Portfolios</h2>
        <p className="text-neutral-400 text-sm">No saved items yet. Save your current analysis or portfolio to compare later.</p>
      </div>
    );
  }

  const isInCompare = (idx) => compareList.includes(idx);

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">Saved Positions & Portfolios</h2>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {positions.map((item, idx) => {
          const isPortfolio = item.type === 'portfolio';

          if (isPortfolio) {
            // Render portfolio
            return (
              <div key={idx} className="bg-black/70 rounded-lg p-3 border border-purple-500/30">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">PORTFOLIO</span>
                      <span className="text-white font-medium">{item.positionCount} positions</span>
                    </div>
                    <div className="text-sm text-neutral-400 mt-1">
                      <span>Cost: ${item.totalCost?.toFixed(0)}</span>
                      <span className="mx-2">•</span>
                      <span>{item.expiries?.length || 1} expir{item.expiries?.length === 1 ? 'y' : 'ies'}</span>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => onLoad(item)}
                      className="px-2 py-1 text-xs bg-purple-600 hover:bg-purple-700 rounded text-white transition-colors"
                    >
                      Load
                    </button>
                    <button
                      onClick={() => onDelete(idx)}
                      className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-white transition-colors"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </div>
            );
          }

          // Render single position
          return (
            <div key={idx} className={`flex items-center justify-between bg-black/70 rounded-lg p-3 ${isInCompare(idx) ? 'ring-1 ring-purple-500' : ''}`}>
              <div>
                <span className={`font-medium ${item.optionType === 'call' ? 'text-green-400' : 'text-red-400'}`}>
                  {item.optionType?.toUpperCase()}
                </span>
                <span className="text-neutral-300 ml-2">
                  ${item.strikePrice} @ ${item.premium}
                </span>
                <span className="text-neutral-500 text-sm ml-2">
                  {item.expirationDate}
                </span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => onCompare(idx)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    isInCompare(idx)
                      ? 'bg-purple-600 text-white'
                      : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                  }`}
                  title={isInCompare(idx) ? 'Remove from compare' : 'Add to compare'}
                >
                  {isInCompare(idx) ? '✓' : '+'}
                </button>
                <button
                  onClick={() => onLoad(item)}
                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white transition-colors"
                >
                  Load
                </button>
                <button
                  onClick={() => onDelete(idx)}
                  className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-white transition-colors"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {compareList.length > 0 && (
        <p className="text-xs text-purple-400 mt-2">{compareList.length} position(s) selected for comparison</p>
      )}
    </div>
  );
}

// Compare Chart Component - Compare P&L for multiple positions
function CompareChart({ positions, currentPosition, stockPrice }) {
  const colors = ['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6'];

  // Generate comparison data
  const allPositions = [
    { ...currentPosition, label: 'Current' },
    ...positions.map((pos, idx) => ({ ...pos, label: `Position ${idx + 1}` }))
  ];

  const priceRange = 0.3;
  const minPrice = Math.max(0, stockPrice * (1 - priceRange));
  const maxPrice = stockPrice * (1 + priceRange);
  const step = (maxPrice - minPrice) / 50;

  const data = [];
  for (let price = minPrice; price <= maxPrice; price += step) {
    const point = { stockPrice: parseFloat(price.toFixed(2)) };
    allPositions.forEach((pos, idx) => {
      let intrinsic;
      if (pos.optionType === 'call') {
        intrinsic = Math.max(0, price - pos.strikePrice);
      } else {
        intrinsic = Math.max(0, pos.strikePrice - price);
      }
      point[`pnl${idx}`] = parseFloat((intrinsic - pos.premium).toFixed(2));
    });
    data.push(point);
  }

  if (positions.length === 0) {
    return (
      <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
        <h2 className="text-xl font-semibold mb-4 text-white">Compare Positions</h2>
        <p className="text-neutral-400 text-sm">Select positions from "Saved Positions" to compare their P&L charts.</p>
      </div>
    );
  }

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <h2 className="text-xl font-semibold mb-4 text-white">Compare Positions (P&L at Expiry)</h2>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-4">
        {allPositions.map((pos, idx) => (
          <div key={idx} className="flex items-center gap-2 text-sm">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: colors[idx % colors.length] }}></div>
            <span className="text-neutral-300">
              {pos.label}: {pos.optionType.toUpperCase()} ${pos.strikePrice} ({pos.expirationDate})
            </span>
          </div>
        ))}
      </div>

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
            formatter={(value, name) => {
              const idx = parseInt(name.replace('pnl', ''));
              return [`$${value.toFixed(2)}`, allPositions[idx]?.label || name];
            }}
            labelFormatter={(label) => `Stock: $${label}`}
          />
          <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="5 5" />
          {allPositions.map((pos, idx) => (
            <Line
              key={idx}
              type="linear"
              dataKey={`pnl${idx}`}
              stroke={colors[idx % colors.length]}
              strokeWidth={idx === 0 ? 3 : 2}
              strokeDasharray={idx === 0 ? undefined : '5 5'}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      {/* Comparison Table */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-neutral-400 border-b border-neutral-700">
              <th className="p-2 text-left">Position</th>
              <th className="p-2 text-center">Type</th>
              <th className="p-2 text-center">Strike</th>
              <th className="p-2 text-center">Premium</th>
              <th className="p-2 text-center">Expiry</th>
              <th className="p-2 text-center">Break-Even</th>
            </tr>
          </thead>
          <tbody>
            {allPositions.map((pos, idx) => {
              const breakEven = pos.optionType === 'call'
                ? pos.strikePrice + pos.premium
                : pos.strikePrice - pos.premium;
              return (
                <tr key={idx} className="border-b border-neutral-800">
                  <td className="p-2">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded" style={{ backgroundColor: colors[idx % colors.length] }}></div>
                      <span className="text-white">{pos.label}</span>
                    </div>
                  </td>
                  <td className={`p-2 text-center font-medium ${pos.optionType === 'call' ? 'text-green-400' : 'text-red-400'}`}>
                    {pos.optionType.toUpperCase()}
                  </td>
                  <td className="p-2 text-center text-white">${pos.strikePrice}</td>
                  <td className="p-2 text-center text-white">${pos.premium}</td>
                  <td className="p-2 text-center text-neutral-400">{pos.expirationDate}</td>
                  <td className="p-2 text-center text-yellow-400">${breakEven.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

  const [compareList, setCompareList] = useState([]);

  // Portfolio state for multi-position strategies
  const [portfolio, setPortfolio] = useState([]);

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
    setSavedPositions((prev) => [...prev, { ...values, type: 'position', savedAt: new Date().toISOString() }]);
  }, [values]);

  const handleSavePortfolio = useCallback(() => {
    if (portfolio.length === 0) return;

    const totalCost = portfolio.reduce((sum, p) => sum + (p.costPer100 || p.premium * 100) * (p.qty || 1), 0);
    const expiries = [...new Set(portfolio.map(p => p.expirationDate))];

    setSavedPositions((prev) => [...prev, {
      type: 'portfolio',
      name: `Portfolio (${portfolio.length} positions)`,
      positions: portfolio,
      totalCost,
      expiries,
      positionCount: portfolio.length,
      savedAt: new Date().toISOString(),
    }]);
  }, [portfolio]);

  const handleLoadPosition = useCallback((item) => {
    if (item.type === 'portfolio') {
      // Load portfolio
      setPortfolio(item.positions);
      // Load first position into values for display
      if (item.positions.length > 0) {
        const firstPos = item.positions[0];
        setValues({
          stockPrice: firstPos.stockPrice || values.stockPrice,
          strikePrice: firstPos.strikePrice,
          premium: firstPos.premium,
          optionType: firstPos.optionType,
          expirationDate: firstPos.expirationDate,
          iv: firstPos.iv || 30,
          riskFreeRate: firstPos.riskFreeRate || 5,
        });
      }
    } else {
      // Load single position
      const { savedAt, type, ...positionValues } = item;
      setValues(positionValues);
      setPortfolio([]);
    }
  }, [values.stockPrice]);

  const handleDeletePosition = useCallback((index) => {
    setSavedPositions((prev) => prev.filter((_, i) => i !== index));
    setCompareList((prev) => prev.filter((i) => i !== index).map((i) => i > index ? i - 1 : i));
  }, []);

  const handleToggleCompare = useCallback((index) => {
    setCompareList((prev) => {
      if (prev.includes(index)) {
        return prev.filter((i) => i !== index);
      } else if (prev.length < 4) {
        return [...prev, index];
      }
      return prev;
    });
  }, []);

  const handleSelectOption = useCallback((optionData) => {
    setValues((prev) => ({
      ...prev,
      ...optionData,
      iv: Math.round(optionData.iv),
    }));
  }, []);

  const handleSelectPortfolio = useCallback((positions) => {
    setPortfolio(positions);
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
            <div className="flex gap-2">
              {portfolio.length > 1 && (
                <button
                  onClick={handleSavePortfolio}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-medium transition-colors"
                >
                  Save Portfolio ({portfolio.length})
                </button>
              )}
              <button
                onClick={handleSavePosition}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
              >
                Save Position
              </button>
            </div>
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
              onSelectPortfolio={handleSelectPortfolio}
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
              onCompare={handleToggleCompare}
              compareList={compareList}
            />
          </div>

          {/* Right Column - Charts & Summary */}
          <div className="lg:col-span-2 space-y-6">
            <SummaryPanel
              values={values}
              greeks={greeks}
              breakEven={breakEven}
              daysToExpiry={daysToExpiry}
              portfolio={portfolio}
            />
            <PayoffChart
              data={payoffData}
              breakEven={breakEven}
              optionType={values.optionType}
              portfolio={portfolio}
              stockPrice={values.stockPrice}
            />
            <PnLHeatmap
              heatmapData={heatmapData}
              dateIntervals={dateIntervals}
              premium={values.premium}
              daysToExpiry={daysToExpiry}
              portfolio={portfolio}
              stockPrice={values.stockPrice}
              optionType={values.optionType}
              strikePrice={values.strikePrice}
            />
            <CompareChart
              positions={compareList.map((idx) => savedPositions[idx]).filter(Boolean)}
              currentPosition={values}
              stockPrice={values.stockPrice}
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

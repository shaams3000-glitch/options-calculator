import React, { useState, useEffect, useCallback } from 'react';
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
  calculateStrategyPnL,
  calculateStrategyGreeks,
  generateStrategyPayoffData,
  generateMultiDatePayoffData,
  calculateStrategyMetrics,
  STRATEGY_TEMPLATES,
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
function TickerSearch({ onSelectOption, onStockPriceUpdate, onLoadPortfolio, onSavePortfolio }) {
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [optionsData, setOptionsData] = useState(null);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [optionType, setOptionType] = useState('calls');
  const [selectedOptions, setSelectedOptions] = useState([]); // Array of selected options with qty
  const [quantities, setQuantities] = useState({}); // contractSymbol -> qty mapping

  const handleSearch = async () => {
    if (!ticker.trim()) return;

    setLoading(true);
    setError('');
    setOptionsData(null);
    setSelectedOptions([]);
    setQuantities({});

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

  const handleToggleOption = (option, isChecked) => {
    const formatted = formatOptionData(option);
    const qty = quantities[option.contractSymbol] || 1;

    if (isChecked) {
      // Add to selected
      setSelectedOptions(prev => [...prev, {
        contractSymbol: option.contractSymbol,
        ticker: optionsData?.underlyingSymbol || ticker,
        stockPrice: optionsData?.underlyingPrice,
        strikePrice: formatted.strike,
        premium: getMidPrice(option),
        iv: formatted.impliedVolatility,
        expirationDate: unixToDate(option.expiration),
        optionType: optionType === 'calls' ? 'call' : 'put',
        qty,
        costPer100: getMidPrice(option) * 100,
      }]);
    } else {
      // Remove from selected
      setSelectedOptions(prev => prev.filter(o => o.contractSymbol !== option.contractSymbol));
    }
  };

  const handleQtyChange = (contractSymbol, qty) => {
    const newQty = Math.max(1, parseInt(qty) || 1);
    setQuantities(prev => ({ ...prev, [contractSymbol]: newQty }));

    // Update selected options if this one is selected
    setSelectedOptions(prev => prev.map(o =>
      o.contractSymbol === contractSymbol ? { ...o, qty: newQty } : o
    ));
  };

  const isOptionSelected = (contractSymbol) => {
    return selectedOptions.some(o => o.contractSymbol === contractSymbol);
  };

  const handleLoadPortfolio = () => {
    if (selectedOptions.length === 0) return;
    onLoadPortfolio(selectedOptions, optionsData?.underlyingSymbol || ticker);
  };

  const handleSavePortfolio = () => {
    if (selectedOptions.length === 0) return;
    onSavePortfolio(selectedOptions, optionsData?.underlyingSymbol || ticker);
  };

  const totalCost = selectedOptions.reduce((sum, o) => sum + (o.premium * 100 * o.qty), 0);

  const options = optionType === 'calls'
    ? optionsData?.options?.calls || []
    : optionsData?.options?.puts || [];

  // Find the strike closest to current price
  const currentPrice = optionsData?.underlyingPrice || 0;

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
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-neutral-900 z-10">
                <tr className="text-neutral-400">
                  <th className="p-2 text-center w-10">Select</th>
                  <th className="p-2 text-center w-16">Qty</th>
                  <th className="p-2 text-left">Strike</th>
                  <th className="p-2 text-right">Last</th>
                  <th className="p-2 text-right">Bid</th>
                  <th className="p-2 text-right">Ask</th>
                  <th className="p-2 text-right">IV</th>
                </tr>
              </thead>
              <tbody>
                {options.map((opt, idx) => {
                  const formatted = formatOptionData(opt);
                  const isITM = formatted.inTheMoney;
                  const isSelected = isOptionSelected(opt.contractSymbol);

                  // Check if we need to show current price divider after this row
                  const nextOpt = options[idx + 1];
                  const nextFormatted = nextOpt ? formatOptionData(nextOpt) : null;
                  const showPriceDivider = nextFormatted && isITM && !nextFormatted.inTheMoney;

                  return (
                    <React.Fragment key={opt.contractSymbol}>
                      <tr
                        className={`border-t border-neutral-800 hover:bg-neutral-900/50 ${
                          isSelected ? 'bg-green-900/30 border-l-2 border-l-green-500' : ''
                        } ${isITM ? 'bg-blue-900/20' : ''}`}
                      >
                        <td className="p-2 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => handleToggleOption(opt, e.target.checked)}
                            className="w-4 h-4 accent-green-500 cursor-pointer"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            min="1"
                            value={quantities[opt.contractSymbol] || 1}
                            onChange={(e) => handleQtyChange(opt.contractSymbol, e.target.value)}
                            className="w-14 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-white text-center"
                          />
                        </td>
                        <td className="p-2 font-medium text-white">
                          ${formatted.strike}
                          {isITM && <span className="ml-1 text-xs text-blue-400">ITM</span>}
                        </td>
                        <td className="p-2 text-right text-neutral-300">
                          {formatted.lastPrice > 0 ? `$${formatted.lastPrice.toFixed(2)}` : <span className="text-neutral-500">-</span>}
                        </td>
                        <td className="p-2 text-right text-neutral-300">
                          {formatted.bid > 0 ? `$${formatted.bid.toFixed(2)}` : <span className="text-neutral-500">-</span>}
                        </td>
                        <td className="p-2 text-right text-neutral-300">
                          {formatted.ask > 0 ? `$${formatted.ask.toFixed(2)}` : <span className="text-neutral-500">-</span>}
                        </td>
                        <td className="p-2 text-right text-neutral-300">
                          {formatted.impliedVolatility > 0 ? `${formatted.impliedVolatility.toFixed(1)}%` : <span className="text-neutral-500">-</span>}
                        </td>
                      </tr>
                      {showPriceDivider && (
                        <tr>
                          <td colSpan="7" className="p-0">
                            <div className="flex items-center justify-center py-1 bg-green-600">
                              <span className="text-xs font-medium text-white px-3 py-0.5 rounded">
                                Share price: ${currentPrice.toFixed(2)}
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Selected Options Summary Panel */}
          {selectedOptions.length > 0 && (
            <div className="mt-4 p-3 bg-green-900/20 border border-green-700 rounded-lg">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-green-400">
                  Selected: {selectedOptions.length} option{selectedOptions.length > 1 ? 's' : ''}
                </span>
                <span className="text-sm font-bold text-white">
                  Total Cost: ${totalCost.toFixed(2)}
                </span>
              </div>
              <div className="max-h-24 overflow-y-auto mb-3">
                {selectedOptions.map((opt, idx) => (
                  <div key={idx} className="flex justify-between text-xs text-neutral-300 py-1 border-b border-neutral-800">
                    <span>{opt.qty}x ${opt.strikePrice} {opt.optionType} ({opt.expirationDate})</span>
                    <span>${(opt.premium * 100 * opt.qty).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleLoadPortfolio}
                  className="flex-1 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
                >
                  Load to Calculator
                </button>
                <button
                  onClick={handleSavePortfolio}
                  className="flex-1 px-3 py-2 text-sm bg-purple-600 hover:bg-purple-700 rounded-lg font-medium transition-colors"
                >
                  Save Portfolio
                </button>
              </div>
            </div>
          )}

          <p className="text-xs text-neutral-500 mt-3">
            Data from Yahoo Finance (15-20 min delay). <span className="text-neutral-500">-</span> = no trading data. <span className="text-green-400">Green bar</span> = current share price.
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

// Strategy Builder Component - Build multi-leg strategies with real options data
function StrategyBuilder({ onLoadStrategy, onStockPriceUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const [step, setStep] = useState(0); // 0: select strategy, 1: configure, 2: preview
  const [selectedStrategy, setSelectedStrategy] = useState(null);
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [optionsData, setOptionsData] = useState(null);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [baseStrike, setBaseStrike] = useState(0);
  const [strikeWidth, setStrikeWidth] = useState(5);
  const [builtLegs, setBuiltLegs] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [maxBudget, setMaxBudget] = useState('');
  const [maxRisk, setMaxRisk] = useState('');
  const [hoveredStrategy, setHoveredStrategy] = useState(null);

  const strategyIcons = {
    longCall: '📈', longPut: '📉', coveredCall: '💰',
    bullCallSpread: '🐂', bearPutSpread: '🐻', bullPutSpread: '🟢', bearCallSpread: '🔴',
    straddle: '↕️', strangle: '🔀', ironCondor: '🦅', ironButterfly: '🦋',
    callButterfly: '🦋', putButterfly: '🦋', calendarSpread: '📅', diagonalSpread: '📐'
  };

  const getTypeColor = (type) => {
    switch (type) {
      case 'bullish': return 'text-green-400 bg-green-900/20 border-green-700';
      case 'bearish': return 'text-red-400 bg-red-900/20 border-red-700';
      case 'neutral': return 'text-yellow-400 bg-yellow-900/20 border-yellow-700';
      default: return 'text-neutral-400 bg-neutral-900/20 border-neutral-700';
    }
  };

  const handleSelectStrategy = (key, strategy) => {
    setSelectedStrategy({ key, ...strategy });
    setStep(1);
    setBuiltLegs([]);
    setMetrics(null);
  };

  const handleFetchOptions = async () => {
    if (!ticker) return;
    setLoading(true);
    setError('');
    try {
      const data = await fetchOptionsChain(ticker);
      setOptionsData(data);
      onStockPriceUpdate(data.underlyingPrice);
      if (data.expirationDates.length > 0) {
        setSelectedExpiry(data.expirationDates[0]);
      }
      // Set base strike to ATM
      const atmStrike = data.strikes?.reduce((prev, curr) =>
        Math.abs(curr - data.underlyingPrice) < Math.abs(prev - data.underlyingPrice) ? curr : prev
      , data.strikes?.[0] || data.underlyingPrice);
      setBaseStrike(atmStrike || Math.round(data.underlyingPrice));
    } catch (err) {
      setError(err.message || 'Failed to fetch options');
    } finally {
      setLoading(false);
    }
  };

  const findOptionByStrike = (strike, optionType, options) => {
    const chain = optionType === 'call' ? options?.calls : options?.puts;
    if (!chain) return null;
    // Find closest strike
    return chain.reduce((prev, curr) =>
      Math.abs(curr.strike - strike) < Math.abs(prev.strike - strike) ? curr : prev
    , chain[0]);
  };

  const handleBuildStrategy = async () => {
    if (!selectedStrategy || !optionsData) return;
    setLoading(true);
    setError('');

    try {
      // Fetch options for selected expiry
      const data = await fetchOptionsChain(ticker, selectedExpiry);
      const options = data.options;

      // Build legs from template
      const templateLegs = selectedStrategy.buildLegs(baseStrike);
      const legs = [];

      for (const tLeg of templateLegs) {
        const targetStrike = baseStrike + (tLeg.strikeOffset * (strikeWidth / 5));
        const option = findOptionByStrike(targetStrike, tLeg.optionType, options);

        if (!option) {
          throw new Error(`Could not find ${tLeg.optionType} at strike ~$${targetStrike}`);
        }

        const premium = getMidPrice(option);
        legs.push({
          optionType: tLeg.optionType,
          action: tLeg.action,
          strike: option.strike,
          premium,
          qty: tLeg.qty || 1,
          expiration: unixToDate(option.expiration),
          iv: (option.impliedVolatility || 0.3),
          ticker: ticker.toUpperCase(),
          stockPrice: data.underlyingPrice,
        });
      }

      setBuiltLegs(legs);

      // Calculate metrics
      const strategyMetrics = calculateStrategyMetrics(legs, data.underlyingPrice);
      setMetrics(strategyMetrics);
      setStep(2);
    } catch (err) {
      setError(err.message || 'Failed to build strategy');
    } finally {
      setLoading(false);
    }
  };

  const handleLoadToCalculator = () => {
    if (builtLegs.length === 0) return;

    // Convert legs to portfolio format
    const portfolioPositions = builtLegs.map(leg => ({
      ticker: leg.ticker,
      stockPrice: leg.stockPrice,
      strikePrice: leg.strike,
      premium: leg.premium,
      optionType: leg.optionType,
      action: leg.action,
      expirationDate: leg.expiration,
      iv: leg.iv * 100,
      qty: leg.qty,
      costPer100: leg.action === 'buy' ? leg.premium * 100 : -leg.premium * 100,
    }));

    onLoadStrategy(portfolioPositions, ticker.toUpperCase());
    setExpanded(false);
    setStep(0);
  };

  const resetBuilder = () => {
    setStep(0);
    setSelectedStrategy(null);
    setBuiltLegs([]);
    setMetrics(null);
    setError('');
  };

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex justify-between items-center"
      >
        <h2 className="text-xl font-semibold text-white">Strategy Builder</h2>
        <span className="text-neutral-400">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="mt-4">
          {loading && (
            <div className="text-center py-4 text-neutral-400">Loading...</div>
          )}

          {error && (
            <div className="text-red-400 text-sm mb-4 p-2 bg-red-900/20 rounded">{error}</div>
          )}

          {/* Step 0: Select Strategy */}
          {step === 0 && !loading && (
            <div className="space-y-3">
              <p className="text-sm text-neutral-400 mb-4">
                Click a strategy to see details. Click "Use This" to build it:
              </p>

              <div className="grid grid-cols-2 gap-2">
                {Object.entries(STRATEGY_TEMPLATES).map(([key, strategy]) => {
                  const isExpanded = hoveredStrategy?.key === key;
                  return (
                    <div key={key} className="relative">
                      <button
                        onClick={() => setHoveredStrategy(isExpanded ? null : { key, ...strategy })}
                        className={`w-full p-3 rounded-lg border text-left transition-all hover:opacity-80 ${getTypeColor(strategy.type)} ${isExpanded ? 'ring-2 ring-white' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{strategyIcons[key] || '📊'}</span>
                          <div className="flex-1">
                            <div className="font-medium text-sm">{strategy.name}</div>
                            <div className="text-xs opacity-70">{strategy.legs} leg{strategy.legs > 1 ? 's' : ''}</div>
                          </div>
                          <span className="text-xs opacity-50">{isExpanded ? '▼' : '▶'}</span>
                        </div>
                      </button>

                      {/* Expanded details */}
                      {isExpanded && (
                        <div className="mt-2 p-4 bg-neutral-900 border border-neutral-700 rounded-lg">
                          <div className="flex items-center gap-2 mb-3 flex-wrap">
                            <span className={`text-xs px-2 py-0.5 rounded ${
                              strategy.type === 'bullish' ? 'bg-green-900/50 text-green-400' :
                              strategy.type === 'bearish' ? 'bg-red-900/50 text-red-400' :
                              'bg-yellow-900/50 text-yellow-400'
                            }`}>{strategy.type}</span>
                            {strategy.riskLevel && (
                              <span className={`text-xs px-2 py-0.5 rounded ${
                                strategy.riskLevel === 'Low' ? 'bg-blue-900/50 text-blue-400' :
                                strategy.riskLevel === 'Low-Medium' ? 'bg-cyan-900/50 text-cyan-400' :
                                strategy.riskLevel === 'Medium' ? 'bg-purple-900/50 text-purple-400' :
                                'bg-orange-900/50 text-orange-400'
                              }`}>Risk: {strategy.riskLevel}</span>
                            )}
                          </div>

                          <div className="space-y-3 text-sm">
                            <div>
                              <div className="text-neutral-500 text-xs uppercase tracking-wide mb-1">What is it?</div>
                              <p className="text-neutral-300">{strategy.description}</p>
                            </div>

                            {strategy.whenToUse && (
                              <div>
                                <div className="text-neutral-500 text-xs uppercase tracking-wide mb-1">When to use</div>
                                <p className="text-neutral-300">{strategy.whenToUse}</p>
                              </div>
                            )}

                            {strategy.example && (
                              <div>
                                <div className="text-neutral-500 text-xs uppercase tracking-wide mb-1">Example</div>
                                <p className="text-blue-300 bg-blue-900/20 p-2 rounded text-xs">{strategy.example}</p>
                              </div>
                            )}

                            <div className="flex gap-4 pt-2 border-t border-neutral-700">
                              <span className="text-xs">Max Profit: <span className="text-green-400 font-medium">{strategy.maxProfit}</span></span>
                              <span className="text-xs">Max Loss: <span className="text-red-400 font-medium">{strategy.maxLoss}</span></span>
                            </div>

                            <button
                              onClick={() => handleSelectStrategy(key, strategy)}
                              className="w-full mt-2 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium text-sm"
                            >
                              Use This Strategy
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 1: Configure */}
          {step === 1 && !loading && selectedStrategy && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-white flex items-center gap-2">
                  <span>{strategyIcons[selectedStrategy.key]}</span>
                  {selectedStrategy.name}
                </h3>
                <button onClick={resetBuilder} className="text-sm text-neutral-400 hover:text-white">
                  ← Back
                </button>
              </div>

              <p className="text-sm text-neutral-400">{selectedStrategy.description}</p>

              {/* Ticker Input */}
              <div>
                <label className="block text-sm text-neutral-400 mb-1">Stock Ticker</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={ticker}
                    onChange={(e) => setTicker(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && handleFetchOptions()}
                    placeholder="e.g., AAPL, SPY"
                    className="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white"
                  />
                  <button
                    onClick={handleFetchOptions}
                    disabled={!ticker}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-700 rounded-lg"
                  >
                    Load
                  </button>
                </div>
              </div>

              {/* Budget & Risk Inputs */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-neutral-400 mb-1">
                    Max Budget
                    <span className="ml-1 text-neutral-500 cursor-help" title="Maximum amount you're willing to spend on this position (optional)">?</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span>
                    <input
                      type="number"
                      value={maxBudget}
                      onChange={(e) => setMaxBudget(e.target.value)}
                      placeholder="e.g., 500"
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg pl-7 pr-3 py-2 text-white"
                      min="0"
                      step="100"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-neutral-400 mb-1">
                    Max Risk
                    <span className="ml-1 text-neutral-500 cursor-help" title="Maximum loss you're willing to accept on this position (optional)">?</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span>
                    <input
                      type="number"
                      value={maxRisk}
                      onChange={(e) => setMaxRisk(e.target.value)}
                      placeholder="e.g., 200"
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg pl-7 pr-3 py-2 text-white"
                      min="0"
                      step="100"
                    />
                  </div>
                </div>
              </div>
              <p className="text-xs text-neutral-500">Optional: Set limits to see warnings if strategy exceeds your budget or risk tolerance.</p>

              {optionsData && (
                <>
                  <div className="p-3 bg-neutral-900 rounded-lg">
                    <div className="flex justify-between text-sm">
                      <span className="text-neutral-400">{optionsData.underlyingSymbol}</span>
                      <span className="text-green-400 font-medium">${optionsData.underlyingPrice?.toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Expiry Selection */}
                  <div>
                    <label className="block text-sm text-neutral-400 mb-1">Expiration</label>
                    <select
                      value={selectedExpiry}
                      onChange={(e) => setSelectedExpiry(parseInt(e.target.value))}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white"
                    >
                      {optionsData.expirationDates.map((exp) => (
                        <option key={exp} value={exp}>{unixToDate(exp)}</option>
                      ))}
                    </select>
                  </div>

                  {/* Strike Configuration */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm text-neutral-400 mb-1">Center Strike</label>
                      <input
                        type="number"
                        value={baseStrike}
                        onChange={(e) => setBaseStrike(parseFloat(e.target.value) || 0)}
                        className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white"
                        step="1"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-neutral-400 mb-1">Strike Width</label>
                      <select
                        value={strikeWidth}
                        onChange={(e) => setStrikeWidth(parseInt(e.target.value))}
                        className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white"
                      >
                        <option value={1}>$1</option>
                        <option value={2.5}>$2.50</option>
                        <option value={5}>$5</option>
                        <option value={10}>$10</option>
                      </select>
                    </div>
                  </div>

                  <button
                    onClick={handleBuildStrategy}
                    className="w-full py-2 bg-green-600 hover:bg-green-700 rounded-lg font-medium"
                  >
                    Build Strategy
                  </button>
                </>
              )}
            </div>
          )}

          {/* Step 2: Preview */}
          {step === 2 && !loading && builtLegs.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-white flex items-center gap-2">
                  <span>{strategyIcons[selectedStrategy.key]}</span>
                  {selectedStrategy.name} Preview
                </h3>
                <button onClick={() => setStep(1)} className="text-sm text-neutral-400 hover:text-white">
                  ← Modify
                </button>
              </div>

              {/* Legs Display */}
              <div className="space-y-2">
                {builtLegs.map((leg, idx) => (
                  <div key={idx} className={`p-3 rounded-lg border ${leg.action === 'buy' ? 'border-green-700 bg-green-900/20' : 'border-red-700 bg-red-900/20'}`}>
                    <div className="flex justify-between items-center">
                      <div>
                        <span className={`font-medium ${leg.action === 'buy' ? 'text-green-400' : 'text-red-400'}`}>
                          {leg.action.toUpperCase()}
                        </span>
                        <span className="text-white ml-2">{leg.qty}x ${leg.strike} {leg.optionType.toUpperCase()}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-neutral-300">${leg.premium.toFixed(2)}</span>
                        <span className="text-neutral-500 text-xs ml-2">({(leg.iv * 100).toFixed(0)}% IV)</span>
                      </div>
                    </div>
                    <div className="text-xs text-neutral-500 mt-1">Exp: {leg.expiration}</div>
                  </div>
                ))}
              </div>

              {/* Metrics */}
              {metrics && (
                <div className="p-4 bg-neutral-900 rounded-lg border border-neutral-700">
                  <h4 className="text-sm font-medium text-neutral-400 mb-3">Strategy Metrics</h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-neutral-500">Max Profit</div>
                      <div className="text-green-400 font-medium">
                        {metrics.maxProfit === Infinity ? 'Unlimited' : `$${metrics.maxProfit.toFixed(0)}`}
                      </div>
                    </div>
                    <div>
                      <div className="text-neutral-500">Max Loss</div>
                      <div className="text-red-400 font-medium">
                        {metrics.maxLoss === -Infinity ? 'Unlimited' : `$${Math.abs(metrics.maxLoss).toFixed(0)}`}
                      </div>
                    </div>
                    <div>
                      <div className="text-neutral-500">Net {metrics.isCredit ? 'Credit' : 'Debit'}</div>
                      <div className={`font-medium ${metrics.isCredit ? 'text-green-400' : 'text-red-400'}`}>
                        ${Math.abs(metrics.netPremium).toFixed(0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-neutral-500">Breakeven{metrics.breakevens.length > 1 ? 's' : ''}</div>
                      <div className="text-yellow-400 font-medium">
                        {metrics.breakevens.length > 0 ? metrics.breakevens.map(b => `$${b}`).join(', ') : 'N/A'}
                      </div>
                    </div>
                  </div>

                  {/* Budget/Risk Warnings */}
                  {(maxBudget || maxRisk) && (
                    <div className="mt-3 pt-3 border-t border-neutral-700 space-y-2">
                      {maxBudget && !metrics.isCredit && Math.abs(metrics.netPremium) > parseFloat(maxBudget) && (
                        <div className="flex items-center gap-2 text-yellow-400 text-sm">
                          <span>⚠️</span>
                          <span>Cost (${Math.abs(metrics.netPremium).toFixed(0)}) exceeds your ${parseFloat(maxBudget).toFixed(0)} budget</span>
                        </div>
                      )}
                      {maxBudget && !metrics.isCredit && Math.abs(metrics.netPremium) <= parseFloat(maxBudget) && (
                        <div className="flex items-center gap-2 text-green-400 text-sm">
                          <span>✓</span>
                          <span>Within your ${parseFloat(maxBudget).toFixed(0)} budget</span>
                        </div>
                      )}
                      {maxRisk && metrics.maxLoss !== -Infinity && Math.abs(metrics.maxLoss) > parseFloat(maxRisk) && (
                        <div className="flex items-center gap-2 text-yellow-400 text-sm">
                          <span>⚠️</span>
                          <span>Max loss (${Math.abs(metrics.maxLoss).toFixed(0)}) exceeds your ${parseFloat(maxRisk).toFixed(0)} risk limit</span>
                        </div>
                      )}
                      {maxRisk && metrics.maxLoss !== -Infinity && Math.abs(metrics.maxLoss) <= parseFloat(maxRisk) && (
                        <div className="flex items-center gap-2 text-green-400 text-sm">
                          <span>✓</span>
                          <span>Risk within your ${parseFloat(maxRisk).toFixed(0)} limit</span>
                        </div>
                      )}
                      {maxRisk && metrics.maxLoss === -Infinity && (
                        <div className="flex items-center gap-2 text-red-400 text-sm">
                          <span>⚠️</span>
                          <span>Warning: This strategy has unlimited downside risk</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={resetBuilder}
                  className="flex-1 py-2 bg-neutral-700 hover:bg-neutral-600 rounded-lg font-medium"
                >
                  Start Over
                </button>
                <button
                  onClick={handleLoadToCalculator}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium"
                >
                  Load to Calculator
                </button>
              </div>
            </div>
          )}
        </div>
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

// Multi-Date Risk Graph Component
function RiskGraph({ portfolio, stockPrice, daysToExpiry, optionType, strikePrice, premium, ticker }) {
  const [showGraph, setShowGraph] = useState(true);
  const [selectedDates, setSelectedDates] = useState([0, Math.floor(daysToExpiry / 2), daysToExpiry]);
  const [ivAdjustment, setIvAdjustment] = useState(0); // -50 to +50 percent
  const [priceRangePercent, setPriceRangePercent] = useState(25); // Default 25% range
  const [customMinPrice, setCustomMinPrice] = useState('');
  const [customMaxPrice, setCustomMaxPrice] = useState('');
  const [useCustomRange, setUseCustomRange] = useState(false);

  const hasPortfolio = portfolio && portfolio.length > 0;

  // Get ticker from portfolio if not passed directly
  const displayTicker = ticker || (hasPortfolio ? portfolio[0]?.ticker : null);

  if (!stockPrice || daysToExpiry <= 0) return null;

  // Generate date options
  const dateOptions = [];
  for (let d = 0; d <= daysToExpiry; d += Math.max(1, Math.floor(daysToExpiry / 10))) {
    dateOptions.push(d);
  }
  if (!dateOptions.includes(daysToExpiry)) {
    dateOptions.push(daysToExpiry);
  }

  // Calculate P&L for a given price and days from now
  const calculatePnLAtDate = (price, daysFromNow) => {
    const r = 0.05;

    if (hasPortfolio) {
      let totalPnL = 0;
      for (const pos of portfolio) {
        const qty = pos.qty || 1;
        const posExpDays = daysBetween(new Date(), new Date(pos.expirationDate));
        const daysRemaining = posExpDays - daysFromNow;
        const baseIV = (pos.iv || 30) / 100;
        const adjustedIV = baseIV * (1 + ivAdjustment / 100);

        let optionValue;
        if (daysRemaining <= 0) {
          optionValue = pos.optionType === 'call'
            ? Math.max(0, price - pos.strikePrice)
            : Math.max(0, pos.strikePrice - price);
        } else {
          const T = daysRemaining / 365;
          optionValue = calculateOptionPrice(price, pos.strikePrice, T, r, adjustedIV, pos.optionType);
        }

        // Account for buy/sell direction
        const direction = pos.action === 'sell' ? -1 : 1;
        totalPnL += direction * (optionValue - pos.premium) * 100 * qty;
      }
      return totalPnL;
    } else {
      // Single option
      const daysRemaining = daysToExpiry - daysFromNow;
      const baseIV = 0.30;
      const adjustedIV = baseIV * (1 + ivAdjustment / 100);

      let optionValue;
      if (daysRemaining <= 0) {
        optionValue = optionType === 'call'
          ? Math.max(0, price - strikePrice)
          : Math.max(0, strikePrice - price);
      } else {
        const T = daysRemaining / 365;
        optionValue = calculateOptionPrice(price, strikePrice, T, r, adjustedIV, optionType);
      }
      return (optionValue - premium) * 100;
    }
  };

  // Generate chart data with multiple date lines
  const generateMultiDateData = () => {
    let minPrice, maxPrice;

    if (useCustomRange && customMinPrice && customMaxPrice) {
      minPrice = Math.max(1, parseFloat(customMinPrice));
      maxPrice = parseFloat(customMaxPrice);
    } else {
      // Calculate center price based on portfolio strikes or current stock price
      let centerPrice = stockPrice;
      let strikeMin = stockPrice;
      let strikeMax = stockPrice;

      if (hasPortfolio && portfolio.length > 0) {
        const strikes = portfolio.map(p => p.strikePrice).filter(Boolean);
        if (strikes.length > 0) {
          strikeMin = Math.min(...strikes);
          strikeMax = Math.max(...strikes);
          centerPrice = (strikeMin + strikeMax) / 2;
        }
      } else if (strikePrice) {
        centerPrice = strikePrice;
        strikeMin = strikePrice;
        strikeMax = strikePrice;
      }

      // Use the larger of: percentage range from center, or range that covers all strikes + buffer
      const priceRange = priceRangePercent / 100;
      const percentMin = centerPrice * (1 - priceRange);
      const percentMax = centerPrice * (1 + priceRange);

      // Add 15% buffer around strike range
      const strikeBuffer = (strikeMax - strikeMin) * 0.15 + centerPrice * 0.1;
      const strikeRangeMin = strikeMin - strikeBuffer;
      const strikeRangeMax = strikeMax + strikeBuffer;

      minPrice = Math.max(1, Math.min(percentMin, strikeRangeMin));
      maxPrice = Math.max(percentMax, strikeRangeMax);
    }

    const step = (maxPrice - minPrice) / 50;

    const chartData = [];
    for (let price = minPrice; price <= maxPrice; price += step) {
      const row = { stockPrice: parseFloat(price.toFixed(2)) };
      for (const day of selectedDates) {
        row[`day${day}`] = parseFloat(calculatePnLAtDate(price, day).toFixed(2));
      }
      chartData.push(row);
    }
    return chartData;
  };

  const chartData = generateMultiDateData();

  const colors = ['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6'];

  const toggleDate = (day) => {
    if (selectedDates.includes(day)) {
      if (selectedDates.length > 1) {
        setSelectedDates(selectedDates.filter(d => d !== day));
      }
    } else if (selectedDates.length < 5) {
      setSelectedDates([...selectedDates, day].sort((a, b) => a - b));
    }
  };

  const getDateLabel = (day) => {
    if (day === 0) return 'Today';
    if (day === daysToExpiry) return 'Expiry';
    return `+${day}d`;
  };

  return (
    <div className="bg-black/50 rounded-xl p-6 border border-neutral-800">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-white">Risk Graph</h2>
          {displayTicker && (
            <span className="px-2 py-1 bg-blue-600 text-white text-sm font-medium rounded">{displayTicker}</span>
          )}
          <span className="text-neutral-500 text-sm">${stockPrice?.toFixed(2)}</span>
        </div>
        <button
          onClick={() => setShowGraph(!showGraph)}
          className="text-sm text-neutral-400 hover:text-white"
        >
          {showGraph ? 'Hide' : 'Show'}
        </button>
      </div>

      {showGraph && (
        <>
          {/* Date Selection */}
          <div className="mb-4">
            <div className="text-xs text-neutral-400 mb-2">Select dates to display (up to 5):</div>
            <div className="flex flex-wrap gap-2">
              {dateOptions.map((day) => (
                <button
                  key={day}
                  onClick={() => toggleDate(day)}
                  className={`px-3 py-1 text-xs rounded-lg transition-all ${
                    selectedDates.includes(day)
                      ? 'bg-blue-600 text-white'
                      : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                  }`}
                >
                  {getDateLabel(day)}
                </button>
              ))}
            </div>
          </div>

          {/* Price Range Controls */}
          <div className="mb-4 p-3 bg-neutral-900/50 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-neutral-400">Price Range:</span>
              <button
                onClick={() => setUseCustomRange(!useCustomRange)}
                className={`text-xs px-2 py-1 rounded ${useCustomRange ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
              >
                {useCustomRange ? 'Custom' : 'Percentage'}
              </button>
            </div>

            {!useCustomRange ? (
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="10"
                  max="50"
                  value={priceRangePercent}
                  onChange={(e) => setPriceRangePercent(parseInt(e.target.value))}
                  className="flex-1 h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <span className="text-sm text-neutral-300 w-12">±{priceRangePercent}%</span>
                <span className="text-xs text-neutral-500">
                  (${(stockPrice * (1 - priceRangePercent/100)).toFixed(0)} - ${(stockPrice * (1 + priceRangePercent/100)).toFixed(0)})
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-neutral-500">Min:</span>
                  <input
                    type="number"
                    value={customMinPrice}
                    onChange={(e) => setCustomMinPrice(e.target.value)}
                    placeholder={`${(stockPrice * 0.75).toFixed(0)}`}
                    className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm text-white"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-neutral-500">Max:</span>
                  <input
                    type="number"
                    value={customMaxPrice}
                    onChange={(e) => setCustomMaxPrice(e.target.value)}
                    placeholder={`${(stockPrice * 1.25).toFixed(0)}`}
                    className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm text-white"
                  />
                </div>
                <button
                  onClick={() => {
                    setCustomMinPrice((stockPrice * 0.75).toFixed(0));
                    setCustomMaxPrice((stockPrice * 1.25).toFixed(0));
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Reset
                </button>
              </div>
            )}
          </div>

          {/* IV Adjustment Slider */}
          <div className="mb-4 flex items-center gap-4">
            <span className="text-xs text-neutral-400">IV Adjustment:</span>
            <input
              type="range"
              min="-50"
              max="50"
              value={ivAdjustment}
              onChange={(e) => setIvAdjustment(parseInt(e.target.value))}
              className="flex-1 h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <span className={`text-sm font-medium ${ivAdjustment >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {ivAdjustment >= 0 ? '+' : ''}{ivAdjustment}%
            </span>
          </div>

          {/* Chart */}
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="stockPrice"
                stroke="#9CA3AF"
                tickFormatter={(v) => `$${v}`}
              />
              <YAxis
                stroke="#9CA3AF"
                tickFormatter={(v) => `$${v}`}
              />
              <RechartsTooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  // Sort payload by day number (ascending)
                  const sortedPayload = [...payload].sort((a, b) => {
                    const dayA = parseInt(a.dataKey.replace('day', ''));
                    const dayB = parseInt(b.dataKey.replace('day', ''));
                    return dayA - dayB;
                  });
                  return (
                    <div className="bg-neutral-800 border border-neutral-600 rounded-lg p-3">
                      <div className="text-neutral-400 mb-2">Stock: ${label}</div>
                      {sortedPayload.map((entry, idx) => {
                        const day = parseInt(entry.dataKey.replace('day', ''));
                        return (
                          <div key={idx} style={{ color: entry.color }} className="text-sm">
                            {getDateLabel(day)} : ${entry.value.toFixed(2)}
                          </div>
                        );
                      })}
                    </div>
                  );
                }}
              />
              <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="5 5" />
              <ReferenceLine
                x={stockPrice}
                stroke="#9CA3AF"
                strokeDasharray="3 3"
                label={{ value: 'Current', fill: '#9CA3AF', position: 'top' }}
              />
              {selectedDates.map((day, idx) => (
                <Line
                  key={day}
                  type="monotone"
                  dataKey={`day${day}`}
                  stroke={colors[idx % colors.length]}
                  strokeWidth={day === daysToExpiry ? 3 : 2}
                  strokeDasharray={day === 0 ? '5 5' : undefined}
                  dot={false}
                  name={`day${day}`}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>

          {/* Legend */}
          <div className="flex flex-wrap justify-center gap-4 mt-3">
            {selectedDates.map((day, idx) => (
              <div key={day} className="flex items-center gap-2 text-sm">
                <div
                  className="w-4 h-0.5"
                  style={{
                    backgroundColor: colors[idx % colors.length],
                    borderStyle: day === 0 ? 'dashed' : 'solid'
                  }}
                />
                <span className="text-neutral-400">{getDateLabel(day)}</span>
              </div>
            ))}
          </div>

          <p className="text-xs text-neutral-500 mt-3 text-center">
            Shows projected P&L at different dates. Dashed line = Today. Thicker line = Expiration.
            {ivAdjustment !== 0 && ` IV adjusted by ${ivAdjustment}%.`}
          </p>
        </>
      )}
    </div>
  );
}

// P&L Heatmap Component
function PnLHeatmap({ heatmapData, dateIntervals, premium, daysToExpiry, portfolio, stockPrice, optionType, strikePrice }) {
  const [displayMode, setDisplayMode] = useState('dollar'); // 'dollar' or 'percent'
  const [viewMode, setViewMode] = useState('expiry'); // 'expiry' or 'dateRange'
  const [interval, setInterval] = useState(7); // days between columns
  const [rowCount, setRowCount] = useState(17); // number of price rows
  const [priceRangeMode, setPriceRangeMode] = useState('default'); // 'default', 'custom', or preset names
  const [customMinPrice, setCustomMinPrice] = useState('');
  const [customMaxPrice, setCustomMaxPrice] = useState('');

  if (!heatmapData || heatmapData.length === 0) return null;

  // Check if we have a multi-position portfolio
  const hasPortfolio = portfolio && portfolio.length > 1;

  // Calculate strike prices for portfolio or single option
  const allStrikes = hasPortfolio
    ? portfolio.map(p => p.strikePrice)
    : [strikePrice];
  const minStrike = Math.min(...allStrikes);
  const maxStrike = Math.max(...allStrikes);

  // Calculate price range based on mode
  const getPriceRange = () => {
    if (priceRangeMode === 'custom' && customMinPrice && customMaxPrice) {
      return { min: parseFloat(customMinPrice), max: parseFloat(customMaxPrice) };
    }

    const currentPrice = stockPrice || minStrike;

    switch (priceRangeMode) {
      case 'pm10':
        return { min: currentPrice * 0.9, max: currentPrice * 1.1 };
      case 'pm20':
        return { min: currentPrice * 0.8, max: currentPrice * 1.2 };
      case 'pm30':
        return { min: currentPrice * 0.7, max: currentPrice * 1.3 };
      case 'below':
        return { min: minStrike * 0.5, max: minStrike };
      case 'above':
        return { min: maxStrike, max: maxStrike * 1.5 };
      case 'default':
      default:
        // Default: $20 below lowest strike up to 2x highest strike
        return { min: Math.max(1, minStrike - 20), max: maxStrike * 2 };
    }
  };

  const { min: rangeMin, max: rangeMax } = getPriceRange();

  // Generate custom price points based on range and row count
  const generatePricePoints = () => {
    const step = (rangeMax - rangeMin) / (rowCount - 1);
    const points = [];
    for (let i = 0; i < rowCount; i++) {
      points.push(parseFloat((rangeMax - i * step).toFixed(2)));
    }
    return points;
  };

  const customPricePoints = generatePricePoints();

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

  // Check if a price is close to any strike price (within $1)
  const isNearStrike = (price) => {
    return allStrikes.some(strike => Math.abs(price - strike) < 1);
  };

  // Get the closest strike to a price
  const getClosestStrike = (price) => {
    return allStrikes.reduce((closest, strike) =>
      Math.abs(price - strike) < Math.abs(price - closest) ? strike : closest
    , allStrikes[0]);
  };

  // Check if a day matches an expiry date
  const getExpiryIndexForDay = (day) => {
    const idx = portfolioExpiryDays.findIndex(exp => exp.days === day);
    return idx;
  };

  // Generate date intervals for date range view - include ALL expiry dates
  const generateDateRangeIntervals = () => {
    const intervalsSet = new Set([0]); // Start with today

    // Add regular intervals
    for (let d = interval; d < maxDaysToExpiry; d += interval) {
      intervalsSet.add(d);
    }

    // Always include ALL expiry dates
    for (const exp of portfolioExpiryDays) {
      intervalsSet.add(exp.days);
    }

    // Convert to sorted array
    return [...intervalsSet].sort((a, b) => a - b);
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

  // Calculate P&L breakdown by expiry for tooltip
  const calcPnLBreakdownAtDay = (price, daysFromNow) => {
    if (!hasPortfolio) return [];

    const r = 0.05;
    const breakdown = [];

    for (const exp of portfolioExpiryDays) {
      let expiryPnL = 0;
      const positionsForExpiry = portfolio.filter(p => p.expirationDate === exp.date);
      const daysRemaining = exp.days - daysFromNow;
      const isExpired = daysRemaining <= 0;

      for (const pos of positionsForExpiry) {
        const qty = pos.qty || 1;
        let optionValue;

        if (isExpired) {
          optionValue = pos.optionType === 'call'
            ? Math.max(0, price - pos.strikePrice)
            : Math.max(0, pos.strikePrice - price);
        } else {
          const T = daysRemaining / 365;
          const posIV = (pos.iv || 30) / 100;
          optionValue = calculateOptionPrice(price, pos.strikePrice, T, r, posIV, pos.optionType);
        }

        expiryPnL += (optionValue - pos.premium) * 100 * qty;
      }

      breakdown.push({
        expiry: exp.date,
        expiryIdx: portfolioExpiryDays.indexOf(exp),
        pnl: expiryPnL,
        isExpired,
        daysRemaining,
        positionCount: positionsForExpiry.length
      });
    }

    return breakdown;
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
  const colorHex = {
    blue: { text: '#60a5fa', bg: 'rgba(96, 165, 250, 0.1)', border: 'rgba(96, 165, 250, 0.5)' },
    purple: { text: '#c084fc', bg: 'rgba(192, 132, 252, 0.1)', border: 'rgba(192, 132, 252, 0.5)' },
    orange: { text: '#fb923c', bg: 'rgba(251, 146, 60, 0.1)', border: 'rgba(251, 146, 60, 0.5)' },
    green: { text: '#4ade80', bg: 'rgba(74, 222, 128, 0.1)', border: 'rgba(74, 222, 128, 0.5)' },
  };
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

      {/* Price Range Controls */}
      <div className="mb-4 p-3 bg-neutral-900/50 rounded-lg border border-neutral-800">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <span className="text-sm text-neutral-400">Price Range:</span>
          <div className="flex flex-wrap gap-1">
            {[
              { key: 'default', label: 'Default' },
              { key: 'pm10', label: '±10%' },
              { key: 'pm20', label: '±20%' },
              { key: 'pm30', label: '±30%' },
              { key: 'below', label: 'Below Strike' },
              { key: 'above', label: 'Above Strike' },
            ].map(preset => (
              <button
                key={preset.key}
                onClick={() => setPriceRangeMode(preset.key)}
                className={`px-2 py-1 text-xs rounded transition-all ${priceRangeMode === preset.key ? 'bg-green-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-neutral-400">Custom:</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              placeholder="Min $"
              value={customMinPrice}
              onChange={(e) => {
                setCustomMinPrice(e.target.value);
                if (e.target.value && customMaxPrice) setPriceRangeMode('custom');
              }}
              className="w-20 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-white placeholder-neutral-500"
            />
            <span className="text-neutral-500">to</span>
            <input
              type="number"
              placeholder="Max $"
              value={customMaxPrice}
              onChange={(e) => {
                setCustomMaxPrice(e.target.value);
                if (customMinPrice && e.target.value) setPriceRangeMode('custom');
              }}
              className="w-20 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-white placeholder-neutral-500"
            />
            <button
              onClick={() => setPriceRangeMode('custom')}
              className={`px-2 py-1 text-xs rounded transition-all ${priceRangeMode === 'custom' ? 'bg-green-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              Apply
            </button>
          </div>
          <span className="text-neutral-500 mx-2">|</span>
          <span className="text-sm text-neutral-400">Rows:</span>
          <div className="flex gap-1">
            {[10, 15, 17, 20, 25, 30].map(count => (
              <button
                key={count}
                onClick={() => setRowCount(count)}
                className={`px-2 py-1 text-xs rounded transition-all ${rowCount === count ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
              >
                {count}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 text-xs text-neutral-500">
          Range: ${rangeMin.toFixed(2)} - ${rangeMax.toFixed(2)} ({customPricePoints.length} rows)
        </div>
      </div>

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
                {customPricePoints.map((price, idx) => {
                  const expiryPnLs = portfolioExpiryDays.map(exp => ({
                    pnl: calcPnLForExpiryDate(price, exp.date),
                    cost: getCostForExpiryDate(exp.date)
                  }));
                  const totalPnL = expiryPnLs.reduce((sum, e) => sum + e.pnl, 0);
                  const totalCost = portfolio.reduce((sum, p) => sum + (p.costPer100 || p.premium * 100) * (p.qty || 1), 0);
                  const nearStrike = isNearStrike(price);

                  return (
                    <tr key={idx} className={nearStrike ? 'border-y-2 border-yellow-500' : ''}>
                      <td className={`p-2 font-medium ${nearStrike ? 'bg-yellow-500/20 text-yellow-300 font-bold' : 'text-neutral-300'}`}>
                        {nearStrike && <span className="mr-1">▶</span>}
                        ${price.toFixed(2)}
                        {nearStrike && <span className="ml-1 text-xs text-yellow-400">(Strike)</span>}
                      </td>
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
          <div className="mt-3 p-3 bg-neutral-900/50 rounded border border-neutral-800">
            <p className="text-xs text-neutral-400 font-medium mb-2">📊 How to read this chart:</p>
            <ul className="text-xs text-neutral-500 space-y-1">
              <li>• <span className="text-blue-400">Expiry columns</span> show P&L for positions expiring <span className="text-white">ONLY on that date</span></li>
              <li>• <span className="text-yellow-400">Total P&L</span> column = sum of all expiry columns (combined portfolio P&L)</li>
              <li>• P&L = (intrinsic value - premium paid) × 100 shares × quantity</li>
              <li>• Intrinsic value: <span className="text-green-400">Call</span> = max(0, stock - strike), <span className="text-red-400">Put</span> = max(0, strike - stock)</li>
            </ul>
          </div>
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
                    const expiryIdx = getExpiryIndexForDay(day);
                    const isExpiry = expiryIdx >= 0;
                    const expiryColorKey = isExpiry ? colorClasses[expiryIdx % colorClasses.length] : null;
                    const colors = expiryColorKey ? colorHex[expiryColorKey] : null;

                    return (
                      <th
                        key={idx}
                        className={`p-2 text-center ${isExpiry ? 'font-bold' : 'text-neutral-400'}`}
                        style={isExpiry ? { color: colors.text, backgroundColor: colors.bg } : {}}
                      >
                        {day === 0 ? 'Today' : `+${day}d`}
                        {isExpiry && <div className="text-xs opacity-70">Exp {expiryIdx + 1}</div>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {customPricePoints.map((price, idx) => {
                  const nearStrike = isNearStrike(price);
                  return (
                    <tr key={idx} className={nearStrike ? 'border-y-2 border-yellow-500' : ''}>
                      <td className={`p-2 font-medium ${nearStrike ? 'bg-yellow-500/20 text-yellow-300 font-bold' : 'text-neutral-300'}`}>
                        {nearStrike && <span className="mr-1">▶</span>}
                        ${price.toFixed(2)}
                        {nearStrike && <span className="ml-1 text-xs text-yellow-400">(Strike)</span>}
                      </td>
                      {dateRangeIntervals.map((day, dayIdx) => {
                        const pnl = calcPortfolioPnLAtDay(price, day);
                        const percentValue = totalPortfolioCost > 0 ? (pnl / totalPortfolioCost) * 100 : 0;
                        const expiryIdx = getExpiryIndexForDay(day);
                        const isExpiry = expiryIdx >= 0;
                        const expiryColorKey = isExpiry ? colorClasses[expiryIdx % colorClasses.length] : null;
                        const colors = expiryColorKey ? colorHex[expiryColorKey] : null;

                        // Build tooltip with breakdown
                        const breakdown = calcPnLBreakdownAtDay(price, day);
                        const tooltipLines = breakdown.map(b => {
                          const status = b.isExpired ? '(expired)' : `(${b.daysRemaining}d left)`;
                          return `Exp ${b.expiryIdx + 1}: $${b.pnl.toFixed(0)} ${status}`;
                        });
                        tooltipLines.push(`─────────`);
                        tooltipLines.push(`Total: $${pnl.toFixed(0)}`);
                        const tooltip = tooltipLines.join('\n');

                        return (
                          <td
                            key={dayIdx}
                            className="p-2 text-center font-medium cursor-help"
                            title={tooltip}
                            style={{
                              backgroundColor: getColor(displayMode === 'percent' ? percentValue : pnl, displayMode === 'percent'),
                              ...(isExpiry ? { borderLeft: `2px solid ${colors.border}`, borderRight: `2px solid ${colors.border}` } : {})
                            }}
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
          <div className="mt-3 p-3 bg-neutral-900/50 rounded border border-neutral-800">
            <p className="text-xs text-neutral-400 font-medium mb-2">📊 How to read this chart:</p>
            <ul className="text-xs text-neutral-500 space-y-1">
              <li>• Each cell shows <span className="text-white">TOTAL portfolio P&L</span> if the stock is at that price on that date</li>
              <li>• <span className="text-blue-400">Colored columns</span> = expiry dates (when positions expire and lock in their P&L)</li>
              <li>• Before expiry: options have <span className="text-green-400">time value</span> (calculated via Black-Scholes)</li>
              <li>• At/after expiry: options have only <span className="text-yellow-400">intrinsic value</span> (stock price - strike)</li>
              <li>• <span className="text-neutral-300">Hover over any cell</span> to see P&L breakdown by expiry date</li>
            </ul>
          </div>
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
function SavedPositions({ positions, onLoad, onDelete, onCompare, compareList, onRename }) {
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [livePrices, setLivePrices] = useState({}); // ticker -> { price, lastUpdated }
  const [refreshing, setRefreshing] = useState(false);
  const [editingIdx, setEditingIdx] = useState(null);
  const [editName, setEditName] = useState('');

  // Get unique tickers from positions
  const tickers = [...new Set(positions
    .filter(p => p.ticker || (p.type === 'portfolio' && p.positions?.length > 0))
    .map(p => p.ticker || p.positions?.[0]?.ticker)
    .filter(Boolean)
  )];

  // Fetch live prices
  const fetchLivePrices = useCallback(async () => {
    if (tickers.length === 0) return;
    setRefreshing(true);

    const newPrices = { ...livePrices };
    for (const ticker of tickers) {
      try {
        const quote = await fetchStockQuote(ticker);
        newPrices[ticker] = {
          price: quote.price,
          lastUpdated: new Date(),
          change: quote.change,
          changePercent: quote.changePercent
        };
      } catch (err) {
        console.error(`Failed to fetch price for ${ticker}:`, err);
      }
    }
    setLivePrices(newPrices);
    setRefreshing(false);
  }, [tickers.join(',')]);

  // Auto-refresh effect
  useEffect(() => {
    if (!autoRefresh || tickers.length === 0) return;

    fetchLivePrices();
    const interval = setInterval(fetchLivePrices, 60000); // Refresh every 60 seconds
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLivePrices]);

  // Calculate live P&L for a position/portfolio
  const calculateLivePnL = (item) => {
    const ticker = item.ticker || item.positions?.[0]?.ticker;
    const liveData = livePrices[ticker];
    if (!liveData) return null;

    const currentPrice = liveData.price;

    if (item.type === 'portfolio') {
      let totalPnL = 0;
      let totalCost = 0;

      for (const pos of item.positions) {
        const qty = pos.qty || 1;
        const daysToExp = daysBetween(new Date(), new Date(pos.expirationDate));
        const T = Math.max(0, daysToExp / 365);
        const iv = (pos.iv || 30) / 100;

        let optionValue;
        if (T <= 0) {
          optionValue = pos.optionType === 'call'
            ? Math.max(0, currentPrice - pos.strikePrice)
            : Math.max(0, pos.strikePrice - currentPrice);
        } else {
          optionValue = calculateOptionPrice(currentPrice, pos.strikePrice, T, 0.05, iv, pos.optionType);
        }

        const direction = pos.action === 'sell' ? -1 : 1;
        totalPnL += direction * (optionValue - pos.premium) * 100 * qty;
        totalCost += Math.abs(pos.premium) * 100 * qty;
      }

      return { pnl: totalPnL, cost: totalCost, pnlPercent: (totalPnL / totalCost) * 100 };
    } else {
      // Single position
      const daysToExp = daysBetween(new Date(), new Date(item.expirationDate));
      const T = Math.max(0, daysToExp / 365);
      const iv = (item.iv || 30) / 100;

      let optionValue;
      if (T <= 0) {
        optionValue = item.optionType === 'call'
          ? Math.max(0, currentPrice - item.strikePrice)
          : Math.max(0, item.strikePrice - currentPrice);
      } else {
        optionValue = calculateOptionPrice(currentPrice, item.strikePrice, T, 0.05, iv, item.optionType);
      }

      const cost = item.premium * 100;
      const pnl = (optionValue - item.premium) * 100;
      return { pnl, cost, pnlPercent: (pnl / cost) * 100 };
    }
  };

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
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-white">Saved Positions & Portfolios</h2>
        <div className="flex items-center gap-2">
          {refreshing && <span className="text-xs text-neutral-500">Updating...</span>}
          <button
            onClick={fetchLivePrices}
            disabled={tickers.length === 0}
            className="px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 rounded text-neutral-300 transition-colors"
            title="Refresh prices"
          >
            ↻
          </button>
          <label className="flex items-center gap-1 text-xs text-neutral-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-blue-500"
            />
            Auto
          </label>
        </div>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {positions.map((item, idx) => {
          const isPortfolio = item.type === 'portfolio';
          const livePnL = calculateLivePnL(item);
          const ticker = item.ticker || item.positions?.[0]?.ticker;
          const liveData = livePrices[ticker];

          if (isPortfolio) {
            // Render portfolio with live P&L
            const isEditing = editingIdx === idx;
            const displayName = item.name || `${ticker || 'Unknown'} Portfolio`;

            return (
              <div key={idx} className="bg-black/70 rounded-lg p-3 border border-purple-500/30">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    {/* Ticker Badge */}
                    <div className="flex items-center gap-2 mb-1">
                      {ticker && (
                        <span className="text-sm font-bold text-white bg-purple-600 px-2 py-0.5 rounded">
                          {ticker}
                        </span>
                      )}
                      <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">
                        {item.positionCount} positions
                      </span>
                    </div>

                    {/* Name - editable */}
                    {isEditing ? (
                      <div className="flex items-center gap-2 mt-1">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              onRename(idx, editName);
                              setEditingIdx(null);
                            } else if (e.key === 'Escape') {
                              setEditingIdx(null);
                            }
                          }}
                          className="flex-1 bg-neutral-800 border border-neutral-600 rounded px-2 py-1 text-sm text-white"
                          autoFocus
                        />
                        <button
                          onClick={() => { onRename(idx, editName); setEditingIdx(null); }}
                          className="text-xs text-green-400 hover:text-green-300"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingIdx(null)}
                          className="text-xs text-neutral-400 hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div
                        className="text-white font-medium cursor-pointer hover:text-purple-300 transition-colors"
                        onClick={() => { setEditingIdx(idx); setEditName(displayName); }}
                        title="Click to rename"
                      >
                        {displayName}
                      </div>
                    )}

                    {/* Cost and P&L */}
                    <div className="text-sm text-neutral-400 mt-1">
                      <span>Cost: ${item.totalCost?.toFixed(0)}</span>
                      {livePnL && (
                        <>
                          <span className="mx-2">•</span>
                          <span className={livePnL.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {livePnL.pnl >= 0 ? '+' : ''}${livePnL.pnl.toFixed(0)} ({livePnL.pnlPercent >= 0 ? '+' : ''}{livePnL.pnlPercent.toFixed(0)}%)
                          </span>
                        </>
                      )}
                    </div>

                    {/* Live stock price */}
                    {liveData && (
                      <div className="text-xs text-neutral-500 mt-1">
                        {ticker}: ${liveData.price.toFixed(2)}
                        <span className={liveData.change >= 0 ? 'text-green-400 ml-1' : 'text-red-400 ml-1'}>
                          ({liveData.change >= 0 ? '+' : ''}{liveData.changePercent?.toFixed(2)}%)
                        </span>
                      </div>
                    )}
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

          // Render single position with live P&L
          return (
            <div key={idx} className={`bg-black/70 rounded-lg p-3 ${isInCompare(idx) ? 'ring-1 ring-purple-500' : ''}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Ticker badge */}
                    {ticker && (
                      <span className="text-sm font-bold text-white bg-blue-600 px-2 py-0.5 rounded">
                        {ticker}
                      </span>
                    )}
                    <span className={`font-medium ${item.optionType === 'call' ? 'text-green-400' : 'text-red-400'}`}>
                      {item.optionType?.toUpperCase()}
                    </span>
                    <span className="text-neutral-300">
                      ${item.strikePrice} @ ${item.premium}
                    </span>
                    <span className="text-neutral-500 text-sm">
                      {item.expirationDate}
                    </span>
                  </div>
                  {livePnL && (
                    <div className="text-sm mt-1">
                      <span className={livePnL.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                        {livePnL.pnl >= 0 ? '+' : ''}${livePnL.pnl.toFixed(2)} ({livePnL.pnlPercent >= 0 ? '+' : ''}{livePnL.pnlPercent.toFixed(0)}%)
                      </span>
                      {liveData && (
                        <span className="text-neutral-500 ml-2 text-xs">
                          Stock: ${liveData.price.toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}
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
            </div>
          );
        })}
      </div>
      {compareList.length > 0 && (
        <p className="text-xs text-purple-400 mt-2">{compareList.length} position(s) selected for comparison</p>
      )}
      {autoRefresh && (
        <p className="text-xs text-neutral-500 mt-2">Auto-refreshing every 60 seconds</p>
      )}

      {/* Export/Import Controls */}
      <div className="flex gap-2 mt-4 pt-4 border-t border-neutral-800">
        <button
          onClick={() => {
            const dataStr = JSON.stringify(positions, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `options-portfolio-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="flex-1 px-3 py-2 text-xs bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 transition-colors"
        >
          Export All
        </button>
        <label className="flex-1">
          <input
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = (event) => {
                try {
                  const imported = JSON.parse(event.target?.result);
                  if (Array.isArray(imported)) {
                    // Merge with existing - add to localStorage
                    const existing = JSON.parse(localStorage.getItem('optionsPositions') || '[]');
                    const merged = [...existing, ...imported];
                    localStorage.setItem('optionsPositions', JSON.stringify(merged));
                    window.location.reload(); // Refresh to load new data
                  }
                } catch (err) {
                  alert('Invalid file format');
                }
              };
              reader.readAsText(file);
            }}
          />
          <span className="block w-full px-3 py-2 text-xs text-center bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 cursor-pointer transition-colors">
            Import
          </span>
        </label>
      </div>
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
    ticker: '',
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
  const [hasLoadedPosition, setHasLoadedPosition] = useState(false);

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
    const ticker = values.ticker ? values.ticker.toUpperCase() : '';
    const optType = values.optionType === 'call' ? 'C' : 'P';
    const strike = values.strikePrice ? `$${values.strikePrice}` : '';
    const name = ticker ? `${ticker} ${strike} ${optType}` : `Position ${strike} ${optType}`;

    setSavedPositions((prev) => [...prev, {
      ...values,
      type: 'position',
      name,
      savedAt: new Date().toISOString()
    }]);
  }, [values]);

  const handleSavePortfolio = useCallback(() => {
    if (portfolio.length === 0) return;

    const totalCost = portfolio.reduce((sum, p) => sum + (p.costPer100 || p.premium * 100) * (p.qty || 1), 0);
    const expiries = [...new Set(portfolio.map(p => p.expirationDate))];
    // Get ticker from first position or current values
    const ticker = portfolio[0]?.ticker || values.ticker || '';

    setSavedPositions((prev) => [...prev, {
      type: 'portfolio',
      ticker,
      name: `${ticker ? ticker.toUpperCase() + ' ' : ''}Portfolio (${portfolio.length} positions)`,
      positions: portfolio,
      totalCost,
      expiries,
      positionCount: portfolio.length,
      savedAt: new Date().toISOString(),
    }]);
  }, [portfolio, values.ticker]);

  const handleLoadPosition = useCallback(async (item) => {
    const ticker = item.ticker || item.positions?.[0]?.ticker;

    // Fetch fresh stock price if we have a ticker
    let currentStockPrice = item.stockPrice || values.stockPrice;
    if (ticker) {
      try {
        const quote = await fetchStockQuote(ticker);
        currentStockPrice = quote.price;
      } catch (err) {
        console.error('Failed to fetch current price:', err);
        // Fall back to saved stock price
        currentStockPrice = item.positions?.[0]?.stockPrice || item.stockPrice || values.stockPrice;
      }
    }

    if (item.type === 'portfolio') {
      // Load portfolio with updated stock price
      const updatedPositions = item.positions.map(pos => ({
        ...pos,
        stockPrice: currentStockPrice,
      }));
      setPortfolio(updatedPositions);

      // Load first position into values for display
      if (item.positions.length > 0) {
        const firstPos = item.positions[0];
        setValues({
          ticker: ticker || '',
          stockPrice: currentStockPrice,
          strikePrice: firstPos.strikePrice,
          premium: firstPos.premium,
          optionType: firstPos.optionType,
          expirationDate: firstPos.expirationDate,
          iv: firstPos.iv || 30,
          riskFreeRate: firstPos.riskFreeRate || 5,
        });
      }
    } else {
      // Load single position - also add to portfolio so charts update
      const { savedAt, type, ...positionValues } = item;
      setValues({
        ...positionValues,
        stockPrice: currentStockPrice,
      });
      // Convert single position to portfolio format for charts
      setPortfolio([{
        ticker: positionValues.ticker || '',
        stockPrice: currentStockPrice,
        strikePrice: positionValues.strikePrice,
        premium: positionValues.premium,
        optionType: positionValues.optionType,
        expirationDate: positionValues.expirationDate,
        iv: positionValues.iv || 30,
        qty: 1,
        action: 'buy',
      }]);
    }
    setHasLoadedPosition(true);
  }, [values.stockPrice]);

  const handleDeletePosition = useCallback((index) => {
    setSavedPositions((prev) => prev.filter((_, i) => i !== index));
    setCompareList((prev) => prev.filter((i) => i !== index).map((i) => i > index ? i - 1 : i));
  }, []);

  const handleRenamePosition = useCallback((index, newName) => {
    setSavedPositions((prev) => prev.map((item, i) =>
      i === index ? { ...item, name: newName } : item
    ));
  }, []);

  // Handle loading portfolio from real options lookup
  const handleLoadPortfolioFromLookup = useCallback((selectedOptions, tickerSymbol) => {
    setPortfolio(selectedOptions);
    setHasLoadedPosition(true);
    if (selectedOptions.length > 0) {
      const firstPos = selectedOptions[0];
      setValues({
        ticker: tickerSymbol,
        stockPrice: firstPos.stockPrice,
        strikePrice: firstPos.strikePrice,
        premium: firstPos.premium,
        optionType: firstPos.optionType,
        expirationDate: firstPos.expirationDate,
        iv: firstPos.iv || 30,
        riskFreeRate: 5,
      });
    }
  }, []);

  // Handle saving portfolio from real options lookup
  const handleSavePortfolioFromLookup = useCallback((selectedOptions, tickerSymbol) => {
    const totalCost = selectedOptions.reduce((sum, p) => sum + (p.costPer100 || p.premium * 100) * (p.qty || 1), 0);
    const expiries = [...new Set(selectedOptions.map(p => p.expirationDate))];

    setSavedPositions((prev) => [...prev, {
      type: 'portfolio',
      ticker: tickerSymbol,
      name: `${tickerSymbol.toUpperCase()} Portfolio (${selectedOptions.length} positions)`,
      positions: selectedOptions,
      totalCost,
      expiries,
      positionCount: selectedOptions.length,
      savedAt: new Date().toISOString(),
    }]);
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
            {hasLoadedPosition && (
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
            )}
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
              onLoadPortfolio={handleLoadPortfolioFromLookup}
              onSavePortfolio={handleSavePortfolioFromLookup}
            />
            <StrategyBuilder
              onLoadStrategy={handleLoadPortfolioFromLookup}
              onStockPriceUpdate={handleStockPriceUpdate}
            />
            <SavedPositions
              positions={savedPositions}
              onLoad={handleLoadPosition}
              onDelete={handleDeletePosition}
              onCompare={handleToggleCompare}
              compareList={compareList}
              onRename={handleRenamePosition}
            />
          </div>

          {/* Right Column - Charts & Summary */}
          <div className="lg:col-span-2 space-y-6">
            {!hasLoadedPosition ? (
              /* Welcome Message - shown when no position is loaded */
              <div className="bg-black/50 rounded-xl p-8 border border-neutral-800 text-center">
                <div className="text-6xl mb-6">📈</div>
                <h2 className="text-2xl font-bold text-white mb-4">Welcome to Options Profit Projection</h2>
                <p className="text-neutral-400 mb-6 max-w-md mx-auto">
                  Get started by looking up real options data or building a strategy. Your P&L projections, risk graphs, and analysis will appear here.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-lg mx-auto">
                  <div className="bg-neutral-900/50 rounded-lg p-4 border border-neutral-700">
                    <div className="text-2xl mb-2">🔍</div>
                    <h3 className="font-medium text-white mb-1">Lookup Real Options</h3>
                    <p className="text-sm text-neutral-500">Search any stock ticker to see live options chains with real prices and IV</p>
                  </div>
                  <div className="bg-neutral-900/50 rounded-lg p-4 border border-neutral-700">
                    <div className="text-2xl mb-2">🛠️</div>
                    <h3 className="font-medium text-white mb-1">Strategy Builder</h3>
                    <p className="text-sm text-neutral-500">Build multi-leg strategies like spreads, straddles, and iron condors</p>
                  </div>
                </div>
                <div className="mt-6 text-sm text-neutral-500">
                  Or load a saved position from the left sidebar
                </div>
              </div>
            ) : (
              /* Charts & Analysis - shown when position is loaded */
              <>
                <SummaryPanel
                  values={values}
                  greeks={greeks}
                  breakEven={breakEven}
                  daysToExpiry={daysToExpiry}
                  portfolio={portfolio}
                />
                <RiskGraph
                  portfolio={portfolio}
                  stockPrice={values.stockPrice}
                  daysToExpiry={daysToExpiry}
                  optionType={values.optionType}
                  strikePrice={values.strikePrice}
                  premium={values.premium}
                  ticker={values.ticker}
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
              </>
            )}
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

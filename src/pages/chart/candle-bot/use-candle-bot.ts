/**
 * useCandleBot — 1-minute candle-trend bot hook
 *
 * Strategy:
 *  1. Subscribe to 1-minute OHLC candles for the selected symbol.
 *  2. When a NEW candle opens, inspect the PREVIOUS (just-closed) candle:
 *       - If previous close > open  → BUY (CALL), duration = 60 s
 *       - If previous close < open  → SELL (PUT),  duration = 60 s
 *       - If doji (close == open)   → skip
 *  3. Contract duration is exactly 1 minute so entry = candle open,
 *     exit = candle close (no mid-candle entries, no delay).
 *  4. On loss → apply Martingale multiplier (up to maxMartingaleSteps),
 *     then reset on win.
 *  5. Stop on cumulative P&L hitting takeProfit or stopLoss.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { generateDerivApiInstance, V2GetActiveToken } from '@/external/bot-skeleton/services/api/appId';
import { CandleBotSettings, CandleBotStatus, CandleData, TradeRecord } from './candle-bot.types';

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const waitForOpen = (ws: WebSocket) =>
    new Promise<void>((res, rej) => {
        if (ws.readyState === WebSocket.OPEN) return res();
        ws.addEventListener('open', () => res(), { once: true });
        ws.addEventListener('error', () => rej(new Error('WS error')), { once: true });
    });

// ── hook ─────────────────────────────────────────────────────────────────────

export const useCandleBot = () => {
    const [status, setStatus] = useState<CandleBotStatus>('idle');
    const [statusMsg, setStatusMsg] = useState('');
    const [totalPnl, setTotalPnl] = useState(0);
    const [trades, setTrades] = useState<TradeRecord[]>([]);
    const [currentStake, setCurrentStake] = useState(0);
    const [martingaleStep, setMartingaleStep] = useState(0);

    // refs survive re-renders without triggering them
    const apiRef = useRef<any>(null);
    const settingsRef = useRef<CandleBotSettings | null>(null);
    const isRunningRef = useRef(false);
    const prevCandleRef = useRef<CandleData | null>(null);
    const currentCandleEpochRef = useRef<number>(0);
    const totalPnlRef = useRef(0);
    const currentStakeRef = useRef(0);
    const martingaleStepRef = useRef(0);
    const candleSubIdRef = useRef<string>('');
    const ocSubIdRef = useRef<string>('');
    const ocHandlerRef = useRef<((msg: any) => void) | null>(null);

    // ── state helpers ──────────────────────────────────────────────────────────
    const updatePnl = (delta: number) => {
        totalPnlRef.current += delta;
        setTotalPnl(totalPnlRef.current);
    };

    const addTrade = (trade: TradeRecord) => {
        setTrades(prev => [trade, ...prev].slice(0, 50)); // keep last 50
    };

    const updateTrade = (id: string, patch: Partial<TradeRecord>) => {
        setTrades(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)));
    };

    // ── buy a contract ─────────────────────────────────────────────────────────
    const buyContract = useCallback(
        async (direction: 'CALL' | 'PUT', stake: number, entryEpoch: number): Promise<void> => {
            const api = apiRef.current;
            const settings = settingsRef.current;
            if (!api || !settings) return;

            const tradeId = `${Date.now()}-${direction}`;
            const record: TradeRecord = {
                id: tradeId,
                direction,
                stake,
                entryEpoch,
                status: 'open',
            };
            addTrade(record);

            setStatus('buying');
            setStatusMsg(`Buying ${direction} @ ${stake}`);

            try {
                // 1. Get proposal
                const proposalReq = {
                    proposal: 1,
                    amount: stake,
                    basis: 'stake',
                    contract_type: direction,
                    currency: 'USD',
                    duration: 60,
                    duration_unit: 's',
                    symbol: settings.symbol,
                };

                const proposalResp = await api.send(proposalReq);

                if (proposalResp?.error) {
                    throw new Error(proposalResp.error.message || 'Proposal error');
                }

                const proposalId = proposalResp?.proposal?.id;
                if (!proposalId) throw new Error('No proposal ID');

                // 2. Buy immediately
                const buyResp = await api.send({ buy: proposalId, price: stake });

                if (buyResp?.error) {
                    throw new Error(buyResp.error.message || 'Buy error');
                }

                const contractId = buyResp?.buy?.contract_id;
                const buyPrice = buyResp?.buy?.buy_price ?? stake;

                updateTrade(tradeId, { contractId, stake: buyPrice });
                setStatus('in_trade');
                setStatusMsg(`In trade: ${direction} #${contractId}`);

                // 3. Subscribe to open contract to catch settlement
                await subscribeToContract(contractId, tradeId, buyPrice);
            } catch (err: any) {
                setStatus('error');
                setStatusMsg(`Buy error: ${err.message}`);
                updateTrade(tradeId, { status: 'error' });
                // After error, go back to waiting for next candle
                setTimeout(() => {
                    if (isRunningRef.current) {
                        setStatus('waiting');
                        setStatusMsg('Waiting for next candle…');
                    }
                }, 3000);
            }
        },
        []
    );

    // ── subscribe to a single contract until settlement ────────────────────────
    const subscribeToContract = useCallback(
        async (contractId: number, tradeId: string, buyPrice: number): Promise<void> => {
            const api = apiRef.current;
            const settings = settingsRef.current;
            if (!api || !settings) return;

            return new Promise<void>(resolve => {
                const handler = (msgEvent: any) => {
                    try {
                        const msg = typeof msgEvent === 'string' ? JSON.parse(msgEvent) : msgEvent;
                        const poc = msg?.proposal_open_contract;
                        if (!poc || poc.contract_id !== contractId) return;

                        if (poc.is_sold || poc.status === 'sold') {
                            // Contract settled
                            const profit = (poc.profit ?? 0) as number;
                            const won = profit >= 0;

                            updateTrade(tradeId, {
                                exitEpoch: poc.sell_time,
                                profit,
                                status: won ? 'won' : 'lost',
                            });

                            updatePnl(profit);

                            // Forget this subscription
                            if (ocSubIdRef.current) {
                                api.send({ forget: ocSubIdRef.current }).catch(() => {});
                                ocSubIdRef.current = '';
                            }

                            // Remove message listener
                            if (ocHandlerRef.current) {
                                try {
                                    api.connection.removeEventListener('message', ocHandlerRef.current);
                                } catch {}
                                ocHandlerRef.current = null;
                            }

                            // Martingale logic
                            const newPnl = totalPnlRef.current;
                            const stk = currentStakeRef.current;

                            if (!won) {
                                const newStep = Math.min(
                                    martingaleStepRef.current + 1,
                                    settings.maxMartingaleSteps
                                );
                                const newStake = parseFloat(
                                    (stk * Math.pow(settings.martingaleMultiplier, newStep)).toFixed(2)
                                );
                                martingaleStepRef.current = newStep;
                                currentStakeRef.current = newStake;
                                setMartingaleStep(newStep);
                                setCurrentStake(newStake);
                            } else {
                                // Reset on win
                                martingaleStepRef.current = 0;
                                currentStakeRef.current = settings.stake;
                                setMartingaleStep(0);
                                setCurrentStake(settings.stake);
                            }

                            // Check TP / SL
                            if (isRunningRef.current) {
                                if (newPnl >= settings.takeProfit) {
                                    stopBot('Take profit reached 🎉');
                                } else if (newPnl <= -settings.stopLoss) {
                                    stopBot('Stop loss reached 🛑');
                                } else {
                                    setStatus('waiting');
                                    setStatusMsg('Waiting for next candle…');
                                }
                            }

                            resolve();
                        }
                    } catch {}
                };

                ocHandlerRef.current = handler;
                api.connection.addEventListener('message', handler);

                // Subscribe to proposal_open_contract
                api
                    .send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
                    .then((resp: any) => {
                        if (resp?.subscription?.id) {
                            ocSubIdRef.current = resp.subscription.id;
                        }
                    })
                    .catch(() => resolve());
            });
        },
        []
    );

    // ── candle message handler ─────────────────────────────────────────────────
    const handleCandleMessage = useCallback(
        (msgEvent: MessageEvent) => {
            if (!isRunningRef.current) return;
            const settings = settingsRef.current;
            if (!settings) return;

            let msg: any;
            try {
                msg = typeof msgEvent.data === 'string' ? JSON.parse(msgEvent.data) : msgEvent.data;
            } catch {
                return;
            }

            // We listen for OHLC (candle) messages
            const ohlc = msg?.ohlc;
            if (!ohlc || ohlc.granularity !== 60) return;

            const epoch = parseInt(ohlc.epoch, 10);
            const open = parseFloat(ohlc.open);
            const high = parseFloat(ohlc.high);
            const low = parseFloat(ohlc.low);
            const close = parseFloat(ohlc.close);

            // A NEW candle started when epoch changed
            if (epoch !== currentCandleEpochRef.current) {
                const closedCandle = prevCandleRef.current;
                currentCandleEpochRef.current = epoch;

                // Store this new incomplete candle as current
                prevCandleRef.current = { open, high, low, close, epoch };

                // Only trade if we have a closed candle and not already in a trade
                if (
                    closedCandle &&
                    (status === 'waiting' || status === 'running') &&
                    isRunningRef.current
                ) {
                    const direction: 'CALL' | 'PUT' | null =
                        closedCandle.close > closedCandle.open
                            ? 'CALL'
                            : closedCandle.close < closedCandle.open
                            ? 'PUT'
                            : null;

                    if (direction) {
                        const stake = currentStakeRef.current;
                        buyContract(direction, stake, epoch);
                    } else {
                        setStatusMsg('Doji candle — skipping');
                    }
                }
            } else {
                // Same candle — just update the tracked close
                if (prevCandleRef.current) {
                    prevCandleRef.current = { ...prevCandleRef.current, high, low, close };
                }
            }
        },
        [buyContract, status]
    );

    const handleCandleMessageRef = useRef(handleCandleMessage);
    useEffect(() => {
        handleCandleMessageRef.current = handleCandleMessage;
    }, [handleCandleMessage]);

    // ── stable wrapper so addEventListener keeps one reference ─────────────────
    const stableHandler = useRef((e: MessageEvent) => {
        handleCandleMessageRef.current(e);
    });

    // ── subscribe to 1-min candles ────────────────────────────────────────────
    const subscribeToCandleStream = useCallback(async (symbol: string): Promise<void> => {
        const api = apiRef.current;
        if (!api) return;

        // Forget previous
        if (candleSubIdRef.current) {
            try {
                await api.send({ forget: candleSubIdRef.current });
            } catch {}
            candleSubIdRef.current = '';
        }

        api.connection.addEventListener('message', stableHandler.current);

        const req = {
            ticks_history: symbol,
            style: 'candles',
            granularity: 60,
            count: 2, // fetch last 2 candles so we have history on start
            end: 'latest',
            subscribe: 1,
        };

        try {
            const resp = await api.send(req);
            if (resp?.subscription?.id) {
                candleSubIdRef.current = resp.subscription.id;
            }

            // Seed prev candle from history
            const candles = resp?.candles;
            if (candles && candles.length >= 2) {
                // second-to-last = definitely closed
                const last = candles[candles.length - 1];
                prevCandleRef.current = {
                    open: parseFloat(last.open),
                    high: parseFloat(last.high),
                    low: parseFloat(last.low),
                    close: parseFloat(last.close),
                    epoch: parseInt(last.epoch, 10),
                };
                currentCandleEpochRef.current = parseInt(last.epoch, 10);
            }
        } catch (err: any) {
            setStatus('error');
            setStatusMsg(`Candle subscribe error: ${err.message}`);
        }
    }, []);

    // ── connect & authorize a dedicated trading API instance ─────────────────
    const connectApi = useCallback(async (): Promise<boolean> => {
        const token = V2GetActiveToken();
        if (!token) {
            setStatus('error');
            setStatusMsg('Not logged in. Please log in first.');
            return false;
        }

        try {
            const api = generateDerivApiInstance();
            await waitForOpen(api.connection as unknown as WebSocket);
            const { authorize, error } = await api.authorize(token);

            if (error) {
                setStatus('error');
                setStatusMsg(`Auth error: ${error.message}`);
                return false;
            }

            apiRef.current = api;
            return true;
        } catch (err: any) {
            setStatus('error');
            setStatusMsg(`Connection error: ${err.message}`);
            return false;
        }
    }, []);

    // ── public: start bot ──────────────────────────────────────────────────────
    const startBot = useCallback(async (settings: CandleBotSettings) => {
        if (isRunningRef.current) return;

        settingsRef.current = settings;
        currentStakeRef.current = settings.stake;
        martingaleStepRef.current = 0;
        totalPnlRef.current = 0;
        prevCandleRef.current = null;
        currentCandleEpochRef.current = 0;

        setCurrentStake(settings.stake);
        setMartingaleStep(0);
        setTotalPnl(0);
        setTrades([]);
        setStatus('running');
        setStatusMsg('Connecting…');

        const ok = await connectApi();
        if (!ok) return;

        isRunningRef.current = true;
        setStatus('waiting');
        setStatusMsg('Waiting for next candle…');

        await subscribeToCandleStream(settings.symbol);
    }, [connectApi, subscribeToCandleStream]);

    // ── public: stop bot ───────────────────────────────────────────────────────
    const stopBot = useCallback((reason = 'Stopped by user') => {
        isRunningRef.current = false;

        // Cleanup message listener
        if (apiRef.current) {
            try {
                apiRef.current.connection.removeEventListener('message', stableHandler.current);
            } catch {}

            // Forget candle subscription
            if (candleSubIdRef.current) {
                apiRef.current.send({ forget: candleSubIdRef.current }).catch(() => {});
                candleSubIdRef.current = '';
            }

            // Forget OC subscription
            if (ocSubIdRef.current) {
                apiRef.current.send({ forget: ocSubIdRef.current }).catch(() => {});
                ocSubIdRef.current = '';
            }

            // Remove OC handler
            if (ocHandlerRef.current) {
                try {
                    apiRef.current.connection.removeEventListener('message', ocHandlerRef.current);
                } catch {}
                ocHandlerRef.current = null;
            }

            apiRef.current.disconnect();
            apiRef.current = null;
        }

        setStatus('stopped');
        setStatusMsg(reason);
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (isRunningRef.current) stopBot('Component unmounted');
        };
    }, [stopBot]);

    return {
        status,
        statusMsg,
        totalPnl,
        trades,
        currentStake,
        martingaleStep,
        startBot,
        stopBot,
        isRunning: isRunningRef,
    };
};

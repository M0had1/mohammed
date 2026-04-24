import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { CandleBotSettings, CandleBotStatus } from './candle-bot.types';
import { useCandleBot } from './use-candle-bot';
import './candle-bot-panel.scss';

const STATUS_LABELS: Record<CandleBotStatus, string> = {
    idle: '⚪ Idle',
    running: '🟡 Starting…',
    waiting: '🔵 Waiting for candle',
    buying: '🟠 Placing trade…',
    in_trade: '🟢 In trade',
    error: '🔴 Error',
    stopped: '⛔ Stopped',
};

const DEFAULT_SETTINGS: CandleBotSettings = {
    symbol: 'R_100',
    stake: 1,
    takeProfit: 10,
    stopLoss: 10,
    martingaleMultiplier: 2,
    maxMartingaleSteps: 4,
    enabled: false,
};

const CandleBotPanel: React.FC = observer(() => {
    const { chart_store } = useStore();
    const { symbol } = chart_store;

    const [settings, setSettings] = useState<CandleBotSettings>({
        ...DEFAULT_SETTINGS,
        symbol: symbol || DEFAULT_SETTINGS.symbol,
    });
    const [isOpen, setIsOpen] = useState(false);

    // ── drag state ────────────────────────────────────────────────────────────
    const panelRef = useRef<HTMLDivElement>(null);
    const [dragged, setDragged] = useState(false);
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const dragOrigin = useRef({ mouseX: 0, mouseY: 0, panelX: 0, panelY: 0 });

    const onDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
        dragOrigin.current = { mouseX: clientX, mouseY: clientY, panelX: pos.x, panelY: pos.y };

        const onMove = (ev: MouseEvent | TouchEvent) => {
            const mx = 'touches' in ev ? (ev as TouchEvent).touches[0].clientX : (ev as MouseEvent).clientX;
            const my = 'touches' in ev ? (ev as TouchEvent).touches[0].clientY : (ev as MouseEvent).clientY;
            setDragged(true);
            setPos({
                x: dragOrigin.current.panelX + mx - dragOrigin.current.mouseX,
                y: dragOrigin.current.panelY + my - dragOrigin.current.mouseY,
            });
        };

        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
    }, [pos]);

    const { status, statusMsg, totalPnl, trades, currentStake, martingaleStep, startBot, stopBot } = useCandleBot();

    // Keep symbol in sync with the chart's selected symbol
    useEffect(() => {
        if (symbol && status === 'idle' || status === 'stopped') {
            setSettings(prev => ({ ...prev, symbol: symbol || prev.symbol }));
        }
    }, [symbol, status]);

    const isActive = status !== 'idle' && status !== 'stopped' && status !== 'error';

    const handleStart = () => {
        startBot({ ...settings, symbol: symbol || settings.symbol });
    };

    const handleStop = () => {
        stopBot();
    };

    const handleChange = (field: keyof CandleBotSettings, value: string | number) => {
        setSettings(prev => ({ ...prev, [field]: value }));
    };

    const panelStyle: React.CSSProperties = dragged
        ? { transform: `translate(${pos.x}px, ${pos.y}px)` }
        : {};

    return (
        <div
            ref={panelRef}
            className={`cbot-panel ${isOpen ? 'cbot-panel--open' : ''}`}
            style={panelStyle}
        >
            {/* Floating toggle button */}
            <button
                className={`cbot-toggle ${isActive ? 'cbot-toggle--active' : ''}`}
                onClick={() => setIsOpen(o => !o)}
                title='Candle Bot'
            >
                <span className='cbot-toggle__icon'>🤖</span>
                <span className='cbot-toggle__label'>Candle Bot</span>
                {isActive && <span className='cbot-toggle__pulse' />}
            </button>

            {isOpen && (
                <div className='cbot-drawer'>
                    {/* Drag handle */}
                    <div
                        className='cbot-drawer__header cbot-drawer__header--draggable'
                        onMouseDown={onDragStart}
                        onTouchStart={onDragStart}
                    >
                        <span className='cbot-drawer__drag-hint'>⠿</span>
                        <span className='cbot-drawer__title'>🕯️ Candle Bot</span>
                        <button className='cbot-drawer__close' onClick={() => setIsOpen(false)}>✕</button>
                    </div>

                    {/* Scrollable body */}
                    <div className='cbot-drawer__body'>

                    {/* Status bar */}
                    <div className={`cbot-status cbot-status--${status}`}>
                        <span>{STATUS_LABELS[status]}</span>
                        {statusMsg && <span className='cbot-status__msg'>{statusMsg}</span>}
                    </div>

                    {/* P&L bar */}
                    <div className={`cbot-pnl ${totalPnl >= 0 ? 'cbot-pnl--pos' : 'cbot-pnl--neg'}`}>
                        <span>P&L</span>
                        <strong>{totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}</strong>
                        {martingaleStep > 0 && (
                            <span className='cbot-pnl__martingale'>M×{martingaleStep} / stake {currentStake.toFixed(2)}</span>
                        )}
                    </div>

                    {/* Settings form (disabled while running) */}
                    <div className='cbot-form'>
                        <label className='cbot-form__field'>
                            <span>Symbol</span>
                            <input
                                type='text'
                                value={symbol || settings.symbol}
                                disabled
                                className='cbot-form__input cbot-form__input--disabled'
                            />
                        </label>

                        <label className='cbot-form__field'>
                            <span>Stake (USD)</span>
                            <input
                                type='number'
                                min='0.35'
                                step='0.01'
                                value={settings.stake}
                                disabled={isActive}
                                onChange={e => handleChange('stake', parseFloat(e.target.value) || 0)}
                                className='cbot-form__input'
                            />
                        </label>

                        <label className='cbot-form__field'>
                            <span>Take Profit (USD)</span>
                            <input
                                type='number'
                                min='0.01'
                                step='0.01'
                                value={settings.takeProfit}
                                disabled={isActive}
                                onChange={e => handleChange('takeProfit', parseFloat(e.target.value) || 0)}
                                className='cbot-form__input'
                            />
                        </label>

                        <label className='cbot-form__field'>
                            <span>Stop Loss (USD)</span>
                            <input
                                type='number'
                                min='0.01'
                                step='0.01'
                                value={settings.stopLoss}
                                disabled={isActive}
                                onChange={e => handleChange('stopLoss', parseFloat(e.target.value) || 0)}
                                className='cbot-form__input'
                            />
                        </label>

                        <label className='cbot-form__field'>
                            <span>Martingale multiplier</span>
                            <input
                                type='number'
                                min='1'
                                max='5'
                                step='0.1'
                                value={settings.martingaleMultiplier}
                                disabled={isActive}
                                onChange={e => handleChange('martingaleMultiplier', parseFloat(e.target.value) || 1)}
                                className='cbot-form__input'
                            />
                            <span className='cbot-form__hint'>1 = disabled</span>
                        </label>

                        <label className='cbot-form__field'>
                            <span>Max Martingale steps</span>
                            <input
                                type='number'
                                min='0'
                                max='10'
                                step='1'
                                value={settings.maxMartingaleSteps}
                                disabled={isActive}
                                onChange={e => handleChange('maxMartingaleSteps', parseInt(e.target.value) || 0)}
                                className='cbot-form__input'
                            />
                        </label>
                    </div>

                    {/* Action buttons */}
                    <div className='cbot-actions'>
                        {!isActive ? (
                            <button className='cbot-btn cbot-btn--start' onClick={handleStart}>
                                ▶ Start Bot
                            </button>
                        ) : (
                            <button className='cbot-btn cbot-btn--stop' onClick={handleStop}>
                                ■ Stop Bot
                            </button>
                        )}
                    </div>

                    {/* Trade log */}
                    {trades.length > 0 && (
                        <div className='cbot-log'>
                            <div className='cbot-log__header'>Recent trades</div>
                            <div className='cbot-log__list'>
                                {trades.slice(0, 10).map(t => (
                                    <div
                                        key={t.id}
                                        className={`cbot-log__row cbot-log__row--${t.status}`}
                                    >
                                        <span className='cbot-log__dir'>
                                            {t.direction === 'CALL' ? '▲' : '▼'} {t.direction}
                                        </span>
                                        <span className='cbot-log__stake'>${t.stake.toFixed(2)}</span>
                                        <span className='cbot-log__profit'>
                                            {t.profit !== undefined
                                                ? (t.profit >= 0 ? '+' : '') + t.profit.toFixed(2)
                                                : t.status === 'open'
                                                ? '…'
                                                : t.status}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <p className='cbot-disclaimer'>
                        ⚠️ Automated trading carries risk. Only trade with money you can afford to lose.
                    </p>

                    </div>{/* end scrollable body */}
                </div>
            );}
        </div>
    );
});

export default CandleBotPanel;

export type CandleBotStatus = 'idle' | 'running' | 'waiting' | 'buying' | 'in_trade' | 'error' | 'stopped';

export interface CandleBotSettings {
    symbol: string;
    stake: number;
    takeProfit: number;
    stopLoss: number;
    martingaleMultiplier: number; // 1 = disabled
    maxMartingaleSteps: number;
    enabled: boolean;
}

export interface CandleData {
    open: number;
    high: number;
    low: number;
    close: number;
    epoch: number; // candle open time
}

export interface TradeRecord {
    id: string;
    direction: 'CALL' | 'PUT';
    stake: number;
    entryEpoch: number;
    exitEpoch?: number;
    profit?: number;
    status: 'open' | 'won' | 'lost' | 'error';
    contractId?: string;
}

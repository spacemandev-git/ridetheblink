export interface WebhookEvent {
    accountData: AccountDatum[];
    description: string;
    events: Events;
    fee: number;
    feePayer: string;
    instructions: Instruction[];
    nativeTransfers: any[];
    signature: string;
    slot: number;
    source: string;
    timestamp: number;
    tokenTransfers: TokenTransfer[];
    transactionError: null;
    type: string;
}

export interface AccountDatum {
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: TokenBalanceChange[];
}

export interface TokenBalanceChange {
    mint: string;
    rawTokenAmount: RawTokenAmount;
    tokenAccount: string;
    userAccount: string;
}

export interface RawTokenAmount {
    decimals: number;
    tokenAmount: string;
}

export interface Events {
}

export interface Instruction {
    accounts: string[];
    data: string;
    innerInstructions: any[];
    programId: string;
}

export interface TokenTransfer {
    fromTokenAccount: string;
    fromUserAccount: string;
    mint: string;
    toTokenAccount: string;
    toUserAccount: string;
    tokenAmount: number;
    tokenStandard: string;
}

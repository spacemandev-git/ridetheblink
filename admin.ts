import { PrismaClient } from "@prisma/client";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, TransactionMessage, VersionedMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
const prisma = new PrismaClient();
import bs58 from 'bs58';
import { bonkDecimals, bonkMint, serverBonkATA, serverKey } from ".";

const serverPrivateKey = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_PRIVATE_KEY as string));
const connection = new Connection(process.env.RPC_URL as string, "confirmed");


gameinfo();
deliverBonk();

async function gameinfo() {
    const winningScore = (await prisma.player.findMany({
        orderBy: {
            points: "desc"
        },
        take: 1
    }))[0].points;
    const losingScore = (await prisma.player.findMany({
        orderBy: {
            points: "asc"
        },
        take: 1
    }))[0].points;
    console.log(`Winning score: ${winningScore}, Losing score: ${losingScore}`)

    const winningCount = await prisma.player.count({ where: { points: { equals: winningScore } } })
    const losingCount = await prisma.player.count({ where: { points: { equals: losingScore } } })
    const allPlayersCount = await prisma.player.count();
    const averageCount = allPlayersCount - (winningCount + losingCount);

    console.log(`All players: ${allPlayersCount}, Winning players: ${winningCount}, Losing players: ${losingCount},  Average players: ${averageCount}`)

    return {
        winningScore,
        losingScore,
        winningCount,
        losingCount,
        allPlayersCount,
        averageCount
    }
}

async function deliverBonk(dryrun: boolean = true) {
    let ixArray = [];
    const { winningScore, losingScore } = await gameinfo();
    // PrizePool = LosersBonk + 30% of AverageBonk
    let totalPool = 0;
    const averagePlayers = await prisma.player.findMany({
        where: {
            points: {
                notIn: [winningScore, losingScore]
            }
        }
    });
    const losingPlayers = await prisma.player.findMany({
        where: {
            points: {
                equals: losingScore
            }
        }
    });
    const winningPlayers = await prisma.player.findMany({
        where: {
            points: {
                equals: winningScore
            }
        }
    });


    // Average players get 70% of BONK back
    for (let averagePlayer of averagePlayers) {
        const amtToReturn = Math.floor(averagePlayer.bonk * 0.7) * 1e5;
        totalPool += (amtToReturn - averagePlayer.bonk);
        const playerATA = getAssociatedTokenAddressSync(bonkMint, new PublicKey(averagePlayer.wallet));
        const ix = createTransferCheckedInstruction(serverBonkATA, bonkMint, playerATA, serverPrivateKey.publicKey, amtToReturn, bonkDecimals)
        ixArray.push(ix)
    }
    // Losers get 0 BONK back
    for (let losingPlayer of losingPlayers) {
        totalPool += losingPlayer.bonk;
    }

    // AdminFee = 10% of PrizePool
    const adminFee = Math.floor(totalPool * 0.1);
    // WinnersPool = PrizePool - AdminFee
    const winnersPool = totalPool - adminFee;

    // Winners get 100% of BONK back + (WinnersPool / # number of winners)
    const winningDistribution = Math.floor(winnersPool / winningPlayers.length);
    for (let winningPlayer of winningPlayers) {
        const amtToReturn = winningPlayer.bonk + winningDistribution;
        const playerATA = getAssociatedTokenAddressSync(bonkMint, new PublicKey(winningPlayer.wallet));
        const ix = createTransferCheckedInstruction(serverBonkATA, bonkMint, playerATA, serverPrivateKey.publicKey, amtToReturn, bonkDecimals)
        ixArray.push(ix)
    }

    const ixPackedArrays = await ixPack(ixArray);
    for (let ixGroup of ixPackedArrays) {
        const tx = new VersionedTransaction(new TransactionMessage({
            payerKey: serverPrivateKey.publicKey,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
            instructions: [
                ...ixGroup
            ],
        }).compileToV0Message());
        if (!dryrun) {
            const signature = await connection.sendRawTransaction(tx.serialize());
            console.log(`Delivered bonk to ${ixGroup.length} players. Signature: ${signature}`);
        } else {
            try {
                connection.simulateTransaction(tx);
                console.log(`Dry run delivering bonk to ${ixGroup.length} players.`);
            } catch (e) {
                console.log(`Error: ${e}`);
            }
        }
    }
}


async function ixPack(ixs: TransactionInstruction[]): Promise<TransactionInstruction[][]> {
    const dummyKey = new Keypair();
    let ixGroupArray: TransactionInstruction[][] = [];
    let ixBuffer: TransactionInstruction[] = [];
    for (let ix of ixs) {
        ixBuffer.push(ix);
        let tempTx = new Transaction();
        tempTx.add(...ixBuffer);
        tempTx.feePayer = dummyKey.publicKey;
        tempTx.recentBlockhash = dummyKey.publicKey.toBase58(); //doesn't matter, just a dummy hash

        if (tempTx.serializeMessage().length > 900) {
            ixGroupArray.push(ixBuffer);
            ixBuffer = [];
        }
    }

    // Any leftover ix
    if (ixBuffer.length > 0) {
        ixGroupArray.push(ixBuffer)
    }

    return ixGroupArray;
}
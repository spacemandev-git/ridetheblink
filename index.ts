import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from 'fs';
import shuffle from 'knuth-shuffle-seeded';
import type { ActionError, ActionGetResponse, ActionPostRequest, ActionPostResponse } from "@solana/actions";
import { clusterApiUrl, Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PrismaClient } from '@prisma/client';
import type { WebhookEvent } from "./webhook-interface";
const prisma = new PrismaClient();

interface Card {
    value: number,
    suit: "Hearts" | "Diamonds" | "Clubs" | "Spades",
    display: string,
}
const url = "https://ridetheblink.blinkgames.dev";
const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");

const bonkMint = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
const bonkDecimals = 5;

const serverKey = new PublicKey("2qPRnmigG7KBwnR26djXHdPuYBzBvYEsbZBeoNVeWzqr");
const serverBonkATA = getAssociatedTokenAddressSync(bonkMint, serverKey);

const deck: Card[] = JSON.parse(readFileSync("./deck.json").toString());
const app = new Hono();

app.use('/actions.json', serveStatic({ path: "./actions.json" }));
app.use('/public/*', serveStatic({ root: "./" }));
app.use('/', async (c) => c.redirect("https://spacemandev.notion.site/Ride-the-Bus-b38a245fcfe84b98b0470ca7dbaf97a0?pvs=25"))
app.use('*', cors({
    origin: ['*'], //TODO: Restrict to x.com or twitter.com
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', "Accept-Encoding"],
    exposeHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
}));

/**
 * Debug Method
 */
app.get("/", async (c) => {
    console.log(deck);
    return c.text("Hello World!");
})

app.post("/webhook", async (c) => {
    const authorization = c.req.header("authorization");
    if (authorization != process.env.SERVER_AUTH_CODE) {
        return c.status(401);
    }

    const events: WebhookEvent[] = await c.req.json();
    for (let event of events) {
        if (event.type == "TRANSFER") {
            for (let tokenTransfer of event.tokenTransfers) {
                if (
                    tokenTransfer.mint == bonkMint.toString() &&
                    tokenTransfer.toTokenAccount == serverBonkATA.toString()
                ) {
                    const amt = tokenTransfer.tokenAmount;
                    const sender = tokenTransfer.fromUserAccount;
                    await prisma.confirmingTransactions.update({
                        where: {
                            wallet: sender
                        },
                        data: {
                            pendingBonk: {
                                decrement: amt
                            }
                        }
                    })
                }
            }
        }
    }
    return c.status(200);
})

/** Phase 1 */

/**
 * Registers the wallet in our database for X bonk
 */
const REGISTER_BONK_COST = 100
app.get("/1/register", async (c) => {
    let buttons: ActionGetResponse = {
        icon: `${url}/public/bus.webp`,
        title: "Ride the Bus",
        description: `Register to Ride the Bus for ${REGISTER_BONK_COST} $BONK. Rules at ${url}`,
        label: "Register!"
    }

    return c.json(buttons);
})

app.post("/1/register", async (c) => {
    const { account } = await c.req.json();
    console.log(`Registering account ${account} in our database.`)
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (user) {
            throw new Error("You're already registered!")
        }

        const accountKey = new PublicKey(account);
        const sourceBonkATA = getAssociatedTokenAddressSync(bonkMint, accountKey);

        const ix = createTransferCheckedInstruction(sourceBonkATA, bonkMint, serverBonkATA, accountKey, REGISTER_BONK_COST, bonkDecimals);
        const msg = new TransactionMessage({
            payerKey: accountKey,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
            instructions: [ix]
        }).compileToV0Message();
        const txn = new VersionedTransaction(msg);
        const response: ActionPostResponse = {
            transaction: Buffer.from(txn.serialize()).toString("base64"),
            message: `Registering to play Ride the Bus!`
        }

        await prisma.confirmingTransactions.create({
            data: {
                wallet: account,
                pendingBonk: REGISTER_BONK_COST
            }
        })

        return c.json(response, 200)
    } catch (e: any) {
        const error: ActionError = {
            message: e.message
        }
        return c.json(error, 400);
    }
})

/**
 * Phase 1: Red/Black
 * Player picks either Red/Black, and gets a point if they win
 * If they try to do it after already having done it, they are given an error
 */

app.get("/1/redblack", async (c) => {
    let buttons: ActionGetResponse = {
        icon: `${url}/public/bus.webp`,
        title: "Red / Black",
        description: `Is your first card a RED or BLACK card?`,
        label: "Red/Black",
        links: {
            actions: [
                {
                    href: `/1/redblack?q=RED`,
                    label: "RED"
                },
                {
                    href: `/1/redblack?q=BLACK`,
                    label: "BLACK"
                }
            ]
        }
    }

    return c.json(buttons);
})

app.post("/1/redblack", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You have to register first!") }
        const pendingBonkBalance = await prisma.confirmingTransactions.findFirst({ where: { wallet: account } })
        if (pendingBonkBalance!.pendingBonk > 0) {
            throw new Error("You have unconfirmed bonk balance left to pay!")
        }

        const playerPhase1 = await prisma.phase1.findFirst({ where: { wallet: account } });
        if (playerPhase1) {
            throw new Error("You're already past this step")
        }

        const playerDeck = structuredClone(deck);
        shuffle(playerDeck);

        const choice = c.req.query("q") as "RED" | "BLACK";
        const card1 = playerDeck.pop() as Card;

        await prisma.phase1.create({
            data: {
                wallet: account,
                card1display: card1!.display,
                card1suit: card1!.suit,
                card1value: card1!.value
            }
        })
        if (choice == "BLACK" && (card1!.suit == "Clubs" || card1!.suit == "Spades")) {
            await prisma.player.update({
                where: { wallet: account },
                data: {
                    points: {
                        increment: 1
                    },
                    deck: JSON.stringify(playerDeck)
                }
            })
            throw new Error(`Your card was ${card1.display}. You get 1 point. Move to Card 2`);
        } else if (choice == "RED" && (card1!.suit == "Diamonds" || card1!.suit == "Hearts")) {
            await prisma.player.update({
                where: { wallet: account },
                data: {
                    points: {
                        increment: 1
                    },
                    deck: JSON.stringify(playerDeck)
                }
            })
            throw new Error(`Your card was ${card1.display}. You get 1 point. Move to Card 2`);
        } else {
            await prisma.player.update({
                where: { wallet: account },
                data: {
                    points: {
                        increment: 0
                    },
                    deck: JSON.stringify(playerDeck)
                }
            })
            throw new Error(`Your card was ${card1.display}. Move to Card 2`);
        }
    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})


/**
 * Phase 1: High/Low
 * Player picks if the card is going to be higher/lower than their R/B card.
 * Option to review what their R/B card was if they forgot
 * If they try to do it after already having done it, they are given an error
 */

app.get("/1/highlow", async (c) => {
    let buttons: ActionGetResponse = {
        icon: `${url}/public/bus.webp`,
        title: "High/ Low",
        description: `Is your second card higher or lower than your first card?`,
        label: "High/Low",
        links: {
            actions: [
                {
                    href: `/1/highlow?q=review`,
                    label: "Review Card 1"
                },
                {
                    href: `/1/highlow?q=higher`,
                    label: "HIGHER"
                },
                {
                    href: `/1/highlow?q=lower`,
                    label: "LOWER"
                }
            ]
        }
    }

    return c.json(buttons);
})

app.post("/1/highlow", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You have to register first!") }
        const pendingBonkBalance = await prisma.confirmingTransactions.findFirst({ where: { wallet: account } })
        if (pendingBonkBalance!.pendingBonk > 0) {
            throw new Error("You have unconfirmed bonk balance left to pay!")
        }

        const playerPhase1 = await prisma.phase1.findFirst({ where: { wallet: account } });
        if (!playerPhase1 || playerPhase1.card1value == 0) {
            throw new Error("Please play Red/Black before you play High/Low")
        }

        if (playerPhase1.card2value != 0) {
            throw new Error(`You've already played this. Your card was ${playerPhase1.card2display}`)
        }

        const playerDeck: Card[] = JSON.parse(user.deck);
        const choice = c.req.query("q") as "review" | "higher" | "lower";

        if (choice == "review") {
            throw new Error(`Your first card was ${playerPhase1.card1display}`);
        } else {
            const card2 = playerDeck.pop();
            await prisma.phase1.update({
                where: { wallet: account },
                data: {
                    card2display: card2?.display,
                    card2suit: card2?.suit,
                    card2value: card2?.value
                }
            })
            if (card2!.value > playerPhase1.card1value && choice == "higher") {
                await prisma.player.update({
                    where: { wallet: account },
                    data: {
                        points: {
                            increment: 1
                        },
                        deck: JSON.stringify(playerDeck)
                    }
                })
                throw new Error(`Your second card is ${card2!.display}. You get 1 point. Move to Card 3`)
            } else if (card2!.value < playerPhase1.card1value && choice == "lower") {
                await prisma.player.update({
                    where: { wallet: account },
                    data: {
                        points: {
                            increment: 1
                        },
                        deck: JSON.stringify(playerDeck)
                    }
                })
                throw new Error(`Your second card is ${card2!.display}. You get 1 point. Move to Card 3`)
            } else {
                await prisma.player.update({
                    where: { wallet: account },
                    data: {
                        points: {
                            increment: 0
                        },
                        deck: JSON.stringify(playerDeck)
                    }
                })
                throw new Error(`Your second card is ${card2!.display}. Move to Card 3`)
            }
        }
    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})

/**
 * Phase 1: Inside/Ouside 
 * 
 * Player picks if the card is going to be inside/outside their an H/L card.
 * Option to review their H/L card if they forgot.
 * If they try to do it after they already have done it, it's disabled
 */

app.get("/1/insideoutside", async (c) => {
    let buttons: ActionGetResponse = {
        icon: `${url}/public/bus.webp`,
        title: "Inside / Outside",
        description: `Is your third card inside your first two cards or outside?`,
        label: "High/Low",
        links: {
            actions: [
                {
                    href: `/1/insideoutside?q=review`,
                    label: "Review Cards 1 & 2"
                },
                {
                    href: `/1/insideoutside?q=inside`,
                    label: "INSIDE"
                },
                {
                    href: `/1/insideoutside?q=outside`,
                    label: "OUTSIDE"
                }
            ]
        }
    }

    return c.json(buttons);
})

app.post("/1/insideoutside", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You have to register first!") }
        const pendingBonkBalance = await prisma.confirmingTransactions.findFirst({ where: { wallet: account } })
        if (pendingBonkBalance!.pendingBonk > 0) {
            throw new Error("You have unconfirmed bonk balance left to pay!")
        }

        const playerPhase1 = await prisma.phase1.findFirst({ where: { wallet: account } });
        if (!playerPhase1 || playerPhase1.card2value == 0) {
            throw new Error("Please play High/Low before you play Inside/Outside")
        }

        if (playerPhase1.card3value != 0) {
            throw new Error(`You've already played this. Your card was ${playerPhase1.card3display}`)
        }

        const playerDeck: Card[] = JSON.parse(user.deck);
        const choice = c.req.query("q") as "review" | "inside" | "outside";

        if (choice == "review") {
            throw new Error(`Your cards are: ${playerPhase1.card1display} and ${playerPhase1.card2display}`);
        } else {
            const card3 = playerDeck.pop();
            await prisma.phase1.update({
                where: { wallet: account },
                data: {
                    card3display: card3?.display,
                    card3suit: card3?.suit,
                    card3value: card3?.value
                }
            })
            if (choice == "inside" &&
                (card3!.value > Math.min(playerPhase1.card1value, playerPhase1.card2value) &&
                    card3!.value < Math.max(playerPhase1.card1value, playerPhase1.card2value))) {
                await prisma.player.update({
                    where: { wallet: account },
                    data: {
                        points: {
                            increment: 1
                        },
                        deck: JSON.stringify(playerDeck)
                    }
                })
                throw new Error(`Your card was ${card3!.display}. You get 1 point. Move to Card 4`);
            } else if (choice == "outside" &&
                (card3!.value < Math.min(playerPhase1.card1value, playerPhase1.card2value) ||
                    card3!.value > Math.max(playerPhase1.card1value, playerPhase1.card2value))) {
                await prisma.player.update({
                    where: { wallet: account },
                    data: {
                        points: {
                            increment: 1
                        },
                        deck: JSON.stringify(playerDeck)
                    }
                })
                throw new Error(`Your card was ${card3!.display}. You get 1 point. Move to Card 4`);
            } else {
                await prisma.player.update({
                    where: { wallet: account },
                    data: {
                        points: {
                            increment: 0
                        },
                        deck: JSON.stringify(playerDeck)
                    }
                })
                throw new Error(`Your card was ${card3!.display}. Move to Card 4`);
            }
        }
    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})

/**
 * Phase 1:  Suit
 * Player picks what they think the suit of the next card is going to be.
 * If they have already done this, they are given an error
 */
app.get("/1/suit", async (c) => {
    let buttons: ActionGetResponse = {
        icon: `${url}/public/bus.webp`,
        title: "Suit",
        description: `What is the suit of your fourth card?`,
        label: "Suit",
        links: {
            actions: [
                {
                    href: `/1/suit?q=spades`,
                    label: "♠"
                },
                {
                    href: `/1/suit?q=diamonds`,
                    label: "♦"
                },
                {
                    href: `/1/suit?q=clubs`,
                    label: "♣"
                },
                {
                    href: `/1/suit?q=hearts`,
                    label: "♥"
                }
            ]
        }
    }

    return c.json(buttons);
})

app.post("/1/suit", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You have to register first!") }
        const pendingBonkBalance = await prisma.confirmingTransactions.findFirst({ where: { wallet: account } })
        if (pendingBonkBalance!.pendingBonk > 0) {
            throw new Error("You have unconfirmed bonk balance left to pay!")
        }

        const playerPhase1 = await prisma.phase1.findFirst({ where: { wallet: account } });
        if (!playerPhase1 || playerPhase1.card3value == 0) {
            throw new Error("Please play Inside/Outside before you play Suit")
        }

        if (playerPhase1.card4value != 0) {
            throw new Error(`You've already played this. Your card was ${playerPhase1.card4display}`)
        }

        const playerDeck: Card[] = JSON.parse(user.deck);
        const choice = c.req.query("q") as "spades" | "diamonds" | "clubs" | "hearts";
        const card4 = playerDeck.pop();
        await prisma.phase1.update({
            where: { wallet: account },
            data: {
                card4display: card4?.display,
                card4suit: card4?.suit,
                card4value: card4?.value
            }
        });

        if (
            (choice == "spades" && card4?.suit == "Spades") ||
            (choice == "clubs" && card4?.suit == "Clubs") ||
            (choice == "hearts" && card4?.suit == "Hearts") ||
            (choice == "diamonds" && card4?.suit == "Diamonds")
        ) {
            await prisma.player.update({
                where: { wallet: account },
                data: {
                    points: {
                        increment: 1
                    },
                    deck: JSON.stringify(playerDeck)
                }
            })
            throw new Error(`Your card was ${card4!.display}. You get 1 point. Check in tomorrow for phase 2.`);
        } else {
            await prisma.player.update({
                where: { wallet: account },
                data: {
                    points: {
                        increment: 0
                    },
                    deck: JSON.stringify(playerDeck)
                }
            })
            throw new Error(`Your card was ${card4!.display}. Check in tomorrow for phase 2`);
        }

    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})

/**
 * Phase 1: Review
 * Option to review their hand and how many points they have left
 */

app.get("/1/review", async (c) => {
    let buttons: ActionGetResponse = {
        icon: `${url}/public/bus.webp`,
        title: "Phase 1 Review",
        description: `Review your four cards`,
        label: "Review",
    }

    return c.json(buttons);
})

app.post("/1/review", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You have to register first!") }
        const pendingBonkBalance = await prisma.confirmingTransactions.findFirst({ where: { wallet: account } })
        if (pendingBonkBalance!.pendingBonk > 0) {
            throw new Error("You have unconfirmed bonk balance left to pay!")
        }

        const playerPhase1 = await prisma.phase1.findFirst({ where: { wallet: account } });
        if (!playerPhase1) {
            throw new Error("Please play Red/Black before you can review your cards")
        }

        throw new Error(`Your cards are: ${playerPhase1.card1display}, ${playerPhase1.card2display}, ${playerPhase1.card3display}, ${playerPhase1.card4display}. You currently have ${user.points} points.`)
    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})

/** Phase 1 */

/** Phase 2 */

/**
 * Phase 2: Card 1-4
 * They can review their Card 1-4 and are given how many total players there are with Card 1-4's in the game.
 * They must guess how many players have the same value card as them. 
 * If they guess within 10% of the actual value they get 1 point, 2 points for 5%, 3 points for 1 %
 */

app.get("/2/:card", async (c) => {
    try {
        const cardNum = c.req.param("card") as string;
        let totalPlayers = 0;

        switch (cardNum) {
            case "1":
                totalPlayers = await prisma.phase1.count({ where: { card1value: { gt: 0 } } });
                break;
            case "2":
                totalPlayers = await prisma.phase1.count({ where: { card2value: { gt: 0 } } });
                break;
            case "3":
                totalPlayers = await prisma.phase1.count({ where: { card3value: { gt: 0 } } });
                break;
            case "4":
                totalPlayers = await prisma.phase1.count({ where: { card4value: { gt: 0 } } });
                break;
            default:
                throw new Error("Invalid URL!")
        }

        let buttons: ActionGetResponse = {
            icon: `${url}/public/bus.webp`,
            title: `Phase 2; Card ${cardNum}`,
            description: `${totalPlayers} have a card ${cardNum}. How many of them picked the same *value* as you? Suit doesn't matter? 1pt for guessing within 10%, 3pts for 5%, and 5pts for 1%.`,
            label: "Phase 2",
            links: {
                actions: [
                    {
                        href: `/2/review/${cardNum}`,
                        label: `Review Phase 1 Card ${cardNum}`
                    },
                    {
                        href: `/2/guess/${cardNum}?q={guess}`,
                        label: `Guess`,
                        parameters: [{ name: "guess" }]
                    }
                ]
            }
        }

        return c.json(buttons);
    } catch (e: any) {
        const response: ActionError = { message: e.message }
        return c.json(response, 500)
    }

})

app.post("/2/:card/review", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You didn't register in round 1. Wait til next game to play!") }

        const playerPhase1 = await prisma.phase1.findFirst({ where: { wallet: account } });
        if (!playerPhase1) {
            throw new Error("You never even played Red/Black")
        }

        const cardNum = c.req.param("card") as string;

        switch (cardNum) {
            case "1":
                throw new Error(`Your Card ${cardNum} was ${playerPhase1.card1display}`)
                break;
            case "2":
                throw new Error(`Your Card ${cardNum} was ${playerPhase1.card2display}`)
                break;
            case "3":
                throw new Error(`Your Card ${cardNum} was ${playerPhase1.card3display}`)
                break;
            case "4":
                throw new Error(`Your Card ${cardNum} was ${playerPhase1.card4display}`)
                break;
            default:
                throw new Error("Invalid URL!")
        }

    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})

app.post("/2/:card/guess", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    const cardNum = c.req.param("card") as string;
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You didn't register in round 1. Wait til next game to play!") }

        const playerPhase1 = await prisma.phase1.findFirst({ where: { wallet: account } });
        if (!playerPhase1) {
            throw new Error("You never even played Red/Black")
        }


        const guess = parseInt(c.req.query("q") ? c.req.query("q")! : "0");
        let cardPlayers = 0;
        let percentage: number = 1.0;
        const playerPhase2 = await prisma.phase2.findFirst({ where: { wallet: account } });

        switch (cardNum) {
            case "1":
                if (playerPhase1.card1value == 0) {
                    throw new Error("You never played step 1 of phase 1");
                }
                cardPlayers = await prisma.phase1.count({ where: { card1value: playerPhase1.card1value } });
                percentage = guess / cardPlayers;

                if (playerPhase2) {
                    throw new Error("You've already guessed for this card!")
                }
                await prisma.phase2.create({
                    data: {
                        wallet: account,
                        guess1: guess
                    }
                })
                break;
            case "2":
                if (playerPhase1.card2value == 0) {
                    throw new Error("You never played step 2 of phase 1");
                }
                cardPlayers = await prisma.phase1.count({ where: { card1value: playerPhase1.card2value } });
                percentage = guess / cardPlayers;
                if (playerPhase2?.guess2 != 0) {
                    throw new Error("You've already guessed for this step!")
                }
                await prisma.phase2.update({
                    where: { wallet: account },
                    data: {
                        guess2: guess
                    }
                })
                break;
            case "3":
                if (playerPhase1.card3value == 0) {
                    throw new Error("You never played step 3 of phase 1");
                }
                cardPlayers = await prisma.phase1.count({ where: { card1value: playerPhase1.card3value } });
                percentage = guess / cardPlayers;
                if (playerPhase2?.guess3 != 0) {
                    throw new Error("You've already guessed for this step!")
                }
                await prisma.phase2.update({
                    where: { wallet: account },
                    data: {
                        guess3: guess
                    }
                })
                break;
            case "4":
                if (playerPhase1.card4value == 0) {
                    throw new Error("You never played step 4 of phase 1");
                }
                cardPlayers = await prisma.phase1.count({ where: { card1value: playerPhase1.card4value } });
                percentage = guess / cardPlayers;
                if (playerPhase2?.guess4 != 0) {
                    throw new Error("You've already guessed for this step!")
                }
                await prisma.phase2.update({
                    where: { wallet: account },
                    data: {
                        guess4: guess
                    }
                })
                break;
            default:
                throw new Error("Invalid URL!")
        }
        if (percentage > 0.1) {
            throw new Error(`Your guess was ${guess} which is not within 10% of the actual number.`)
        } else if (percentage > 0.05) {
            await prisma.player.update({
                where: {
                    wallet: account
                },
                data: {
                    points: { increment: 1 }
                }
            })
            throw new Error(`You guessed within 10%. You get 1 point`);
        } else if (percentage > 0.01) {
            await prisma.player.update({
                where: {
                    wallet: account
                },
                data: {
                    points: { increment: 3 }
                }
            })
            throw new Error(`You guessed within 5%. You get 3 points`);
        } else if (percentage >= 0) {
            await prisma.player.update({
                where: {
                    wallet: account
                },
                data: {
                    points: { increment: 5 }
                }
            })
            throw new Error(`You guessed within 1%. You get 5 points`);
        }
    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})

/**
 * Phase 2: Review 
 * They can see how many points they have 
 */
app.get("/2/review", async (c) => {
    let buttons: ActionGetResponse = {
        icon: `${url}/public/bus.webp`,
        title: "Phase 2 Review",
        description: `Review how many points you have`,
        label: "Review",
    }

    return c.json(buttons);
})

app.post("/2/review", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You never registered!") }

        throw new Error(`You currently have ${user.points} points.`)
    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})

/** Phase 2 */

/** Phase 3 */

/**
 * Phase 3: Review
 * Players can check if they are {Winner, Average, Loser}
 * If they are loser, they can spend bonk to play ride-the-bus over and over again
 * They must guess ALL FOUR right to get their original investment back + the new bonk they've contributed
 */

app.get('/3/review', async (c) => {
    let buttons: ActionGetResponse = {
        icon: `${url}/public/bus.webp`,
        title: "Phase 3 Review",
        description: `Review how many points you have, and if you're currently a WINNER (get a portion of the winning pot), AVERAGE (get 70% of BONK back), or LOSER (get no BONK back). If you're a loser you can play Ride the Bus again and if you get all four right, you'll get a point. You can play until your deck runs out of cards or you run out of BONK`,
        label: "Review",
    }

    return c.json(buttons);
})

app.post("/3/review", async (c) => {
    const { account } = await c.req.json();
    const accountKey = new PublicKey(account);
    try {
        const user = await prisma.player.findFirst({ where: { wallet: account } });
        if (!user) { throw new Error("You never registered!") }
        const highestPointTotal = (await prisma.player.findMany({
            orderBy: {
                points: "desc"
            },
            take: 1
        }))[0].points;
        const winningPlayers = await prisma.player.count({ where: { points: { equals: highestPointTotal } } })
        const lowestPointTotal = (await prisma.player.findMany({
            orderBy: {
                points: "asc"
            },
            take: 1
        }))[0].points;

        if (user.points == highestPointTotal) {
            throw new Error(`You are currently in the winning pool, there's ${winningPlayers} total winning players.`)
        } else if (user.points == lowestPointTotal) {
            throw new Error(`You are currently in the losing pool.`)
        }

    } catch (e: any) {
        const error: ActionError = { message: e.message }
        return c.json(error, 400);
    }
})

/**
 * Phase 3: Red/Black
 */

/**
 * Phase 3: High/Low
 */

/**
 * Phase 3: Inside/Outside
 */

/**
 * Phase 3: Suit
 */

/** Phase 3 */

serve({
    fetch: app.fetch,
    port: Number(process.env.PORT) || 3000
})
console.log(`Hono running on port ${process.env.PORT || 3000}`);
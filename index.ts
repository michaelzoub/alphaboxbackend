import axios from 'axios'
import { connectToDatabase } from './services/mongo'
console.log("Hello via Bun!")

const allowedOrigins = ["http://localhost:3000"]

const discordWebhook = "https://discord.com/api/webhooks/1316531594659364924/vCcj1Nz5-ZIoqbiXI54MogUKW7RZamFlY8d0OKXvOd3xBV-HE67AjDil-8v0SwZg_0-W"
const websocketEndpoint = ["ws://localhost:8900", "wss://api.mainnet-beta.solana.com"]

let subscriptions = new Set()
let socket: any

let initial_message:boolean = true
let subscriptionSent: boolean = false

const caArray = new Set()

async function sendToDiscordBot(contractAddress:string) {
    try {
        await axios.post(discordWebhook, {
            username: 'Nibba Tracker',
            content: `**Note:** Insider new buy. [Click here to view the Contract Address](https://dexscreener.com/solana/${contractAddress})`
        })
        console.log("Message sent to discord")
    } catch (error) {
        console.error(error)
    }
}

function generate_unique_id() {
    const date = Date.now()
    const random = Math.random() * 4324
    const unique_id = Number(Math.floor(date * random).toString().slice(0, 7))
    console.log("Unique id: ", unique_id)
    return unique_id
}

async function database(address:any, id:number): Promise<boolean> {
    try {
        console.log(address)
        const { db } = await connectToDatabase()
        const collection = db.collection("tracker")
        const existingDoc = await collection.findOne({ address: address })
        if (existingDoc) {
            console.error("Error")
            return false
        } 
        await collection.insertOne({ address: address, id: id })
        return true
    } catch (error) {
        console.error(error)
        return false
    }
}

function verifyIfSale(pre: any, post: any, address: string): string {
    let preObject: any
    let postObject: any
    for (let i = 0; i < pre.length; i++) {
        if (pre[i].owner.includes(address)) {
            const amount = pre[i].uiTokenAmount.uiAmount
            const ca = pre[i].mint
            preObject = { type: "pre", amount: amount, ca: ca }
        }
        if (post[i].owner.includes(address)) {
            const amount = post[i].uiTokenAmount.uiAmount
            const ca = post[i].mint
            postObject = { type: "pre", amount: amount, ca: ca }
        }
    }
    if (preObject?.amount < postObject?.amount) {
        return postObject.ca
    } else {
        return ""
    }
}

async function fetchTransaction(transaction: string, id: number, address: string) {
    const data = {
        jsonrpc: "2.0",
        id: id,
        method: "getTransaction",
        params: [
            transaction,
            {
                encoding: "json",
                maxSupportedTransactionVersion: 0
              }
        ]
    }
    const response = await fetch("https://api.mainnet-beta.solana.com", {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data)
    })
    const body = await response.json()
    console.log(body)
    const post_balances = body.result.meta.postTokenBalances
    const pre_balances = body.result.meta.preTokenBalances
    //verify before and after to check if it's a sale or a buy
    const ca = verifyIfSale(pre_balances, post_balances, address)
    caArray.add(ca)
    if (!ca) {
        console.log("This is a sale.")
        return
    }
    console.log("TRANSACTION MESSAGE: ", body.result.transaction.message)
    //first account key is the user's address, third is the pair address
    console.log("STATUS: ", body.result.meta.status)
    return ca
}

function sendSubscription(subscription: any, socket: any) {
    subscription ? "" : socket.send(JSON.stringify(subscription))
    subscriptionSent = true
    return
}

class WebSocketManager {
    private socket: WebSocket | null = null;
    private activeSubscriptions = new Set<string>();
    private notificationTracker = new Set<string>();
    private isConnected = false;

    constructor() {
        // Add logging when instance is created
        console.log('WebSocket Manager initialized');
    }

    async connect() {
        try {
            if (this.socket?.readyState === WebSocket.OPEN) {
                console.log('WebSocket already connected');
                return;
            }

            console.log('Attempting to connect to WebSocket...');
            this.socket = new WebSocket(websocketEndpoint[1]);
            this.setupEventListeners();

            // Re-subscribe to all active subscriptions after reconnect
            this.resubscribeAll();
        } catch (error) {
            console.error('WebSocket connection error:', error);
        }
    }

    private setupEventListeners() {
        if (!this.socket) return;

        this.socket.addEventListener('open', () => {
            console.log('WebSocket connected');
            this.isConnected = true;
            this.resubscribeAll();
        });

        this.socket.addEventListener('message', async (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('Received message type:', data.method || 'unknown');

                if (data.method === "logsNotification") {
                    const signature = data.params?.result?.value?.signature;
                    const logs = data.params?.result?.value?.logs;
                    console.log('Processing transaction:', signature);
                    console.log('Associated logs:', logs);

                    // Log which address triggered this notification
                    const relevantAddress = this.findRelevantAddress(logs);
                    console.log('Relevant address:', relevantAddress);

                    if (signature) {
                        await this.processTransaction(signature, relevantAddress);
                    }
                }
            } catch (error) {
                console.error('Error processing message:', error);
            }
        });

        this.socket.addEventListener('close', () => {
            console.log('WebSocket disconnected');
            this.isConnected = false;
            // Attempt to reconnect after delay
            setTimeout(() => this.connect(), 5000);
        });

        this.socket.addEventListener('error', (error) => {
            console.error('WebSocket error:', error);
        });
    }

    async addSubscription(contractAddress: string) {
        console.log('Adding subscription for:', contractAddress);
        
        if (this.activeSubscriptions.has(contractAddress)) {
            console.log('Address already subscribed:', contractAddress);
            return;
        }

        this.activeSubscriptions.add(contractAddress);
        console.log('Current active subscriptions:', Array.from(this.activeSubscriptions));

        if (!this.isConnected) {
            await this.connect();
        }

        const subscription = {
            jsonrpc: "2.0",
            id: generate_unique_id(),
            method: "logsSubscribe",
            params: [
                { mentions: [contractAddress] },
                { commitment: "finalized" }
            ]
        };

        try {
            this.socket?.send(JSON.stringify(subscription));
            console.log('Subscription sent for:', contractAddress);
        } catch (error) {
            console.error('Error sending subscription:', error);
            this.activeSubscriptions.delete(contractAddress);
        }
    }

    private async processTransaction(signature: string, address: string) {
        try {
            const ca = await fetchTransaction(signature, generate_unique_id(), address);
            
            if (ca && !this.notificationTracker.has(ca)) {
                console.log('Sending notification for:', ca);
                await sendToDiscordBot(ca);
                this.notificationTracker.add(ca);
            }
        } catch (error) {
            console.error('Error processing transaction:', error);
        }
    }

    private async resubscribeAll() {
        console.log('Resubscribing to all addresses...');
        for (const address of this.activeSubscriptions) {
            await this.addSubscription(address);
        }
    }

    // Helper to find which address triggered the notification
    private findRelevantAddress(logs: string[]): string {
        for (const address of this.activeSubscriptions) {
            if (logs.some(log => log.includes(address))) {
                return address;
            }
        }
        return '';
    }

    // Debug method to check current state
    getStatus() {
        return {
            isConnected: this.isConnected,
            activeSubscriptions: Array.from(this.activeSubscriptions),
            notificationsSent: Array.from(this.notificationTracker)
        };
    }
}

// Create single instance
const wsManager = new WebSocketManager();

Bun.serve({
    port: 3001,
    async fetch(req, server) {
        const headers = {
            "Access-Control-Allow-Origin": "https://alphabox-five.vercel.app",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          }
        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers });
        }
        console.log("HIT")
        if (req.method == "POST") {
            try {
                console.log("POST hit.")
                const contractAddress = await req.json()
                console.log('Received subscription request for:', contractAddress);

                await wsManager.addSubscription(contractAddress);
                
                // Add endpoint to check status
                if (req.url.endsWith('/status')) {
                    return new Response(JSON.stringify(wsManager.getStatus()), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                return new Response("Subscribed to contract: " + contractAddress);
            } catch (error) {
                console.error("Error in request handler:", error);
                return new Response("Error processing request", { status: 500 });
            }
        }
        if (server.upgrade(req)) {
            return
        }
        return new Response("Upgrade failed", {status: 500})
    },
    websocket: {
        message(ws, message:any) {
            ws.send(message)
            console.log("maybe sending message here?")
            //discord logic
        },
        open(ws) {
            //set up connection to targeted websockets on open!
            console.log("Websocket opened: ", ws)
            //this should essentially receive messages from solana
        },
        close (ws, code, message) {
            console.log("Websocket closed: ", message)
        },
        drain(ws) {}
    },
})
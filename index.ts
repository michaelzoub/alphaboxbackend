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

let transaction_detailed_info: any

async function sendToDiscordBot(contractAddress:string) {
    try {
        await axios.post(discordWebhook, {
            username: 'Nibba Tracker',
            content: `**Insider new buy. Here's the CA: ${contractAddress}**`
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
    if (!ca) {
        console.log("This is a sale.")
        return
    }
    console.log("TRANSACTION MESSAGE: ", body.result.transaction.message)
    //first account key is the user's address, third is the pair address
    console.log("STATUS: ", body.result.meta.status)
    transaction_detailed_info = body
    return ca
}

function sendSubscription(subscription: any, socket: any) {
    subscription ? "" : socket.send(JSON.stringify(subscription))
    subscriptionSent = true
    return
}

Bun.serve({
    port: 3001,
    async fetch(req, server) {
        const headers = {
            "Access-Control-Allow-Origin": "*",  
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS", 
            "Access-Control-Allow-Headers": "Content-Type", 
        }
        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers });
        }
        console.log("HIT")
        if (req.method == "POST") {
            try {
                console.log("POST hit.")
                const contractAddress = await req.json()
                console.log(contractAddress)
                subscriptions.add(contractAddress)
                if (!socket) {
                    socket = new WebSocket(websocketEndpoint[1])
                }
                console.log("This is the socket: ", socket)
                const unique_id: number = generate_unique_id()
                const subscription = {
                    jsonrpc: "2.0",
                    id: unique_id,
                    method: "logsSubscribe",
                    params: [
                      {
                        mentions: [contractAddress],
                      },
                      {
                        commitment: "finalized",
                      },
                    ],
                  }
                console.log("Subscribed: ", subscription)
                if (socket && socket.readyState === WebSocket.OPEN) {
                    console.log("socket ready and sending subscription format: ")
                }
                //add to database:
                if (!database) {
                    console.log("no database")
                    //return
                }
                socket.addEventListener("open", (event:any) => {
                    console.log("Ws opened: ", event)
                    socket.send(JSON.stringify(subscription))
                    subscriptionSent = true
                    console.log("Sent to Solana")
                    //ping/pong mechanism
                    setInterval(() => {
                        socket.send(JSON.stringify({ data: { type: "ping" } }))
                    }, 50000)
                })
                socket.addEventListener("message", (event:any) => {
                    try {
                        const data = JSON.parse(event.data)
                        if (data.type == "ping") {
                            console.log("Ping")
                            socket.send(JSON.stringify({ type: "pong" }))
                        }
                        if (data.type == "pong") {
                            console.log("PING PONG.")
                        }
                        //check if swap, then check if it's a buy and if it is, send to discord bot
                        console.log("Event detected: ", event)
                        if (data.method === "logsNotification") {
                            try {
                                const signature = data.params?.result?.value?.signature
                                console.log("ALL DATA: ", data)
                                console.log("PARAMS DATA: ", data.params)
                                console.log(signature)
                                fetchTransaction(signature, unique_id, contractAddress)
                                .then((info: any) => {
                                    console.log("Info before sending to discord bot: ", info)
                                    sendToDiscordBot(info)
                                })
                                .catch((error) => {
                                    console.error(error)
                                })
                            } catch (error) {
                                console.log("Wrong message: ", error)
                            }
                        }
                        initial_message = false
                    } catch (error) {
                        console.error(error)
                    }
                })
                socket.addEventListener("error", (event:any) => {
                    console.log("Error: ", event)
                })
                socket.addEventListener("close", (event:any) => {
                    console.error(event)
                    socket = new WebSocket(websocketEndpoint[1])
                    socket.send(JSON.stringify(subscription))
                })

                console.log(`Subscribed to contract address.`)
                return new Response("Subscribed to contract: " + contractAddress)
            } catch (error) {
                console.log("Errors")
                console.error(error)
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
            sendToDiscordBot(message)
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
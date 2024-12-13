import { MongoClient } from 'mongodb';

const MONGODB_URI:any = process.env.MONGO_URI
const MONGODB_DB = "wallet"

let cachedClient:any = null;
let cachedDb:any = null;
let client:any;
let db:any;

export async function connectToDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  try {
    client = await MongoClient.connect(MONGODB_URI);
    db = client.db(MONGODB_DB);

    cachedClient = client;
    cachedDb = db;

    return { client, db };
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}


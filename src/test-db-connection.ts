
import { DbService } from './db.js';

async function testConnection() {
    console.log('Testing DB Service...');
    const db = new DbService();
    try {
        await db.connect();
        console.log('✅ Connected successfully');

        // Try a simple query
        await db.disconnect();
        console.log('✅ Disconnected successfully');
    } catch (err) {
        console.error('❌ Connection failed:', err);
    }
}

testConnection();

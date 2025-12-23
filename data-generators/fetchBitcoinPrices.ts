import * as fs from 'node:fs';
import * as path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import BitcoinDataFetcher from '../src-vue/lib/BitcoinDataFetcher.ts';

dayjs.extend(utc);

// API endpoint for fetching Bitcoin price data
const START_DATE = '2025-01-01'; // First known price date
const TODAY = dayjs.utc().format('YYYY-MM-DD'); // Current date in YYYY-MM-DD format

export default async function fetchBitcoinPrices() {
  const data = await BitcoinDataFetcher.fetchPrices(START_DATE, TODAY);

  // Write data to JSON file
  const filePath = path.join(process.cwd(), 'core', 'src', 'data', 'bitcoinPrices.json');
  console.log(`Writing data to: ${filePath}`);

  const fileDir = path.dirname(filePath);
  if (!fs.existsSync(fileDir)) {
    console.log(`Creating directory: ${fileDir}`);
    fs.mkdirSync(fileDir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Successfully saved ${data.length} Bitcoin price data points to bitcoinPrices.json`);
}

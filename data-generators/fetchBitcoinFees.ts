import * as fs from 'node:fs';
import * as path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import BitcoinDataFetcher from '../src-vue/lib/BitcoinDataFetcher.ts';

dayjs.extend(utc);

const START_DATE = '2025-01-01';
const TODAY = dayjs.utc().format('YYYY-MM-DD');

export default async function fetchBitcoinFeeData() {
  const data = await BitcoinDataFetcher.fetchFees(START_DATE, TODAY);
  const filePath = path.join(process.cwd(), 'core', 'src', 'data', 'bitcoinFees.json');
  const fileDir = path.dirname(filePath);
  if (!fs.existsSync(fileDir)) {
    fs.mkdirSync(fileDir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2)+"\n");
  console.log('Data saved to bitcoinFees.json');
}

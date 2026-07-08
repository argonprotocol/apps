import { fetchBitcoinPrices } from './fetchBitcoinPrices.ts';
import { fetchBitcoinFees } from './fetchBitcoinFees.ts';

async function main() {
  console.log('Starting bitcoin fetch process...');

  try {
    console.log('Fetching Bitcoin prices...');
    await fetchBitcoinPrices();

    console.log('Fetching Bitcoin fees per transaction...');
    await fetchBitcoinFees();

    console.log('All bitcoin fetch operations completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error in bitcoin fetch process:', error);
    process.exit(1);
  }
}

// Execute the main function
main();

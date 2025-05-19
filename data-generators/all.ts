import fetchBitcoinPrices from './fetchBitcoinPrices.ts';
import fetchBitcoinFees from './fetchBitcoinFees.ts';

async function main() {
  console.log('Starting data fetch process...');
  
  try {
    console.log('Fetching Bitcoin prices...');
    await fetchBitcoinPrices();
    
    console.log('Fetching Bitcoin fees per transaction...');
    await fetchBitcoinFees();
    
    console.log('All data fetch operations completed successfully!');
  } catch (error) {
    console.error('Error in data fetch process:', error);
    process.exit(1);
  }
}

// Execute the main function
main();

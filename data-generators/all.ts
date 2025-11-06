import fetchBitcoinPrices from './fetchBitcoinPrices.ts';
import fetchBitcoinFees from './fetchBitcoinFees.ts';
import fetchVaultRevenue from './fetchVaultRevenue.ts';

async function main() {
  console.log('Starting data fetch process...');

  try {
    console.log('Fetching Bitcoin prices...');
    await fetchBitcoinPrices();

    console.log('Fetching Bitcoin fees per transaction...');
    await fetchBitcoinFees();

    console.log('Fetching Vault revenue...');
    await fetchVaultRevenue();

    console.log('All data fetch operations completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error in data fetch process:', error);
    process.exit(1);
  }
}

// Execute the main function
main();

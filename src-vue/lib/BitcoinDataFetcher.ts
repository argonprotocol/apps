import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

const FEE_URL = 'https://api.blockchain.info/charts/transaction-fees';
const TX_COUNT_URL = 'https://api.blockchain.info/charts/n-transactions';

interface IDataPoint {
  x: number;
  y: number;
}

interface IApiError {
  response?: {
    data: string;
  };
  message: string;
}

const BASE_URL = 'https://api.blockchain.info/charts/market-price';

interface BitcoinDataPoint {
  x: number;
  y: number;
}

interface BlockchainInfoResponse {
  values: BitcoinDataPoint[];
  status: string;
  name: string;
  unit: string;
  period: string;
  description: string;
}

export default class BitcoinDataFetcher {
  public static async fetchFees(startDate: string, endDate: string) {
    try {
      const [feeData, txCountData] = await Promise.all([
        fetchData(FEE_URL, startDate, endDate),
        fetchData(TX_COUNT_URL, startDate, endDate),
      ]);

      const data: { date: string; feeInBitcoins: number }[] = [];
      let lastNonZeroFee = 0;

      feeData.forEach((feeItem, index) => {
        const date = dayjs
          .utc(feeItem.x * 1000)
          .toISOString()
          .split('T')[0];
        let totalFeeBTC = feeItem.y;
        const txCount = txCountData[index].y;

        if (totalFeeBTC === 0 && lastNonZeroFee !== 0) {
          totalFeeBTC = lastNonZeroFee;
        } else if (totalFeeBTC !== 0) {
          lastNonZeroFee = totalFeeBTC;
        }

        const feePerTx = txCount > 0 ? totalFeeBTC / txCount : 0;
        data.push({
          date,
          feeInBitcoins: Number(feePerTx.toFixed(8)),
        });
      });

      return data;
    } catch (error: unknown) {
      const apiError = error as IApiError;
      console.error('Error fetching data:', apiError.response ? apiError.response.data : apiError.message);
      throw error; // Re-throw to ensure the process fails if there's an error
    }
  }

  public static async fetchPrices(startDate: string, endDate: string) {
    try {
      console.log('Starting Bitcoin data fetch...');
      console.log(`Date range: ${startDate} to ${endDate}`);

      // Make API request to fetch Bitcoin price data
      const params = new URLSearchParams({
        timespan: 'all',
        start: startDate,
        end: endDate,
        format: 'json',
        sampled: 'false', // Request all data points without sampling
      });

      console.log(`Fetching data from: ${BASE_URL}?${params}`);
      const response = await fetch(`${BASE_URL}?${params}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      console.log('Response received, parsing JSON...');
      const responseData = (await response.json()) as BlockchainInfoResponse;

      if (!responseData.values || !Array.isArray(responseData.values)) {
        throw new Error('Invalid response format: missing or invalid values array');
      }

      console.log(`Received ${responseData.values.length} data points from API`);
      const data: { millis: number; date: string; price: number }[] = [];

      // Process each data point
      responseData.values.forEach((item, index) => {
        // Skip the first item if it has no price (y value)
        if (Object.values(data).length === 0 && !item.y) return;

        // Convert Unix timestamp to Date object and format as YYYY-MM-DD
        const date = dayjs.utc(item.x * 1000); // Subtract 1 hour to adjust for timezone
        const dateStr = date.toISOString().split('T')[0];

        // Add formatted row to data record
        data.push({
          millis: item.x,
          date: dateStr,
          price: item.y,
        });
      });

      console.log(`Processed ${data.length} valid data points`);

      if (data.length === 0) {
        throw new Error('No valid data points found in the response');
      }

      return data;
    } catch (error) {
      console.error('Error fetching data:', error instanceof Error ? error.message : String(error));
      throw error; // Re-throw to ensure the process fails if there's an error
    }
  }
}

async function fetchData(url: string, startDate: string, endDate: string): Promise<IDataPoint[]> {
  const params = new URLSearchParams({
    timespan: 'all',
    start: startDate,
    end: endDate,
    format: 'json',
    sampled: 'false', // Request all data points
  });

  const response = await fetch(`${url}?${params}`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const data = (await response.json()) as { values: IDataPoint[] };
  return data.values;
}

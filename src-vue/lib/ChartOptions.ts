import type { Dayjs } from 'dayjs';
import type { ChartConfiguration } from 'chart.js';

export function createChartOptions(
  startDate: Dayjs,
  endDate: Dayjs,
  fillerPoints: { x: number; y: number }[],
  chartPoints: { x: number; y: number | null }[],
): ChartConfiguration<'line', { x: number; y: number | null }[]> {
  return {
    type: 'line',
    data: {
      datasets: [
        {
          data: fillerPoints,
          borderColor: '#F8E7FB',
          borderWidth: 5,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.2,
        },
        {
          data: chartPoints,
          borderColor: '#A600D4',
          borderWidth: 4,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.2,
        },
      ],
    },
    options: {
      events: [],
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          display: false,
          type: 'time',
          time: { unit: 'day' },
          min: startDate.valueOf(),
          max: endDate.valueOf(),
        },
        y: { display: false, min: -100, max: 210 },
      },
      clip: false,
    },
  };
}

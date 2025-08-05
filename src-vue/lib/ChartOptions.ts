import dayjs from 'dayjs';
import { Interaction, TooltipModel } from 'chart.js';
import { getRelativePosition } from 'chart.js/helpers';

(Interaction.modes as any).myCustomMode = function (chart: any, e: any) {
  const position = getRelativePosition(e, chart);

  const items: any[] = [];
  Interaction.evaluateInteractionItems(chart, 'x', position, (element, datasetIndex, index) => {
    const xDistanceFromPoint = Math.abs(position.x - element.x);
    const yDistanceFromPoint = Math.abs(position.y - element.y);
    if (yDistanceFromPoint < 30 && xDistanceFromPoint < 30) {
      items.push({ element, datasetIndex, index });
    }
  });
  return items;
};

export function createFillerPoints(chartPoints: any[]) {
  if (chartPoints.length === 0 || chartPoints.length >= 365) return [];

  const startDate = dayjs('2025-01-01').valueOf();
  const fillerPoints = [{ x: startDate, y: 0 }];
  fillerPoints.push({ x: chartPoints[0].x, y: 0 });
  return fillerPoints;
}

export function createChartOptions(fillerPoints: any[], chartPoints: any[], pointRadius: number[], onTooltipFn: any) {
  return {
    type: 'line',
    data: {
      datasets: [
        {
          data: fillerPoints,
          borderColor: '#F8E7FB',
          borderWidth: 5,
          pointBorderColor: '#F8E7FB',
          pointBorderWidth: 0,
          pointBackgroundColor: '#F8E7FB',
          pointHoverRadius: 0,
          pointHoverBackgroundColor: '#F8E7FB',
          pointRadius: 0,
          lineTension: 1,
        },
        {
          data: chartPoints,
          borderColor: '#A600D4',
          borderWidth: 4,
          pointBorderColor: 'white',
          pointBorderWidth: 1,
          pointBackgroundColor: '#A600D4',
          pointHoverRadius: 0,
          pointHoverBackgroundColor: '#A600D4',
          pointRadius: pointRadius,
          lineTension: 1,
        },
      ],
    },
    options: {
      plugins: {
        tooltip: {
          backgroundColor: 'white',
          borderColor: '#979797',
          bodyColor: '#4C4C4C',
          titleColor: 'black',
          displayColors: false,
          borderWidth: 1,
          caretSize: 10,
          enabled: false,
          external: (context: any) => onTooltipFn(context.tooltip as TooltipModel<any>),
        },
      },
      interaction: {
        mode: 'myCustomMode',
        intersect: false,
      },
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
        },
      },
      scales: {
        x: {
          display: false,
          type: 'time',
          time: {
            unit: 'day',
          },
          min: dayjs('2025-01-01').valueOf(),
          max: dayjs('2025-12-31').valueOf(),
        },
        y: {
          display: false,
          min: -100,
          max: 210,
        },
      },
      clip: false,
    },
  };
}

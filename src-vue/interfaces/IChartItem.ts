export interface IChartItem {
  id: number;
  date: string;
  score: number;
  isFiller: boolean;
  previous: IChartItem | undefined;
  next: IChartItem | undefined;
}

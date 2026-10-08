export interface IChartItem {
  id: number;
  date: string;
  score: number | null;
  isFiller: boolean;
  previous: IChartItem | undefined;
  next: IChartItem | undefined;
}

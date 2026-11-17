/**
 * O substituto local de `@barte-ai-services/barte-ui-kit` (0.2.0), pacote privado do GitHub Packages que este
 * fork não lê (#53). O `vite.config.ts` e o `tsconfig.json` apontam para cá só quando o pacote real não está
 * instalado. Só a superfície que a tela usa; o teste `test/stand-ins.test.ts` (#53/AC-3) fecha o que falta.
 */
export { toneColor, type Tone } from "./tone";
export { formatCurrency, formatIsoDate } from "./format";
export {
  AiSourceBadge,
  Block,
  DataList,
  InlineEmpty,
  PageTitleBar,
  Panel,
  Stat,
  StatGrid,
  StatusBadge,
  type AiSourceBadgeProps,
  type BlockProps,
  type DataListItem,
  type DataListProps,
  type PageTitleBarProps,
  type PanelProps,
  type StatProps,
  type StatusBadgeProps,
} from "./display";
export { LoadFeedback, type LoadFeedbackProps, type LoadState } from "./LoadFeedback";
export {
  LineChart,
  ProgressBar,
  RankingBars,
  Timeline,
  type LineChartProps,
  type LineSeries,
  type ProgressBarProps,
  type ProgressSegment,
  type RankingBarsProps,
  type RankingItem,
  type TimelineItem,
} from "./charts";
export { ReconciliationDiff, type ComparisonField, type ComparisonState, type ReconciliationDiffProps } from "./ReconciliationDiff";
export { SegmentedFilter, type SegmentedFilterProps, type SegmentedOption } from "./SegmentedFilter";
export { DecisionForm, type DecisionFormProps, type DecisionFormTexts, type DecisionOption } from "./DecisionForm";

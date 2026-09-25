export const ANNOTATION_COLORS = [
  { name: 'Red', value: '#FF3B30' },
  { name: 'Orange', value: '#FF9500' },
  { name: 'Yellow', value: '#FFCC00' },
  { name: 'Green', value: '#34C759' },
  { name: 'Blue', value: '#007AFF' },
  { name: 'Purple', value: '#AF52DE' },
  { name: 'White', value: '#FFFFFF' },
] as const;

export const DEFAULT_ANNOTATION_COLOR = ANNOTATION_COLORS[0].value;
export const DEFAULT_ANNOTATION_WIDTH = 3;
export const MIN_ANNOTATION_WIDTH = 1;
export const MAX_ANNOTATION_WIDTH = 10;
export const ANNOTATION_REFERENCE_WIDTH = 1000;

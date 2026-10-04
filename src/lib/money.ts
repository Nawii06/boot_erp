import { AppError } from './errors.ts';

const MAX = 9223372036854775807n;
const MIN = -9223372036854775808n;
export function won(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d{0,18})$/.test(value)) throw new AppError('INVALID_INPUT');
  return checkedWon(BigInt(value));
}
export function checkedWon(value: bigint): bigint {
  if (value < MIN || value > MAX) throw new AppError('INVALID_INPUT');
  return value;
}
export function sumWon(values: readonly bigint[]): bigint {
  return checkedWon(values.reduce((sum, value) => sum + checkedWon(value), 0n));
}
export function jsonValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? checkedWon(item).toString() : item);
}

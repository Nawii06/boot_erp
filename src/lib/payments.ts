import { AppError } from './errors.ts';
import { checkedWon, won } from './money.ts';
import { textInput } from './validation.ts';

export const externalAttemptKinds = { submitted:'실청구 등록',rejected:'반려 기록',resubmitted:'재상신 기록' } as const;
export function paymentDate(value:unknown):string {
  const date=textInput(value,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new AppError('INVALID_INPUT');
  return date;
}
export function paymentAmounts(input:Record<string,unknown>) {
  const gross=won(input.grossAmount),withheld=won(input.withheldAmount),net=won(input.netAmount);
  if(gross<=0n||withheld<0n||net<0n||checkedWon(withheld+net)!==gross)throw new AppError('INVALID_INPUT');
  return {gross:gross.toString(),withheld:withheld.toString(),net:net.toString()};
}
export function refundAmount(value:unknown):string {
  const amount=won(value);if(amount<=0n)throw new AppError('INVALID_INPUT');return amount.toString();
}

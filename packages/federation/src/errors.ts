export class DurableTurnRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}

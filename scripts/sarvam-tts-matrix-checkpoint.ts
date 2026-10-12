export function recordMatrixCompletion<T>(
  records: Array<T | undefined>,
  index: number,
  record: T,
  persist: (records: readonly (T | undefined)[]) => void,
): void {
  records[index] = record;
  persist(records);
}

export function recordMatrixArtifactCompletion<T>(
  records: Array<T | undefined>,
  index: number,
  pendingRecord: T,
  passedRecord: T,
  writeArtifact: () => void,
  persist: (records: readonly (T | undefined)[]) => void,
): void {
  records[index] = pendingRecord;
  persist(records);
  writeArtifact();
  records[index] = passedRecord;
  persist(records);
}

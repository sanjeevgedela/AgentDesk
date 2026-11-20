// Paste into a QuickNode Solana block stream and replace with the public signer address.
function main(stream) {
  const signer = "REPLACE_WITH_PUBLIC_MEMO_SIGNER";
  const memoPrograms = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
  const signatures = [];
  for (const block of stream.data ?? []) {
    for (const entry of block?.transactions ?? []) {
      if (entry.meta?.err) continue;
      const { message, signatures: ids } = entry.transaction ?? {};
      const keys = (message?.accountKeys ?? []).map(key => typeof key === "string" ? key : key.pubkey);
      const invokesMemo = message?.instructions?.some(instruction =>
        memoPrograms.has(instruction.programId ?? keys[instruction.programIdIndex]));
      if (ids?.[0] && keys.includes(signer) && invokesMemo) signatures.push(ids[0]);
    }
  }
  return signatures.length ? { signatures } : null;
}

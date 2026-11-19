import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { accountConverter, encodeAccountDetailsPatch, type Account, type AccountInput, type AccountType } from './types';

export const accountsCol = () => collection(db, 'accounts').withConverter(accountConverter);

export interface ListAccountsFilters {
  ownerId: string;
  type?: AccountType;
  includeArchived?: boolean;
}

export async function listAccounts(filters: ListAccountsFilters): Promise<Account[]> {
  const snap = await getDocs(accountsQuery(filters));
  return accountRows(snap.docs.map((d) => d.data()), filters.includeArchived === true);
}

function accountsQuery(filters: ListAccountsFilters) {
  const constraints = [where('ownerId', '==', filters.ownerId), orderBy('name', 'asc')];
  if (filters.type) constraints.splice(1, 0, where('type', '==', filters.type));
  return query(accountsCol(), ...constraints);
}

function accountRows(rows: Account[], includeArchived: boolean): Account[] {
  return rows.filter((account) => includeArchived || account.active !== false);
}

export function subscribeAccounts(
  filters: ListAccountsFilters,
  onData: (rows: Account[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    accountsQuery(filters),
    (snapshot) => onData(accountRows(snapshot.docs.map((item) => item.data()), filters.includeArchived === true)),
    onError,
  );
}

export async function createAccount(input: AccountInput): Promise<string> {
  const now = new Date();
  const ref = await addDoc(accountsCol(), {
    ...input,
    id: '',
    active: input.active,
    archivedAt: input.archivedAt ?? null,
    balanceUpdatedAt: input.balanceUpdatedAt ?? now,
    createdAt: now,
    updatedAt: now,
  } as Account);
  return ref.id;
}

export async function updateAccount(id: string, patch: Partial<AccountInput>): Promise<void> {
  const out: Record<string, unknown> = {
    ...patch,
    updatedAt: Timestamp.fromDate(new Date()),
  };
  if (patch.archivedAt) out.archivedAt = Timestamp.fromDate(patch.archivedAt);
  if (patch.balanceUpdatedAt) out.balanceUpdatedAt = Timestamp.fromDate(patch.balanceUpdatedAt);
  if ('lastReconciledAt' in patch) out.lastReconciledAt = patch.lastReconciledAt ? Timestamp.fromDate(patch.lastReconciledAt) : null;
  if (patch.loan?.nextDueDate) {
    out.loan = {
      ...patch.loan,
      nextDueDate: Timestamp.fromDate(patch.loan.nextDueDate),
    };
  }
  Object.assign(out, encodeAccountDetailsPatch({ insurance: patch.insurance, pension: patch.pension }));
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  await updateDoc(doc(db, 'accounts', id), out);
}

export async function archiveAccount(id: string): Promise<void> {
  const now = new Date();
  await updateDoc(doc(db, 'accounts', id), {
    active: false,
    archivedAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
  });
}

import type { Db } from '../db/db.js';
import type { User } from './sessions.js';

export type CaseRole = 'owner' | 'editor' | 'viewer';

export interface CaseAccess {
  read: boolean;
  edit: boolean;
  manage: boolean;
  role: CaseRole | 'admin' | 'open' | null;
}

export interface CaseRow {
  id: string;
  restricted: number;
  archived_at: string | null;
}

/**
 * Global roles: admin (everything), analyst (edit every open case, membership on restricted
 * ones), viewer (read every open case). A case is "open" unless `restricted` is set, in
 * which case only members get in.
 */
export function caseAccess(db: Db, user: User, c: CaseRow): CaseAccess {
  if (user.role === 'admin')
    return { read: true, edit: !c.archived_at, manage: true, role: 'admin' };
  const m = db.get<{ role: CaseRole }>(
    'SELECT role FROM case_members WHERE case_id = ? AND user_id = ?',
    c.id,
    user.id,
  );
  const memberRole = m?.role ?? null;
  const archived = !!c.archived_at;
  if (memberRole === 'owner') return { read: true, edit: !archived, manage: true, role: 'owner' };
  if (memberRole === 'editor')
    return { read: true, edit: !archived && user.role !== 'viewer', manage: false, role: 'editor' };
  if (memberRole === 'viewer') return { read: true, edit: false, manage: false, role: 'viewer' };
  if (c.restricted) return { read: false, edit: false, manage: false, role: null };
  return { read: true, edit: !archived && user.role === 'analyst', manage: false, role: 'open' };
}

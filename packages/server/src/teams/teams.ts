/**
 * Teams: groups of analysts (a host cell, a network cell) with one or more leads. Leads import
 * playbooks, start runs and bulk-assign within the teams they lead; admins can do all of it.
 */
import type { Db } from '../db/db.js';

export type TeamRole = 'lead' | 'member';

export interface TeamMember {
  userId: string;
  role: TeamRole;
  username: string;
  displayName: string;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  members: TeamMember[];
}

interface TeamRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

export function listTeams(db: Db): Team[] {
  const teams = db.all<TeamRow>('SELECT * FROM teams ORDER BY name COLLATE NOCASE');
  const members = db.all<{
    team_id: string;
    user_id: string;
    role: TeamRole;
    username: string;
    display_name: string;
  }>(
    `SELECT m.team_id, m.user_id, m.role, u.username, u.display_name
       FROM team_members m JOIN users u ON u.id = m.user_id
      ORDER BY m.role, u.display_name COLLATE NOCASE`,
  );
  const byTeam = new Map<string, TeamMember[]>();
  for (const m of members) {
    const list = byTeam.get(m.team_id) ?? [];
    list.push({
      userId: m.user_id,
      role: m.role,
      username: m.username,
      displayName: m.display_name,
    });
    byTeam.set(m.team_id, list);
  }
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    createdAt: t.created_at,
    members: byTeam.get(t.id) ?? [],
  }));
}

export function getTeam(db: Db, id: string): Team | null {
  return listTeams(db).find((t) => t.id === id) ?? null;
}

/** Ids of the teams a user leads. */
export function ledTeamIds(db: Db, userId: string): Set<string> {
  return new Set(
    db
      .all<{ team_id: string }>(
        "SELECT team_id FROM team_members WHERE user_id = ? AND role = 'lead'",
        userId,
      )
      .map((r) => r.team_id),
  );
}

/** Ids of the teams a user belongs to, in any role. */
export function memberTeamIds(db: Db, userId: string): Set<string> {
  return new Set(
    db
      .all<{ team_id: string }>('SELECT team_id FROM team_members WHERE user_id = ?', userId)
      .map((r) => r.team_id),
  );
}

/** Everyone on any of these teams. */
export function membersOf(db: Db, teamIds: Iterable<string>): Set<string> {
  const ids = [...teamIds];
  if (ids.length === 0) return new Set();
  return new Set(
    db
      .all<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM team_members WHERE team_id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )
      .map((r) => r.user_id),
  );
}

export function teamIdSet(db: Db): Set<string> {
  return new Set(db.all<{ id: string }>('SELECT id FROM teams').map((r) => r.id));
}

export function memberRole(db: Db, teamId: string, userId: string): TeamRole | null {
  return (
    db.get<{ role: TeamRole }>(
      'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
      teamId,
      userId,
    )?.role ?? null
  );
}

import { Prisma } from '@prisma/client';

/**
 * Accounts an admin marked as internal or test ones (`excludedFromStats`) keep working
 * as usual; they are only left out of what the admin pages count. These two filters
 * are the one place that rule lives, so every count applies it the same way.
 */

/** Where-input for the users that count. */
export const COUNTED_USER: Prisma.UserWhereInput = { excludedFromStats: false };

/**
 * SQL condition that keeps an analytics event unless it belongs to an excluded account.
 *
 * An event can be tied to the account two ways: by its user id, or, for a visit made
 * while signed out, only by the visitor cookie. The second covers a tester who signs
 * out and walks the landing page or the signup again from the same browser, whose
 * events carry no user id at all. A visitor cookie is known to belong to an account
 * once that account signed up with it (user_acquisitions.anonymous_id), so a visit
 * from another browser before signing in still counts.
 *
 * `table` is the alias of analytics_events in the query, written in code, never input.
 */
export function countedEventSql(table: 'analytics_events' | 'e'): Prisma.Sql {
  const userId = Prisma.raw(`${table}.user_id`);
  const anonymousId = Prisma.raw(`${table}.anonymous_id`);
  return Prisma.sql`(${userId} IS NULL OR NOT EXISTS (
    SELECT 1 FROM users excluded
    WHERE excluded.id = ${userId} AND excluded."excludedFromStats"
  )) AND (${anonymousId} IS NULL OR NOT EXISTS (
    SELECT 1 FROM user_acquisitions excluded_visit
    JOIN users excluded ON excluded.id = excluded_visit.user_id
    WHERE excluded_visit.anonymous_id = ${anonymousId} AND excluded."excludedFromStats"
  ))`;
}

import 'server-only';
import type { Pool } from 'pg';
import { AppError } from '../lib/errors.ts';
import { dashboardFilters, dashboardTotals, type DashboardResult, type DashboardLine } from '../lib/dashboard.ts';
import { assertRuntimeRole } from './db.ts';
import { authenticate } from './security.ts';

const membership = `EXISTS (SELECT 1 FROM project_memberships m
  WHERE m.project_id=p.id AND m.user_id=$1 AND m.active
    AND m.starts_at<=CURRENT_TIMESTAMP AND (m.ends_at IS NULL OR m.ends_at>CURRENT_TIMESTAMP))`;
const visibleProject = `($2 IN ('staff','admin') OR ${membership})`;
const visibleWork = `($2 IN ('staff','admin','principal_investigator') OR w.assigned_to=$1)`;
const returnStates:Record<string,DashboardResult['recent'][number]['state']>={
  'application.withdraw':'withdrawn','application.reject':'rejected','application.cancel':'cancelled','application.revise':'revision',
};

/** One authorised snapshot: shared master budgets, role-scoped dated payment facts and current processing state. */
export async function dashboardOverview(pool: Pool, token: string,
  input: Record<string, unknown> | URLSearchParams = {}): Promise<DashboardResult> {
  const filter = dashboardFilters(input);
  const client = await pool.connect();
  let broken = false;
  try {
    // Must precede assertRuntimeRole/authentication queries to establish one snapshot.
    // Authentication takes row locks, so READ ONLY transactions cannot be used here.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assertRuntimeRole(client);
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const actor = await authenticate(client, token);
    const projects = (await client.query(`SELECT p.id,p.name,p.business_year
      FROM projects p WHERE ${visibleProject} ORDER BY p.name,p.id`, [actor.id, actor.role])).rows;
    if (filter.projectId && !projects.some(project => project.id === filter.projectId)) throw new AppError('FORBIDDEN');
    const args = [actor.id, actor.role, filter.projectId, filter.year, filter.from, filter.to];
    const lines: DashboardLine[] = (await client.query(`WITH paid AS (
      SELECT x.budget_line_id,sum(r.gross_amount)::text AS gross,sum(r.withheld_amount)::text AS withheld,sum(r.net_amount)::text AS received
      FROM payment_records r JOIN spend_cases x ON x.id=r.case_id AND x.project_id=r.project_id
      JOIN spend_states s ON s.case_id=x.id JOIN work_items w ON w.id=s.work_id AND w.project_id=s.project_id JOIN projects p ON p.id=s.project_id
      WHERE ${visibleProject} AND ${visibleWork} AND ($3::uuid IS NULL OR p.id=$3) AND ($4::integer IS NULL OR p.business_year=$4)
        AND ($5::date IS NULL OR r.paid_on>=$5) AND ($6::date IS NULL OR r.paid_on<=$6) GROUP BY x.budget_line_id
      ), refunded AS (
      SELECT x.budget_line_id,sum(r.amount)::text AS refunded
      FROM payment_refunds r JOIN spend_cases x ON x.id=r.case_id AND x.project_id=r.project_id
      JOIN spend_states s ON s.case_id=x.id JOIN work_items w ON w.id=s.work_id AND w.project_id=s.project_id JOIN projects p ON p.id=s.project_id
      WHERE ${visibleProject} AND ${visibleWork} AND ($3::uuid IS NULL OR p.id=$3) AND ($4::integer IS NULL OR p.business_year=$4)
        AND ($5::date IS NULL OR r.refunded_on>=$5) AND ($6::date IS NULL OR r.refunded_on<=$6) GROUP BY x.budget_line_id
      ) SELECT l.id,p.id AS project_id,p.name AS project_name,l.internal_label,
      b.current_amount::text,b.committed_amount::text,(b.current_amount-b.committed_amount)::text AS available_amount,
      coalesce(paid.gross,'0') AS paid,coalesce(paid.withheld,'0') AS withheld,coalesce(paid.received,'0') AS received,coalesce(refunded.refunded,'0') AS refunded
      FROM projects p JOIN budget_lines l ON l.project_id=p.id JOIN budget_accounts b ON b.line_id=l.id
      LEFT JOIN paid ON paid.budget_line_id=l.id LEFT JOIN refunded ON refunded.budget_line_id=l.id
      WHERE ${visibleProject} AND ($3::uuid IS NULL OR p.id=$3) AND ($4::integer IS NULL OR p.business_year=$4)
      ORDER BY p.name,p.id,l.created_at,l.id`, args)).rows.map(row => ({
        id: row.id, projectId: row.project_id, projectName: row.project_name, label: row.internal_label,
        current: row.current_amount, committed: row.committed_amount, available: row.available_amount, paid:row.paid,
        withheld:row.withheld,received:row.received,refunded:row.refunded,netExecution:(BigInt(row.paid)-BigInt(row.refunded)).toString(),
      }));
    const recent:DashboardResult['recent'] = (await client.query(`SELECT d.id,d.project_id,p.name AS project_name,d.created_at,a.id AS application_id,s.state,
      CASE WHEN s.state IS NOT NULL AND s.state<>'draft' THEN frozen.data->>'title' ELSE v.data->>'title' END AS title,
      CASE WHEN s.state IS NOT NULL AND s.state<>'draft' THEN s.amount::text ELSE v.data->>'amount' END AS amount,event.action AS latest_action
      FROM expense_drafts d JOIN projects p ON p.id=d.project_id
      JOIN work_items w ON w.id=d.work_id AND w.project_id=d.project_id
      JOIN expense_draft_versions v ON v.draft_id=d.id AND v.version=d.version
      LEFT JOIN expense_applications a ON a.draft_id=d.id LEFT JOIN spend_states s ON s.case_id=a.id
      LEFT JOIN LATERAL(SELECT data FROM expense_submission_versions sv WHERE sv.application_id=a.id ORDER BY version DESC LIMIT 1) frozen ON true
      LEFT JOIN LATERAL(SELECT action FROM budget_events e WHERE e.entity_id=a.id AND e.action LIKE 'application.%' ORDER BY created_at DESC,id DESC LIMIT 1) event ON true
      WHERE ${visibleProject} AND ${visibleWork}
        AND ($3::uuid IS NULL OR p.id=$3) AND ($4::integer IS NULL OR p.business_year=$4)
        AND ($5::date IS NULL OR d.created_at>=($5::date::timestamp AT TIME ZONE 'Asia/Seoul'))
        AND ($6::date IS NULL OR d.created_at<(($6::date+1)::timestamp AT TIME ZONE 'Asia/Seoul'))
      ORDER BY d.created_at DESC,d.id DESC LIMIT 20`, args)).rows.map(row => ({
        id: row.id,applicationId:row.application_id??null,number:row.application_id??row.id, projectId: row.project_id, projectName: row.project_name, title: row.title ?? '',
        amount: row.amount ?? null, createdAt: row.created_at.toISOString(),state:row.state==='draft'?(returnStates[row.latest_action]??'draft'):(row.state??'draft'),
      }));
    let processing:DashboardResult['processing']={review:null,supplement:null,payment:null};
    if(['staff','admin'].includes(actor.role)) {
      const count=(await client.query(`SELECT
        count(*) FILTER(WHERE s.state IN ('submitted','reviewing'))::integer AS review,
        count(*) FILTER(WHERE s.state='supplement')::integer AS supplement,
        count(*) FILTER(WHERE s.state='approved' AND (s.paid_amount<s.amount OR EXISTS(
          SELECT 1 FROM payment_refunds r LEFT JOIN refund_restorations x ON x.refund_id=r.id WHERE r.case_id=s.case_id AND x.refund_id IS NULL)))::integer AS payment
        FROM spend_states s JOIN work_items w ON w.id=s.work_id AND w.project_id=s.project_id JOIN projects p ON p.id=s.project_id
        WHERE ${visibleProject} AND ($3::uuid IS NULL OR p.id=$3) AND ($4::integer IS NULL OR p.business_year=$4)`,args.slice(0,4))).rows[0];
      processing={review:count.review,supplement:count.supplement,payment:count.payment};
    }
    const asOf = (await client.query('SELECT CURRENT_TIMESTAMP AS as_of')).rows[0].as_of.toISOString();
    const result: DashboardResult = {
      asOf, scope: { ...filter, role: actor.role, dateBasis: 'draft_created_at_kst', budgetBasis: 'current_snapshot',paymentBasis:'paid_on_kst',refundBasis:'refunded_on_kst',processingBasis:'current_state_no_period_filter',paymentScope:actor.role==='researcher'?'assigned_work':'project_all' },
      totals: dashboardTotals(lines), lines, recent,
      projects: projects.map(project => ({ id: project.id, name: project.name, businessYear: project.business_year })),
      processing,capabilities: { submission: true, payments: true }, unavailable: { paid: false, review: false },
    };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

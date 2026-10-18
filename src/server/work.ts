import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { uuid, textInput } from '../lib/validation.ts';
import { transaction } from './transaction.ts';
import { authenticate, type Actor } from './security.ts';
import { command } from './accounts.ts';

// Shared SQL boundaries for list/detail/search/export/statistics; never trust client role/IDs.
const member = `EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=p.id AND m.user_id=$1 AND m.active AND m.starts_at<=CURRENT_TIMESTAMP AND (m.ends_at IS NULL OR m.ends_at>CURRENT_TIMESTAMP))`;
const projectScope = `($2 IN ('admin','staff') OR ${member})`;
const workScope = `($2 IN ('admin','staff') OR (${member} AND ($2='principal_investigator' OR ($2='researcher' AND w.assigned_to=$1))))`;
function args(a: Actor) { return [a.id,a.role]; }
export async function projectList(pool: Pool,token: string) {
  return transaction(pool,async c => { const a=await authenticate(c,token);
    return (await c.query(`SELECT p.* FROM projects p WHERE ${projectScope} ORDER BY p.code LIMIT 1000`,args(a))).rows; });
}
export async function workList(pool: Pool,token: string,search='',projectId?: string) {
  if (search.length>200) throw new AppError('INVALID_INPUT'); if (projectId) uuid(projectId);
  return transaction(pool,async c => { const a=await authenticate(c,token);
    return (await c.query(`SELECT w.*,p.name AS project_name FROM work_items w JOIN projects p ON p.id=w.project_id WHERE ${workScope}
      AND ($3='' OR position(lower($3) in lower(w.title||' '||w.description))>0) AND ($4::uuid IS NULL OR p.id=$4) ORDER BY w.created_at,w.id LIMIT 1000`,[...args(a),search,projectId??null])).rows; });
}
export async function workDetail(pool: Pool,token: string,id: string) {
  uuid(id); return transaction(pool,async c => { const a=await authenticate(c,token);
    const item=(await c.query(`SELECT w.*,p.name AS project_name FROM work_items w JOIN projects p ON p.id=w.project_id WHERE ${workScope} AND w.id=$3 FOR SHARE OF w`,[...args(a),id])).rows[0];
    if (!item) throw new AppError('FORBIDDEN');
    const history=(await c.query('SELECT * FROM work_history WHERE work_id=$1 ORDER BY created_at,id',[id])).rows;
    return {item,history}; });
}
export async function projectDetail(pool: Pool,token: string,id: string) {
  uuid(id); return transaction(pool,async c => { const a=await authenticate(c,token);
    const item=(await c.query(`SELECT p.* FROM projects p WHERE ${projectScope} AND p.id=$3 FOR SHARE OF p`,[...args(a),id])).rows[0];
    if (!item) throw new AppError('FORBIDDEN');
    const participants=(await c.query(`SELECT m.*,u.role,p.display_name FROM project_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN people p ON p.id=u.person_id
      WHERE m.project_id=$1 AND ($2<>'researcher' OR m.user_id=$3) ORDER BY m.starts_at`,[id,a.role,a.id])).rows;
    const history=a.role==='researcher'?[]:(await c.query('SELECT * FROM project_history WHERE project_id=$1 ORDER BY created_at,id',[id])).rows;
    return {item,participants,history}; });
}
async function projectAudit(c: PoolClient,a: Actor,id: string,reason: string,before: unknown,after: unknown) {
  await c.query('INSERT INTO project_history(id,project_id,actor_id,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,a.id,reason,JSON.stringify(before),JSON.stringify(after)]);
}
export async function manageProject(pool: Pool,token: string,input: Record<string,unknown>) {
  return command(pool,token,input,'project.change',async(c,a)=>{
    const action=textInput(input.action),reason=textInput(input.reason,1000);
    if (action==='create') {
      const kind=textInput(input.kind),year=Number(input.year),id=randomUUID();
      if (!['research','program'].includes(kind)||!Number.isInteger(year)||year<2000||year>2200) throw new AppError('INVALID_INPUT');
      const after=(await c.query('INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,textInput(input.code,100),textInput(input.name),kind,year])).rows[0];
      await projectAudit(c,a,id,reason,{},after);return {id};
    }
    const id=uuid(input.id),before=(await c.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if (!before) throw new AppError('INVALID_INPUT');
    if (String(input.version)!==before.version) throw new AppError('CONFLICT');
    if (action==='update') {
      const year=Number(input.year),kind=textInput(input.kind);
      if (!Number.isInteger(year)||year<2000||year>2200||!['research','program'].includes(kind)) throw new AppError('INVALID_INPUT');
      await c.query('UPDATE projects SET name=$2,business_year=$3,kind=$4,version=version+1 WHERE id=$1',[id,textInput(input.name),year,kind]);
      const after=(await c.query('SELECT * FROM projects WHERE id=$1',[id])).rows[0];await projectAudit(c,a,id,reason,before,after);
    } else if (action==='member') {
      const user=uuid(input.userId); if (typeof input.active!=='boolean') throw new AppError('INVALID_INPUT');
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1',[user])).rowCount) throw new AppError('INVALID_INPUT');
      const prior=(await c.query('SELECT * FROM project_memberships WHERE project_id=$1 AND user_id=$2 FOR UPDATE',[id,user])).rows[0]??{};
      const after=(await c.query(`INSERT INTO project_memberships(id,project_id,user_id,active,starts_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)
        ON CONFLICT(project_id,user_id) DO UPDATE SET active=EXCLUDED.active,starts_at=CASE WHEN EXCLUDED.active THEN CURRENT_TIMESTAMP ELSE project_memberships.starts_at END,ends_at=NULL RETURNING *`,[randomUUID(),id,user,input.active])).rows[0];
      await c.query('UPDATE projects SET version=version+1 WHERE id=$1',[id]);
      await projectAudit(c,a,id,reason,{membership:prior},{membership:after});
    } else throw new AppError('INVALID_INPUT');return {id};
  });
}
export async function manageWork(pool: Pool,token: string,input: Record<string,unknown>) {
  return command(pool,token,input,'work.change',async(c,a)=>{
    const action=textInput(input.action),reason=textInput(input.reason,1000);
    const id=action==='create'?randomUUID():uuid(input.id);
    const before=action==='create'?null:(await c.query('SELECT * FROM work_items WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if (action!=='create'&&!before) throw new AppError('INVALID_INPUT');
    if (before&&String(input.version)!==before.version) throw new AppError('CONFLICT');
    const project=before?.project_id??uuid(input.projectId);
    if (!(await c.query('SELECT 1 FROM projects WHERE id=$1 FOR SHARE',[project])).rowCount) throw new AppError('INVALID_INPUT');
    const assignee=input.assignedTo?uuid(input.assignedTo):null;
    if (assignee&&!(await c.query(`SELECT 1 FROM users u JOIN project_memberships m ON m.user_id=u.id WHERE u.id=$1 AND u.active AND u.role='researcher'
      AND m.project_id=$2 AND m.active AND m.starts_at<=CURRENT_TIMESTAMP AND (m.ends_at IS NULL OR m.ends_at>CURRENT_TIMESTAMP) FOR SHARE OF u,m`,[assignee,project])).rowCount) throw new AppError('INVALID_INPUT');
    const title=textInput(input.title),description=typeof input.description==='string'?input.description:'';
    if (description.length>5000) throw new AppError('INVALID_INPUT');
    if (action==='create') await c.query('INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,project,title,description,assignee,a.id]);
    else if (action==='update') await c.query('UPDATE work_items SET title=$2,description=$3,assigned_to=$4,version=version+1 WHERE id=$1',[id,title,description,assignee]);
    else throw new AppError('INVALID_INPUT');
    const after=(await c.query('SELECT * FROM work_items WHERE id=$1',[id])).rows[0];
    await c.query('INSERT INTO work_history(id,work_id,actor_id,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,a.id,reason,JSON.stringify(before??{}),JSON.stringify(after)]);
    return {id};
  });
}

//! Teacher-only read models. Every collection is limited in SQL before materialization.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}
#[derive(Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    scope: String,
    id: String,
}
impl Query {
    fn bounds(&self, scope: &str) -> Result<(usize, String)> {
        let limit = self.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Err(PeerReviewError::InvalidInput);
        }
        let Some(value) = &self.cursor else {
            return Ok((limit, String::new()));
        };
        if value.len() > 2048 || value.len() % 2 != 0 {
            return Err(PeerReviewError::InvalidInput);
        }
        let bytes = value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).map_err(|_| PeerReviewError::InvalidInput)?;
                u8::from_str_radix(text, 16).map_err(|_| PeerReviewError::InvalidInput)
            })
            .collect::<Result<Vec<_>>>()?;
        let cursor: Cursor =
            serde_json::from_slice(&bytes).map_err(|_| PeerReviewError::InvalidInput)?;
        if cursor.scope != scope || cursor.id.is_empty() {
            return Err(PeerReviewError::InvalidInput);
        }
        Ok((limit, cursor.id))
    }
}
fn page<T>(mut rows: Vec<(String, T)>, limit: usize, scope: &str, total: i64) -> Result<Page<T>> {
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = if more {
        let id = rows.last().ok_or(PeerReviewError::Storage)?.0.clone();
        let bytes = serde_json::to_vec(&Cursor {
            scope: scope.into(),
            id,
        })
        .map_err(|_| PeerReviewError::Storage)?;
        Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
    } else {
        None
    };
    Ok(Page {
        items: rows.into_iter().map(|(_, item)| item).collect(),
        next_cursor,
        total,
    })
}
#[derive(Debug, Serialize)]
pub struct Summary {
    pub activity_id: String,
    pub question_summary: String,
    pub mode: PeerReviewMode,
    pub state: PeerReviewActivityState,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
    pub eligible_reviewers: i64,
    pub assignment_count: i64,
    pub submitted_count: i64,
    pub target_count: i64,
    pub covered_count: i64,
}
#[derive(Debug, Serialize)]
pub struct Status {
    pub id: String,
    pub label: String,
    pub assignment_id: Option<String>,
    pub target_label: Option<String>,
    pub latest_revision: i64,
    pub claimed_count: i64,
    pub submitted_count: i64,
    pub capacity: Option<i64>,
    pub remaining_capacity: Option<i64>,
}
#[derive(Debug, Serialize)]
pub struct Revision {
    pub revision: i64,
    pub body: String,
    pub submitted_at: String,
    pub submitted_by: String,
}
fn owned(c: &Connection, session: &str, id: &str) -> Result<PeerReviewActivity> {
    let a = activity(c, id)?;
    if a.session_id != session {
        return Err(PeerReviewError::PeerReviewActivityNotFound);
    }
    Ok(a)
}
fn ready(c: &Connection, s: &str, id: &str) -> Result<PeerReviewActivity> {
    let a = owned(c, s, id)?;
    if !matches!(
        a.state,
        PeerReviewActivityState::Open | PeerReviewActivityState::Closed
    ) {
        return Err(PeerReviewError::PeerReviewNotOpen);
    }
    Ok(a)
}
fn summary(c: &Connection, a: PeerReviewActivity) -> Result<Summary> {
    let id = &a.id;
    let target_table = if a.mode == PeerReviewMode::CrossGroup {
        "peer_review_group_targets"
    } else {
        "peer_review_targets"
    };
    let targets: i64 = c.query_row(
        &format!("SELECT COUNT(*) FROM {target_table} WHERE activity_id=?1"),
        [id],
        |r| r.get(0),
    )?;
    let (assigned,submitted):(i64,i64)=c.query_row("SELECT COUNT(*),COALESCE(SUM(EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=x.id)),0) FROM peer_review_assignments x WHERE x.activity_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let covered:i64=c.query_row("SELECT COUNT(DISTINCT COALESCE(target_id,target_group_id)) FROM peer_review_assignments x WHERE activity_id=?1 AND EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=x.id)",[id],|r|r.get(0))?;
    if a.mode == PeerReviewMode::RandomOneToOne
        && matches!(
            a.state,
            PeerReviewActivityState::Open | PeerReviewActivityState::Closed
        )
        && assigned != targets
    {
        return Err(PeerReviewError::Storage);
    }
    let prompt: String = c.query_row(
        "SELECT substr(prompt,1,201) FROM session_questions WHERE id=?1 AND session_id=?2",
        params![a.session_question_id, a.session_id],
        |r| r.get(0),
    )?;
    let question_summary = if prompt.chars().count() > 200 {
        format!("{}…", prompt.chars().take(199).collect::<String>())
    } else {
        prompt
    };
    Ok(Summary {
        activity_id: a.id,
        question_summary,
        mode: a.mode,
        state: a.state,
        opened_at: a.opened_at,
        closed_at: a.closed_at,
        eligible_reviewers: if a.mode == PeerReviewMode::CrossGroup {
            assigned
        } else {
            targets
        },
        assignment_count: assigned,
        submitted_count: submitted,
        target_count: targets,
        covered_count: covered,
    })
}
pub fn get_summary(db: &Database, s: &str, id: &str) -> Result<Summary> {
    let mut c = db.connection()?;
    let tx = c.transaction()?;
    let result = summary(&tx, owned(&tx, s, id)?)?;
    tx.commit()?;
    Ok(result)
}
pub fn activities(db: &Database, s: &str, q: &Query) -> Result<Page<Summary>> {
    let scope = format!("teacher-activities:{s}");
    let (limit, key) = q.bounds(&scope)?;
    let mut c = db.connection()?;
    let tx = c.transaction()?;
    if !tx
        .prepare("SELECT 1 FROM local_sessions WHERE id=?1")?
        .exists([s])?
    {
        return Err(PeerReviewError::SessionNotActive);
    }
    let total = tx.query_row(
        "SELECT COUNT(*) FROM peer_review_activities WHERE session_id=?1",
        [s],
        |r| r.get(0),
    )?;
    let ids=tx.prepare("SELECT id FROM peer_review_activities WHERE session_id=?1 AND id>?2 ORDER BY id LIMIT ?3")?.query_map(params![s,key,limit+1],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let rows = ids
        .into_iter()
        .map(|id| {
            let item = summary(&tx, owned(&tx, s, &id)?)?;
            Ok((id, item))
        })
        .collect::<Result<Vec<_>>>()?;
    let result = page(rows, limit, &scope, total)?;
    tx.commit()?;
    Ok(result)
}
// Safe labels are persisted Session participant snapshots or activity-pinned Group names.
const PRINCIPALS:&str="WITH principals AS (
 SELECT t.participant_id id,CAST(p.seat_number AS TEXT)||' · '||p.display_name label,t.id target_id FROM peer_review_targets t JOIN session_participants p ON p.id=t.participant_id WHERE t.activity_id=?1 AND ?2<> 'CROSS_GROUP'
 UNION ALL SELECT g.id,g.name,t.id FROM peer_review_group_targets t JOIN session_groups g ON g.id=t.session_group_id AND g.group_set_id=t.session_group_set_id WHERE t.activity_id=?1 AND ?2='CROSS_GROUP'),
 statuses AS (SELECT p.id,p.label,x.id assignment_id,target.label target_label,COALESCE((SELECT MAX(revision) FROM peer_review_responses r WHERE r.assignment_id=x.id),0) revision FROM principals p LEFT JOIN peer_review_assignments x ON x.activity_id=?1 AND COALESCE(x.reviewer_participant_id,x.reviewer_session_group_id)=p.id LEFT JOIN principals target ON target.target_id=COALESCE(x.target_id,x.target_group_id))";
pub fn statuses(db: &Database, s: &str, id: &str, kind: &str, q: &Query) -> Result<Page<Status>> {
    if !matches!(kind, "reviewers" | "targets" | "uncovered" | "reviews") {
        return Err(PeerReviewError::InvalidInput);
    }
    let scope = format!("teacher-{kind}:{s}:{id}");
    let (limit, key) = q.bounds(&scope)?;
    let mut c = db.connection()?;
    let tx = c.transaction()?;
    let a = ready(&tx, s, id)?;
    let rows;
    let total;
    if kind == "targets" || kind == "uncovered" {
        let sql=format!("{PRINCIPALS}, coverage AS (SELECT p.id,p.label,(SELECT COUNT(*) FROM peer_review_assignments x WHERE x.activity_id=?1 AND COALESCE(x.target_id,x.target_group_id)=p.target_id) claimed,(SELECT COUNT(*) FROM peer_review_assignments x WHERE x.activity_id=?1 AND COALESCE(x.target_id,x.target_group_id)=p.target_id AND EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=x.id)) submitted FROM principals p)");
        let filter = if kind == "uncovered" {
            "submitted=0"
        } else {
            "1=1"
        };
        total = tx.query_row(
            &format!("{sql} SELECT COUNT(*) FROM coverage WHERE {filter}"),
            params![id, a.mode.as_str()],
            |r| r.get(0),
        )?;
        let capacity = if a.mode == PeerReviewMode::StudentSelect {
            a.max_reviews_per_target
        } else {
            Some(1)
        };
        rows=tx.prepare(&format!("{sql} SELECT id,label,claimed,submitted FROM coverage WHERE {filter} AND id>?3 ORDER BY id LIMIT ?4"))?.query_map(params![id,a.mode.as_str(),key,limit+1],|r|{
            let id:String=r.get(0)?;let claimed:i64=r.get(2)?;
            Ok((id.clone(),Status{id,label:r.get(1)?,assignment_id:None,target_label:None,latest_revision:0,claimed_count:claimed,submitted_count:r.get(3)?,capacity,remaining_capacity:capacity.map(|v|(v-claimed).max(0))}))
        })?.collect::<std::result::Result<Vec<_>,_>>()?;
    } else {
        let filter = if kind == "reviews" {
            "revision>0"
        } else {
            "1=1"
        };
        total = tx.query_row(
            &format!("{PRINCIPALS} SELECT COUNT(*) FROM statuses WHERE {filter}"),
            params![id, a.mode.as_str()],
            |r| r.get(0),
        )?;
        rows=tx.prepare(&format!("{PRINCIPALS} SELECT id,label,assignment_id,target_label,revision FROM statuses WHERE {filter} AND id>?3 ORDER BY id LIMIT ?4"))?.query_map(params![id,a.mode.as_str(),key,limit+1],|r|{
            let id:String=r.get(0)?;let assignment:Option<String>=r.get(2)?;let revision:i64=r.get(4)?;
            Ok((id.clone(),Status{id,label:r.get(1)?,claimed_count:i64::from(assignment.is_some()),assignment_id:assignment,target_label:r.get(3)?,latest_revision:revision,submitted_count:i64::from(revision>0),capacity:None,remaining_capacity:None}))
        })?.collect::<std::result::Result<Vec<_>,_>>()?;
    }
    let result = page(rows, limit, &scope, total)?;
    tx.commit()?;
    Ok(result)
}
pub fn revisions(
    db: &Database,
    s: &str,
    id: &str,
    assignment_id: &str,
    q: &Query,
    latest: bool,
) -> Result<Page<Revision>> {
    let scope = format!("teacher-revisions:{s}:{id}:{assignment_id}");
    let (limit, key) = q.bounds(&scope)?;
    let before = if key.is_empty() {
        i64::MAX
    } else {
        key.parse::<i64>()
            .map_err(|_| PeerReviewError::InvalidInput)?
    };
    let mut c = db.connection()?;
    let tx = c.transaction()?;
    ready(&tx, s, id)?;
    if !tx
        .prepare("SELECT 1 FROM peer_review_assignments WHERE id=?1 AND activity_id=?2")?
        .exists(params![assignment_id, id])?
    {
        return Err(PeerReviewError::AssignmentNotFound);
    }
    let total = tx.query_row(
        "SELECT COUNT(*) FROM peer_review_responses WHERE assignment_id=?1",
        [assignment_id],
        |r| r.get(0),
    )?;
    let limit = if latest { 1 } else { limit };
    let rows=tx.prepare("SELECT r.revision,r.body,r.submitted_at,CAST(p.seat_number AS TEXT)||' · '||p.display_name FROM peer_review_responses r JOIN session_participants p ON p.id=r.submitted_by_participant_id WHERE r.assignment_id=?1 AND r.revision<?2 ORDER BY r.revision DESC LIMIT ?3")?.query_map(params![assignment_id,before,limit+1],|r|{let revision:i64=r.get(0)?;Ok((revision.to_string(),Revision{revision,body:r.get(1)?,submitted_at:r.get(2)?,submitted_by:r.get(3)?}))})?.collect::<std::result::Result<Vec<_>,_>>()?;
    let result = page(rows, limit, &scope, total)?;
    tx.commit()?;
    Ok(result)
}

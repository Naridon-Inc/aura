use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Data Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMeta {
    pub team_id: String,
    pub labels: Vec<(String, String)>,   // (id, name)
    pub members: Vec<(String, String)>,  // (id, name)
    pub states: Vec<(String, String)>,   // (id, name)
    pub projects: Vec<(String, String)>, // (id, name)
    pub cycles: Vec<LinearCycle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinearCycle {
    pub id: String,
    pub name: Option<String>,
    pub number: i32,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinearIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    pub branch_name: Option<String>,
    pub url: String,
    pub priority: Option<i32>,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cycle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_issue_count: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IssueUpdate {
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub state_id: Option<String>,
    pub assignee_id: Option<String>,
    pub label_ids: Option<Vec<String>>,
    pub project_id: Option<String>,
    pub cycle_id: Option<String>,
    pub due_date: Option<String>,
    pub parent_id: Option<String>,
    pub estimate: Option<i32>,
}

// ─── Issue node fragment (shared across queries) ───────────────────────────

const ISSUE_FIELDS: &str = "
  id identifier title description priority
  state { name }
  assignee { id name }
  branchName url dueDate
  parent { id identifier }
  project { id name }
  cycle { id name number }
  labels { nodes { name } }
  children { nodes { id } }
";

// ─── GraphQL Queries ────────────────────────────────────────────────────────

const FETCH_ISSUES_BY_TEAM_QUERY: &str = r#"
query SymphonyPoll($teamKey: String!, $stateNames: [String!]!, $first: Int!) {
  issues(filter: {team: {key: {eq: $teamKey}}, state: {name: {in: $stateNames}}}, first: $first) {
    nodes {
      id identifier title description priority
      state { name }
      assignee { id name }
      branchName url dueDate
      parent { id identifier }
      project { id name }
      cycle { id name number }
      labels { nodes { name } }
      children { nodes { id } }
    }
  }
}
"#;

const FETCH_ALL_ISSUES_QUERY: &str = r#"
query TeamIssues($teamKey: String!, $first: Int!) {
  issues(filter: {team: {key: {eq: $teamKey}}}, first: $first, orderBy: updatedAt) {
    nodes {
      id identifier title description priority
      state { name }
      assignee { id name }
      branchName url dueDate
      parent { id identifier }
      project { id name }
      cycle { id name number }
      labels { nodes { name } }
      children { nodes { id } }
    }
  }
}
"#;

const FETCH_ISSUE_BY_ID_QUERY: &str = r#"
query FetchIssue($ids: [ID!]!, $first: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id identifier title description priority
      state { name }
      assignee { id name }
      branchName url dueDate
      parent { id identifier }
      project { id name }
      cycle { id name number }
      labels { nodes { name } }
      children { nodes { id } }
    }
  }
}
"#;

const CREATE_COMMENT_MUTATION: &str = r#"
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: {issueId: $issueId, body: $body}) {
    success
  }
}
"#;

const UPDATE_ISSUE_STATE_QUERY: &str = r#"
query TeamStates($slug: String!) {
  workflowStates(filter: {team: {key: {eq: $slug}}}) {
    nodes { id name }
  }
}
"#;

const UPDATE_ISSUE_MUTATION: &str = r#"
mutation UpdateIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: {stateId: $stateId}) {
    success
  }
}
"#;

const GENERAL_UPDATE_ISSUE_MUTATION: &str = r#"
mutation GeneralUpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id identifier title description priority
      state { name }
      assignee { id name }
      branchName url dueDate
      parent { id identifier }
      project { id name }
      cycle { id name number }
      labels { nodes { name } }
      children { nodes { id } }
    }
  }
}
"#;

const CREATE_ISSUE_MUTATION: &str = r#"
mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    issue {
      id identifier title description priority
      state { name }
      assignee { id name }
      branchName url dueDate
      parent { id identifier }
      project { id name }
      cycle { id name number }
      labels { nodes { name } }
      children { nodes { id } }
    }
    success
  }
}
"#;

const FETCH_TEAM_META_QUERY: &str = r#"
query TeamMeta($teamKey: String!) {
  teams(filter: { key: { eq: $teamKey } }) {
    nodes {
      id
      labels { nodes { id name } }
      members { nodes { id name } }
    }
  }
}
"#;

const FETCH_TEAM_FULL_META_QUERY: &str = r#"
query TeamFullMeta($teamKey: String!) {
  teams(filter: { key: { eq: $teamKey } }) {
    nodes {
      id
      labels { nodes { id name } }
      members { nodes { id name } }
      states { nodes { id name } }
    }
  }
  projects(first: 50) { nodes { id name } }
  cycles(first: 20, filter: { isPast: { eq: false } }) {
    nodes { id name number startsAt endsAt }
  }
}
"#;

// ─── Client ─────────────────────────────────────────────────────────────────

pub struct LinearClient {
    api_token: String,
    project_slug: String,
    endpoint: String,
    http: reqwest::blocking::Client,
}

impl LinearClient {
    pub fn new(api_token: &str, project_slug: &str) -> Self {
        Self {
            api_token: api_token.to_string(),
            project_slug: project_slug.to_string(),
            endpoint: "https://api.linear.app/graphql".to_string(),
            http: reqwest::blocking::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::blocking::Client::new()),
        }
    }

    fn graphql(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
        let payload = serde_json::json!({
            "query": query,
            "variables": variables,
        });

        let max_retries = 3;
        for attempt in 0..max_retries {
            let resp = self.http
                .post(&self.endpoint)
                .header("Authorization", &self.api_token)
                .header("Content-Type", "application/json")
                .json(&payload)
                .send()
                .map_err(|e| format!("Linear API request failed: {}", e))?;

            if resp.status().as_u16() == 429 && attempt < max_retries - 1 {
                let wait_ms = 1000u64 * 2u64.pow(attempt as u32 + 1);
                eprintln!("Linear API rate limited, retrying in {}ms...", wait_ms);
                std::thread::sleep(std::time::Duration::from_millis(wait_ms));
                continue;
            }

            if !resp.status().is_success() {
                return Err(format!("Linear API returned status {}", resp.status()));
            }

            let body: serde_json::Value = resp.json()
                .map_err(|e| format!("Failed to parse Linear response: {}", e))?;

            if let Some(errors) = body.get("errors") {
                return Err(format!("Linear GraphQL errors: {}", errors));
            }

            return Ok(body);
        }
        Err("Linear API failed after retries".to_string())
    }

    fn parse_issue_node(node: &serde_json::Value) -> LinearIssue {
        let labels = node
            .pointer("/labels/nodes")
            .and_then(|n| n.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(|s| s.to_lowercase()))
                    .collect()
            })
            .unwrap_or_default();

        let sub_issue_count = node
            .pointer("/children/nodes")
            .and_then(|n| n.as_array())
            .map(|a| a.len() as i32);

        LinearIssue {
            id: node.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            identifier: node.get("identifier").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            title: node.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            description: node.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
            state: node.pointer("/state/name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            branch_name: node.get("branchName").and_then(|v| v.as_str()).map(|s| s.to_string()),
            url: node.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            priority: node.get("priority").and_then(|v| v.as_i64()).map(|n| n as i32),
            labels,
            assignee: node.pointer("/assignee/name").and_then(|v| v.as_str()).map(|s| s.to_string()),
            project: node.pointer("/project/name").and_then(|v| v.as_str()).map(|s| s.to_string()),
            cycle: node.pointer("/cycle/name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| node.pointer("/cycle/number").and_then(|v| v.as_i64()).map(|n| format!("Cycle {}", n))),
            due_date: node.get("dueDate").and_then(|v| v.as_str()).map(|s| s.to_string()),
            parent_id: node.pointer("/parent/id").and_then(|v| v.as_str()).map(|s| s.to_string()),
            sub_issue_count,
        }
    }

    fn parse_issues(&self, body: &serde_json::Value) -> Result<Vec<LinearIssue>, String> {
        let nodes = body
            .pointer("/data/issues/nodes")
            .and_then(|n| n.as_array())
            .ok_or("Invalid Linear response: missing issues.nodes")?;

        Ok(nodes.iter().map(Self::parse_issue_node).collect())
    }

    /// Fetch all issues matching active states for the configured project.
    pub fn fetch_candidate_issues(&self, active_states: &[String]) -> Result<Vec<LinearIssue>, String> {
        let body = self.graphql(FETCH_ISSUES_BY_TEAM_QUERY, serde_json::json!({
            "teamKey": self.project_slug,
            "stateNames": active_states,
            "first": 50,
        }))?;

        let mut issues = self.parse_issues(&body)?;
        // Sort by priority (1=urgent, 4=low), then by identifier
        issues.sort_by(|a, b| {
            let pa = a.priority.unwrap_or(99);
            let pb = b.priority.unwrap_or(99);
            pa.cmp(&pb).then_with(|| a.identifier.cmp(&b.identifier))
        });
        Ok(issues)
    }

    /// Fetch a single issue by its Linear UUID.
    pub fn fetch_issue_by_id(&self, issue_id: &str) -> Result<LinearIssue, String> {
        let body = self.graphql(FETCH_ISSUE_BY_ID_QUERY, serde_json::json!({
            "ids": [issue_id],
            "first": 1,
        }))?;

        let issues = self.parse_issues(&body)?;
        issues.into_iter().next().ok_or_else(|| format!("Issue {} not found", issue_id))
    }

    /// Update the state of an issue (e.g., "Todo" → "In Progress").
    /// First looks up the workflow state ID by name, then updates.
    pub fn update_issue_state(&self, issue_id: &str, state_name: &str) -> Result<(), String> {
        let team_key = &self.project_slug;

        let states_body = self.graphql(UPDATE_ISSUE_STATE_QUERY, serde_json::json!({
            "slug": team_key,
        }))?;

        let state_nodes = states_body
            .pointer("/data/workflowStates/nodes")
            .and_then(|n| n.as_array())
            .ok_or("Failed to fetch workflow states")?;

        let target_name = state_name.to_lowercase().trim().to_string();
        let state_id = state_nodes.iter()
            .find(|node| {
                node.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n.to_lowercase().trim().to_string() == target_name)
                    .unwrap_or(false)
            })
            .and_then(|node| node.get("id").and_then(|v| v.as_str()))
            .ok_or_else(|| format!("Workflow state '{}' not found for team '{}'", state_name, team_key))?;

        let result = self.graphql(UPDATE_ISSUE_MUTATION, serde_json::json!({
            "id": issue_id,
            "stateId": state_id,
        }))?;

        let success = result
            .pointer("/data/issueUpdate/success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if success { Ok(()) } else { Err("Failed to update issue state".to_string()) }
    }

    /// Post a comment on an issue.
    pub fn create_comment(&self, issue_id: &str, body: &str) -> Result<(), String> {
        let result = self.graphql(CREATE_COMMENT_MUTATION, serde_json::json!({
            "issueId": issue_id,
            "body": body,
        }))?;

        let success = result
            .pointer("/data/commentCreate/success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if success { Ok(()) } else { Err("Failed to create comment".to_string()) }
    }

    /// Fetch basic team metadata (id, labels, members) — lightweight.
    pub fn fetch_team_meta(&self) -> Result<TeamMeta, String> {
        let body = self.graphql(FETCH_TEAM_META_QUERY, serde_json::json!({
            "teamKey": self.project_slug,
        }))?;

        let team = body
            .pointer("/data/teams/nodes/0")
            .ok_or_else(|| format!("Team '{}' not found", self.project_slug))?;

        Ok(TeamMeta {
            team_id: Self::str_field(team, "id").unwrap_or_default(),
            labels: Self::parse_id_name_list(team, "/labels/nodes"),
            members: Self::parse_id_name_list(team, "/members/nodes"),
            states: vec![],
            projects: vec![],
            cycles: vec![],
        })
    }

    /// Fetch full team metadata including states, projects, and active cycles.
    pub fn fetch_team_full_meta(&self) -> Result<TeamMeta, String> {
        let body = self.graphql(FETCH_TEAM_FULL_META_QUERY, serde_json::json!({
            "teamKey": self.project_slug,
        }))?;

        let team = body
            .pointer("/data/teams/nodes/0")
            .ok_or_else(|| format!("Team '{}' not found", self.project_slug))?;

        let projects = body
            .pointer("/data/projects/nodes")
            .and_then(|n| n.as_array())
            .map(|arr| Self::id_name_pairs(arr))
            .unwrap_or_default();

        let cycles = body
            .pointer("/data/cycles/nodes")
            .and_then(|n| n.as_array())
            .map(|arr| {
                arr.iter().filter_map(|c| {
                    Some(LinearCycle {
                        id: c.get("id")?.as_str()?.to_string(),
                        name: c.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        number: c.get("number").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                        starts_at: c.get("startsAt").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        ends_at: c.get("endsAt").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    })
                }).collect()
            })
            .unwrap_or_default();

        Ok(TeamMeta {
            team_id: Self::str_field(team, "id").unwrap_or_default(),
            labels: Self::parse_id_name_list(team, "/labels/nodes"),
            members: Self::parse_id_name_list(team, "/members/nodes"),
            states: Self::parse_id_name_list(team, "/states/nodes"),
            projects,
            cycles,
        })
    }

    /// Fetch all issues for the team (up to 100, sorted by most recently updated).
    pub fn fetch_all_issues(&self, limit: usize) -> Result<Vec<LinearIssue>, String> {
        let body = self.graphql(FETCH_ALL_ISSUES_QUERY, serde_json::json!({
            "teamKey": self.project_slug,
            "first": std::cmp::min(limit, 100),
        }))?;
        self.parse_issues(&body)
    }

    /// Create a new issue in the team.
    pub fn create_issue(
        &self,
        team_id: &str,
        title: &str,
        description: Option<&str>,
        priority: Option<i32>,
        label_ids: Vec<String>,
        assignee_id: Option<String>,
        estimate: Option<i32>,
        project_id: Option<String>,
        cycle_id: Option<String>,
        due_date: Option<String>,
        parent_id: Option<String>,
    ) -> Result<LinearIssue, String> {
        let mut input = serde_json::json!({
            "teamId": team_id,
            "title": title,
        });

        if let Some(desc) = description { input["description"] = serde_json::json!(desc); }
        if let Some(p) = priority { input["priority"] = serde_json::json!(p); }
        if !label_ids.is_empty() { input["labelIds"] = serde_json::json!(label_ids); }
        if let Some(ref a) = assignee_id { input["assigneeId"] = serde_json::json!(a); }
        if let Some(e) = estimate { input["estimate"] = serde_json::json!(e); }
        if let Some(ref p) = project_id { input["projectId"] = serde_json::json!(p); }
        if let Some(ref c) = cycle_id { input["cycleId"] = serde_json::json!(c); }
        if let Some(ref d) = due_date { input["dueDate"] = serde_json::json!(d); }
        if let Some(ref pid) = parent_id { input["parentId"] = serde_json::json!(pid); }

        let body = self.graphql(CREATE_ISSUE_MUTATION, serde_json::json!({ "input": input }))?;

        let success = body
            .pointer("/data/issueCreate/success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !success {
            return Err("Linear API reported issueCreate failure".to_string());
        }

        let node = body
            .pointer("/data/issueCreate/issue")
            .ok_or("Missing issue in issueCreate response")?;

        Ok(Self::parse_issue_node(node))
    }

    /// Update an existing issue with a flexible set of fields.
    pub fn update_issue(&self, issue_id: &str, update: &IssueUpdate) -> Result<LinearIssue, String> {
        let mut input = serde_json::Map::new();

        if let Some(ref t) = update.title { input.insert("title".into(), serde_json::json!(t)); }
        if let Some(ref d) = update.description { input.insert("description".into(), serde_json::json!(d)); }
        if let Some(p) = update.priority { input.insert("priority".into(), serde_json::json!(p)); }
        if let Some(ref s) = update.state_id { input.insert("stateId".into(), serde_json::json!(s)); }
        if let Some(ref a) = update.assignee_id { input.insert("assigneeId".into(), serde_json::json!(a)); }
        if let Some(ref l) = update.label_ids { input.insert("labelIds".into(), serde_json::json!(l)); }
        if let Some(ref p) = update.project_id { input.insert("projectId".into(), serde_json::json!(p)); }
        if let Some(ref c) = update.cycle_id { input.insert("cycleId".into(), serde_json::json!(c)); }
        if let Some(ref d) = update.due_date { input.insert("dueDate".into(), serde_json::json!(d)); }
        if let Some(ref p) = update.parent_id { input.insert("parentId".into(), serde_json::json!(p)); }
        if let Some(e) = update.estimate { input.insert("estimate".into(), serde_json::json!(e)); }

        if input.is_empty() {
            return Err("No fields to update".to_string());
        }

        let body = self.graphql(GENERAL_UPDATE_ISSUE_MUTATION, serde_json::json!({
            "id": issue_id,
            "input": serde_json::Value::Object(input),
        }))?;

        let success = body
            .pointer("/data/issueUpdate/success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !success {
            return Err("issueUpdate failed".to_string());
        }

        let node = body
            .pointer("/data/issueUpdate/issue")
            .ok_or("Missing issue in issueUpdate response")?;

        Ok(Self::parse_issue_node(node))
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    fn str_field(obj: &serde_json::Value, key: &str) -> Option<String> {
        obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    }

    fn parse_id_name_list(parent: &serde_json::Value, pointer: &str) -> Vec<(String, String)> {
        parent
            .pointer(pointer)
            .and_then(|n| n.as_array())
            .map(|arr| Self::id_name_pairs(arr))
            .unwrap_or_default()
    }

    fn id_name_pairs(arr: &[serde_json::Value]) -> Vec<(String, String)> {
        arr.iter().filter_map(|item| {
            let id = item.get("id").and_then(|v| v.as_str())?;
            let name = item.get("name").and_then(|v| v.as_str())?;
            Some((id.to_string(), name.to_string()))
        }).collect()
    }
}

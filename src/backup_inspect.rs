//! Native, read-only history backup validation and inspection. No Node fallback.
use crate::{backup_json::Json, backup_reader::MAXIMUM};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
type Result<T> = std::result::Result<T, &'static str>;
const TYPES: &[&str] = &["tasks", "answers", "decisions", "evidence"];
const RECORDS: &[&str] = &["tasks", "questions", "answers", "decisions", "evidence"];

fn check(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(code)
    }
}
fn hash(v: Json<'_>) -> Result<String> {
    Ok(Sha256::digest(v.stringify(true, MAXIMUM)?.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn has(set: &HashSet<String>, v: Json<'_>) -> bool {
    v.string().is_some_and(|s| set.contains(&s))
}
fn one(v: Json<'_>, values: &[&str]) -> bool {
    v.string().is_some_and(|s| values.contains(&s.as_str()))
}
fn identifier(v: Json<'_>) -> bool {
    let Some(s) = v.string() else {
        return false;
    };
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && ![
            "constructor",
            "toString",
            "toLocaleString",
            "valueOf",
            "hasOwnProperty",
            "isPrototypeOf",
            "propertyIsEnumerable",
            "__defineGetter__",
            "__defineSetter__",
            "__lookupGetter__",
            "__lookupSetter__",
            "__proto__",
        ]
        .contains(&s.as_str())
        && !(s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        && !sensitive(&s)
}
fn hex(v: Json<'_>, length: usize) -> bool {
    v.string().is_some_and(|s| {
        s.len() == length
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn time(v: Json<'_>) -> bool {
    let Some(s) = v.string() else {
        return false;
    };
    if s.len() != 24
        || !s.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 | 16 => b == b':',
            19 => b == b'.',
            23 => b == b'Z',
            _ => b.is_ascii_digit(),
        })
    {
        return false;
    }
    let n = |a, b| s[a..b].parse::<u32>().unwrap();
    let (year, month, day) = (n(0, 4), n(5, 7), n(8, 10));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    day > 0 && day <= days && n(11, 13) < 24 && n(14, 16) < 60 && n(17, 19) < 60
}
fn selection(v: Json<'_>) -> Result<()> {
    v.keys(
        &[
            "types",
            "task_ids",
            "question_ids",
            "evidence_ids",
            "since",
            "until",
        ],
        &["types"],
    )?;
    let types = v.get("types").array().unwrap_or_default();
    let mut seen = HashSet::new();
    check(
        !types.is_empty()
            && types
                .iter()
                .all(|v| one(*v, TYPES) && seen.insert(v.string().unwrap())),
        "invalid_backup_types",
    )?;
    let mut normalized = json!({"types":seen.into_iter().collect::<Vec<_>>()});
    normalized["types"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(|v| v.as_str().unwrap().to_owned());
    for name in ["task_ids", "question_ids", "evidence_ids"] {
        let ids = v.get(name);
        if ids.null() {
            normalized[name] = Value::Null;
            continue;
        }
        let mut seen = HashSet::new();
        check(
            ids.array().is_some_and(|ids| {
                ids.len() <= 2000
                    && ids
                        .iter()
                        .all(|v| identifier(*v) && seen.insert(v.string().unwrap()))
            }),
            "invalid_backup_selection_ids",
        )?;
        let mut ids: Vec<_> = seen.into_iter().collect();
        ids.sort();
        normalized[name] = json!(ids);
    }
    let (since, until) = (v.get("since"), v.get("until"));
    check(
        (since.null() || time(since))
            && (until.null() || time(until))
            && (since.null() || until.null() || since.string() <= until.string()),
        "invalid_backup_time_range",
    )?;
    normalized["since"] = json!(since.string());
    normalized["until"] = json!(until.string());
    let text = normalized.to_string();
    check(hash(Json(&text))? == hash(v)?, "invalid_backup_selection")
}
fn policy() -> Value {
    json!({"mode":"historical-only","execution_authorized":false,"event_subscriptions_restored":false,"content_mode":"withheld-or-reviewed-replacement"})
}

pub fn inspect(text: &str) -> Result<Value> {
    let a = Json::parse(text)?;
    a.stringify(false, MAXIMUM)?; // Must precede every schema check, including unknown fields.
    a.exact(&[
        "format",
        "schema",
        "archive_id",
        "created_at",
        "source",
        "selection",
        "policy",
        "records",
        "reviewed_fields",
        "withheld_fields",
        "integrity",
    ])?;
    let archive_id = a.get("archive_id").string().unwrap_or_default();
    let id = archive_id.strip_prefix("backup_").unwrap_or_default();
    check(
        a.get("format").is("rdsh-history")
            && a.get("schema").number() == Some(1.0)
            && uuid(id)
            && id.as_bytes()[14] == b'4'
            && b"89ab".contains(&id.as_bytes()[19])
            && time(a.get("created_at")),
        "invalid_backup_header",
    )?;
    let source = a.get("source");
    source.exact(&["project_id", "revision", "acceptance_revision"])?;
    check(
        hex(source.get("project_id"), 16)
            && source.get("revision").integer().is_some()
            && (source.get("acceptance_revision").null()
                || source.get("acceptance_revision").integer().is_some()),
        "invalid_backup_source",
    )?;
    selection(a.get("selection"))?;
    let expected_policy = policy().to_string();
    check(
        hash(a.get("policy"))? == hash(Json(&expected_policy))?,
        "backup_cannot_restore_authority",
    )?;
    let records = a.get("records");
    records.exact(RECORDS)?;
    let mut lists = HashMap::new();
    // Object.values visits caller insertion order, even though validation below has a fixed order.
    for (key, value) in records.object().unwrap() {
        let name = String::from_utf16(&key).unwrap();
        let list = value.array().ok_or("invalid_backup_records")?;
        let mut ids = HashSet::new();
        check(
            list.len() <= 2000
                && list.iter().all(|r| {
                    r.object().is_some()
                        && identifier(r.get("id"))
                        && ids.insert(r.get("id").string().unwrap())
                }),
            "invalid_backup_records",
        )?;
        lists.insert(name, list);
    }
    let tasks: HashSet<_> = lists["tasks"]
        .iter()
        .map(|r| r.get("id").string().unwrap())
        .collect();
    let questions: HashSet<_> = lists["questions"]
        .iter()
        .map(|r| r.get("id").string().unwrap())
        .collect();
    let decisions: HashMap<_, _> = lists["decisions"]
        .iter()
        .map(|r| (r.get("id").string().unwrap(), *r))
        .collect();
    for r in &lists["tasks"] {
        r.exact(&[
            "id",
            "title",
            "status",
            "milestone",
            "blocker",
            "updated_at",
        ])?;
        check(
            one(r.get("status"), &["todo", "doing", "done", "blocked"])
                && time(r.get("updated_at")),
            "invalid_backup_task",
        )?;
    }
    for r in &lists["questions"] {
        r.exact(&["id", "question", "created_at"])?;
        check(time(r.get("created_at")), "invalid_backup_question")?;
    }
    for r in &lists["decisions"] {
        r.exact(&[
            "id",
            "question_id",
            "task_id",
            "revision",
            "kind",
            "source_status",
            "updated_at",
            "choices",
            "diff",
            "impact",
            "conditions",
        ])?;
        let revision = r.get("revision").integer();
        let question = r.get("question_id").string().unwrap_or_default();
        let input = json!([question, revision]).to_string();
        let id = format!("decision_{}", &hash(Json(&input))?[..32]);
        check(
            has(&questions, r.get("question_id"))
                && (r.get("task_id").null() || has(&tasks, r.get("task_id")))
                && revision.is_some_and(|n| n > 0)
                && r.get("id").is(&id)
                && one(r.get("kind"), &["consultation", "approval"])
                && one(
                    r.get("source_status"),
                    &["open", "answered", "cancelled", "superseded"],
                )
                && time(r.get("updated_at"))
                && r.get("choices").array().is_some_and(|c| c.len() <= 8),
            "invalid_backup_decision",
        )?;
        let mut ids = HashSet::new();
        let choices = r.get("choices").array().unwrap();
        for c in &choices {
            c.exact(&["id", "label"])?;
            check(identifier(c.get("id")), "invalid_backup_choice")?;
            ids.insert(c.get("id").string().unwrap());
        }
        check(ids.len() == choices.len(), "duplicate_backup_choice")?;
    }
    let mut sequences = HashSet::new();
    for r in &lists["answers"] {
        r.exact(&[
            "id",
            "sequence",
            "question_id",
            "decision_id",
            "choice_id",
            "answer",
            "created_at",
        ])?;
        let sequence = r.get("sequence").integer();
        let decision = r
            .get("decision_id")
            .string()
            .and_then(|id| decisions.get(&id));
        let reference = if r.get("decision_id").null() {
            r.get("choice_id").null()
        } else {
            decision.is_some_and(|d| {
                d.get("question_id").string() == r.get("question_id").string()
                    && (r.get("choice_id").null()
                        || d.get("choices")
                            .array()
                            .unwrap()
                            .iter()
                            .any(|c| c.get("id").string() == r.get("choice_id").string()))
            })
        };
        check(
            sequence.is_some_and(|n| {
                n > 0 && sequences.insert(n) && r.get("id").is(&format!("answer_{n}"))
            }) && has(&questions, r.get("question_id"))
                && reference
                && time(r.get("created_at")),
            "invalid_backup_answer_reference",
        )?;
    }
    for r in &lists["evidence"] {
        r.exact(&[
            "id",
            "task_id",
            "criterion_id",
            "sequence",
            "scope",
            "reference",
            "freshness",
        ])?;
        let id = r.get("id").string().unwrap();
        check(
            id.strip_prefix("evi_").is_some_and(uuid)
                && has(&tasks, r.get("task_id"))
                && identifier(r.get("criterion_id"))
                && r.get("sequence").integer().is_some_and(|n| n > 0)
                && one(r.get("scope"), &["full", "partial"])
                && r.get("reference").is(&format!(
                    "rdsh-evidence:{}/{id}",
                    source.get("project_id").string().unwrap()
                ))
                && r.get("freshness").is("unverified"),
            "invalid_backup_evidence_reference",
        )?;
    }
    let mut reviewed = Vec::new();
    let mut withheld = Vec::new();
    for (kind, values) in records.object().unwrap() {
        let kind = String::from_utf16(&kind).unwrap();
        for r in values.array().unwrap() {
            let names: &[&str] = match kind.as_str() {
                "tasks" => &["title", "milestone", "blocker"],
                "questions" => &["question"],
                "answers" => &["answer"],
                "decisions" => &["diff", "impact", "conditions"],
                _ => &[],
            };
            let id = r.get("id").string().unwrap();
            for name in names {
                content(
                    r.get(name),
                    format!("{kind}/{id}/{name}"),
                    &mut reviewed,
                    &mut withheld,
                )?;
            }
            if kind == "decisions" {
                for c in r.get("choices").array().unwrap() {
                    content(
                        c.get("label"),
                        format!(
                            "{kind}/{id}/choices/{}/label",
                            c.get("id").string().unwrap()
                        ),
                        &mut reviewed,
                        &mut withheld,
                    )?;
                }
            }
        }
    }
    reviewed.sort();
    withheld.sort();
    let reviewed_json = serde_json::to_string(&reviewed).unwrap();
    let withheld_json = serde_json::to_string(&withheld).unwrap();
    check(
        a.get("reviewed_fields").stringify(false, MAXIMUM)? == reviewed_json
            && a.get("withheld_fields").stringify(false, MAXIMUM)? == withheld_json,
        "invalid_backup_content_review",
    )?;
    let integrity = a.get("integrity");
    integrity.exact(&["algorithm", "digest"])?;
    check(
        integrity.get("algorithm").is("sha256") && hex(integrity.get("digest"), 64),
        "backup_integrity_mismatch",
    )?;
    // All retained schema values are now safe to represent as ordinary serde values.
    let normalized = a.stringify(false, MAXIMUM)?;
    let mut archive: Value =
        serde_json::from_str(&normalized).map_err(|_| "invalid_backup_fields")?;
    archive.as_object_mut().unwrap().remove("integrity");
    let body = archive.to_string();
    check(
        integrity.get("digest").is(&hash(Json(&body))?),
        "backup_integrity_mismatch",
    )?;
    let archive: Value = serde_json::from_str(&normalized).unwrap();
    let mut counts = serde_json::Map::new();
    for (kind, values) in archive["records"].as_object().unwrap() {
        counts.insert(kind.clone(), json!(values.as_array().unwrap().len()));
    }
    Ok(
        json!({"archive_id":archive["archive_id"],"integrity":archive["integrity"],"source":archive["source"],"created_at":archive["created_at"],"selection":archive["selection"],"selection_digest":hash(a.get("selection"))?,"counts":counts,"reviewed_fields":archive["reviewed_fields"],"withheld_fields":archive["withheld_fields"],"policy":archive["policy"],"records":archive["records"]}),
    )
}
fn content(
    value: Json<'_>,
    path: String,
    reviewed: &mut Vec<String>,
    withheld: &mut Vec<String>,
) -> Result<()> {
    if value.null() {
        withheld.push(path);
        return Ok(());
    }
    let s = value.string().ok_or("sensitive_backup_content")?;
    check(
        s.encode_utf16().count() <= 8000
            && s.chars().any(|c| !js_space(c))
            && !s
                .chars()
                .any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}'))
            && !sensitive(&s),
        "sensitive_backup_content",
    )?;
    reviewed.push(path);
    Ok(())
}

// ECMAScript \s and trim, not Rust's Unicode White_Space (NEL differs).
fn js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}
fn token(b: u8) -> bool {
    word(b) || b == b'-'
}
fn sensitive(s: &str) -> bool {
    for start in std::iter::once(0).chain(s.match_indices('\n').map(|(i, _)| i + 1)) {
        let line = s[start..].trim_start_matches(js_space);
        for prefix in [
            "const", "let", "var", "class", "function", "def", "import", "export",
        ] {
            if let Some(rest) = line.strip_prefix(prefix) {
                if rest.chars().next().is_some_and(js_space)
                    && rest
                        .trim_start_matches(js_space)
                        .split('\n')
                        .next()
                        .unwrap_or_default()
                        .contains(['=', '(', '{', ';'])
                {
                    return true;
                }
            }
        }
    }
    let lower = s.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    if lower.contains("```") {
        return true;
    }
    if lower.match_indices("-----begin ").any(|(i, _)| {
        lower[i..]
            .split(['\n', '\r', '\u{2028}', '\u{2029}'])
            .next()
            .unwrap_or_default()
            .contains("private key-----")
    }) {
        return true;
    }
    // matchAll consumes an entire URL token; do not reinterpret a second
    // scheme embedded inside its pathname as another URL with credentials.
    let mut url_match_end = 0;
    for (i, _) in lower.char_indices() {
        let rest = &lower[i..];
        for name in [
            "api_key",
            "api-key",
            "apikey",
            "access_token",
            "access-token",
            "accesstoken",
            "refresh_token",
            "refresh-token",
            "refreshtoken",
            "password",
            "secret",
            "credential",
        ] {
            if rest
                .strip_prefix(name)
                .is_some_and(|r| r.trim_start_matches(js_space).starts_with(['=', ':']))
            {
                return true;
            }
        }
        for name in [
            "sk-",
            "sk_",
            "ghp_",
            "gho_",
            "ghu_",
            "ghs_",
            "ghr_",
            "github_pat_",
            "xoxb-",
            "xoxa-",
            "xoxp-",
            "xoxr-",
            "xoxs-",
        ] {
            if rest
                .strip_prefix(name)
                .is_some_and(|r| r.bytes().take_while(|b| token(*b)).count() >= 6)
            {
                return true;
            }
        }
        if i == 0 || !word(bytes[i - 1]) {
            for name in ["bearer", "basic"] {
                if rest.strip_prefix(name).is_some_and(|r| {
                    r.chars().next().is_some_and(js_space)
                        && !r.trim_start_matches(js_space).is_empty()
                }) {
                    return true;
                }
            }
            if let Some(r) = rest.strip_prefix("eyj") {
                let first = r.bytes().take_while(|b| token(*b)).count();
                if first > 0 && r.as_bytes().get(first) == Some(&b'.') {
                    let r = &r[first + 1..];
                    let second = r.bytes().take_while(|b| token(*b)).count();
                    if second > 0
                        && r.as_bytes().get(second) == Some(&b'.')
                        && r[second + 1..].bytes().next().is_some_and(token)
                    {
                        return true;
                    }
                }
            }
            if rest.len() >= 64
                && rest.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
                && rest.as_bytes().get(64).is_none_or(|b| !word(*b))
            {
                return true;
            }
        }
        if i >= url_match_end && (rest.starts_with("http://") || rest.starts_with("https://")) {
            let url = s[i..]
                .split(|c| js_space(c) || matches!(c, '<' | '>' | '"' | '`'))
                .next()
                .unwrap();
            let scheme_length = if rest.starts_with("https://") { 8 } else { 7 };
            if url.len() == scheme_length {
                continue;
            }
            url_match_end = i + url.len();
            match reqwest::Url::parse(url) {
                Ok(u)
                    if u.username().is_empty()
                        && u.password().unwrap_or_default().is_empty()
                        && u.query().unwrap_or_default().is_empty()
                        && u.fragment().unwrap_or_default().is_empty() => {}
                _ => return true,
            }
        }
    }
    false
}

pub fn cmd(path: &std::path::Path) -> Result<()> {
    let text = crate::backup_reader::read(path)?;
    let result = inspect(&text)?;
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    Ok(())
}

/// Isolated entry before launcher settings, guard or Node resolution. The dashboard
/// has already resolved its locale/settings and passes only the selected language.
pub fn entry() -> Option<i32> {
    use clap::Parser;
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new("backup-inspect")) {
        return None;
    }
    #[derive(Parser)]
    #[command(
        name = "rdsh backup-inspect",
        about = "Inspect a history backup without Node or dashboard settings"
    )]
    struct Arguments {
        #[arg(long)]
        archive_file: std::path::PathBuf,
    }
    let arguments = match Arguments::try_parse_from(
        std::iter::once(std::ffi::OsString::from("backup-inspect"))
            .chain(std::env::args_os().skip(2)),
    ) {
        Ok(v) => v,
        Err(e) => {
            let code = e.exit_code();
            let _ = e.print();
            return Some(code);
        }
    };
    Some(match cmd(&arguments.archive_file) {
        Ok(()) => 0,
        Err(error) => {
            let detail = match crate::locale::current(None, "auto") {
                crate::locale::Locale::Japanese => format!("処理に失敗しました: {error}"),
                crate::locale::Locale::Chinese => format!("操作失败：{error}"),
                crate::locale::Locale::English => error.to_string(),
            };
            eprintln!("[rdsh-dashboard] {detail}");
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn published_archive_is_valid_and_has_exact_projection_order() {
        let result = inspect(include_str!("../docs/evidence/history-backup/archive.json")).unwrap();
        assert_eq!(
            result["integrity"]["digest"],
            "485d4e5a5e857d3d956de4ee0d157de5dd379c76f19de66478808cab19386497"
        );
        assert_eq!(
            result["counts"],
            json!({"tasks":1,"questions":1,"answers":1,"decisions":1,"evidence":1})
        );
        assert_eq!(
            result.as_object().unwrap().keys().next().unwrap(),
            "archive_id"
        );
    }
    #[test]
    fn javascript_text_and_url_boundaries() {
        assert!(!sensitive("https://example.org/?#"));
        for s in [
            "https://x/?q=y",
            "https://user@x/",
            "https://[invalid]/",
            "Bearer x",
            "secret: value",
            "const x = 1",
            "a sk_abcdef",
        ] {
            assert!(sensitive(s), "{s}");
        }
        assert!(!js_space('\u{85}'));
        assert!(js_space('\u{feff}'));
        assert!(time(Json(r#""0000-02-29T00:00:00.000Z""#)));
        assert!(!time(Json(r#""2025-02-29T00:00:00.000Z""#)));
    }
}
